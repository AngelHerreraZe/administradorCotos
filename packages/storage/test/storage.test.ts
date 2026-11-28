import crypto from 'node:crypto';
import { AppError } from '@admcotos/shared';
import { describe, expect, test } from 'vitest';
import {
  crearClienteS3,
  llaveParaArchivo,
  MAX_BYTES_ARCHIVO,
  TIPOS_ARCHIVO_PERMITIDOS,
  urlDeDescarga,
  urlDeSubida,
} from '../src/index.ts';

const ORG_ID = '44444444-4444-4444-8444-444444444444';
const COTO_ID = '33333333-3333-4333-8333-333333333333';

describe('@admcotos/storage', () => {
  const s3 = crearClienteS3({
    endpoint: 'https://storage.ejemplo.local',
    region: 'us-east-1',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  });

  test('llaveParaArchivo usa org/coto/categoria/uuid.ext y rechaza UUID inválidos', () => {
    const llave = llaveParaArchivo(ORG_ID, COTO_ID, 'comprobantes', 'image/png');
    expect(llave).toMatch(
      new RegExp(
        `^${ORG_ID}/${COTO_ID}/comprobantes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$`,
      ),
    );

    expect(() => llaveParaArchivo('no-uuid', COTO_ID, 'comprobantes', 'image/png')).toThrow(AppError);
  });

  test('urlDeSubida genera POST prefirmado con restricciones MIME y límite de tamaño', async () => {
    const llave = llaveParaArchivo(ORG_ID, COTO_ID, 'comprobantes', 'application/pdf');
    const post = await urlDeSubida(s3, 'cotos-privado', llave, ['application/pdf'], MAX_BYTES_ARCHIVO, 300);

    expect(post.url).toBe('https://storage.ejemplo.local/cotos-privado');
    expect(post.fields.key).toBe(llave);
    expect(post.fields['Content-Type']).toBe('application/pdf');
    expect(post.fields.Policy).toBeTypeOf('string');
    const politica = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    expect(politica.conditions).toContainEqual(['content-length-range', 1, MAX_BYTES_ARCHIVO]);
    expect(politica.conditions).toContainEqual(['eq', '$Content-Type', 'application/pdf']);

    await expect(urlDeSubida(s3, 'cotos-privado', llave, ['text/html'], 1024)).rejects.toThrow(AppError);
    await expect(urlDeSubida(s3, 'cotos-privado', '../hack.pdf', TIPOS_ARCHIVO_PERMITIDOS)).rejects.toThrow(AppError);
  });

  test('urlDeDescarga firma URL temporal con caducidad corta de 120 s y nombre seguro', async () => {
    const llave = `${ORG_ID}/${COTO_ID}/comprobantes/${crypto.randomUUID()}.webp`;
    const url = await urlDeDescarga(s3, 'cotos-privado', llave, 120, { nombreDescarga: 'comprobante-101.webp' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('response-content-disposition')).toBe('attachment; filename="comprobante-101.webp"');

    await expect(urlDeDescarga(s3, 'cotos-privado', '/abs/path')).rejects.toThrow(AppError);
  });
});
