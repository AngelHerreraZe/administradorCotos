import type { PrismaClient } from '@admcotos/db';
import { createLocalJWKSet } from 'jose';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_service:x@localhost:5432/test',
  DB_CTX_SECRET: 'ab'.repeat(32),
  SUPABASE_URL: 'https://test.supabase.co',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'https://app.admcotos.mx',
});
const log = pino({ level: 'silent' });
const jwks = createLocalJWKSet({ keys: [] });
const limitador = { async consumir() {} };
const encolarCorreo = async () => {};

function appCon(queryRaw: () => Promise<unknown>, overrides: Partial<typeof env> = {}) {
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
  return createApp({ env: { ...env, ...overrides }, prisma, log, jwks, limitador, encolarCorreo });
}
const app = appCon(async () => [{ ok: 1 }]);

describe('cabeceras de seguridad (modern-web-guidance › security)', () => {
  test('toda respuesta trae HSTS, CSP cerrada, nosniff, CORP y no-store', async () => {
    const res = await app.request('/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    const h = res.headers;
    expect(h.get('strict-transport-security')).toContain('max-age=31536000');
    expect(h.get('content-security-policy')).toContain("default-src 'none'");
    expect(h.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(h.get('cache-control')).toBe('no-store');
    expect(h.get('x-request-id')).toMatch(/^[\w-]+$/);
  });

  test('un X-Request-Id con caracteres peligrosos se reemplaza', async () => {
    const res = await app.request('/health/live', { headers: { 'X-Request-Id': 'a b<script>' } });
    expect(res.headers.get('x-request-id')).not.toContain('<');
  });
});

describe('CORS', () => {
  const preflight = (origin: string) =>
    app.request('/health/live', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });

  test('origen permitido recibe su propio origen, nunca *', async () => {
    const res = await preflight('https://app.admcotos.mx');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.admcotos.mx');
  });

  test('origen desconocido no recibe Access-Control-Allow-Origin', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('/webhooks queda fuera de CORS incluso con origen permitido', async () => {
    const res = await app.request('/webhooks/conekta', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.admcotos.mx', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('errores como Problem Details (RFC 9457)', () => {
  test('ruta inexistente', async () => {
    const res = await app.request('/no-existe');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { code: string; requestId: string };
    expect(body.code).toBe('ruta_no_encontrada');
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
  });

  test('SQLSTATE de Postgres se traduce sin filtrar detalles internos', async () => {
    const errorPg = Object.assign(new Error('Raw query failed'), {
      meta: {
        driverAdapterError: {
          cause: { originalCode: '57014', originalMessage: 'canceling statement due to statement timeout' },
        },
      },
    });
    const res = await appCon(() => Promise.reject(errorPg)).request('/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; detail?: string };
    expect(body.code).toBe('tiempo_agotado');
    expect(JSON.stringify(body)).not.toContain('statement');
  });

  test('error de negocio UA409 desde SQL: su estado y su mensaje para el usuario', async () => {
    const errorPg = Object.assign(new Error('Raw query failed'), {
      meta: { driverAdapterError: { cause: { originalCode: 'UA409', originalMessage: 'Esta unidad ya votó' } } },
    });
    const res = await appCon(() => Promise.reject(errorPg)).request('/health/ready');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'bd.ua409', title: 'Esta unidad ya votó' });
  });

  test('error inesperado → 500 genérico, sin stack', async () => {
    const res = await appCon(() => Promise.reject(new Error('secreto interno'))).request('/health/ready');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secreto');
  });

  test('cuerpo mayor a 1 MB → 413', async () => {
    const res = await app.request('/health/live', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });
});

describe('documentación OpenAPI', () => {
  test('apagada por defecto', async () => {
    expect((await app.request('/openapi.json')).status).toBe(404);
  });

  test('encendida con API_DOCS incluye rutas de Fase 1', async () => {
    const res = await appCon(async () => [], { API_DOCS: true }).request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/health/ready');
    expect(doc.paths).toHaveProperty('/api/v1/me');
    expect(doc.paths).toHaveProperty('/api/v1/invitaciones/aceptar');
    expect(doc.paths).toHaveProperty('/api/v1/orgs/{orgId}');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/unidades');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/unidades/importar');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/miembros');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/conceptos');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/cargos/generar');
    expect(doc.paths).toHaveProperty('/api/v1/unidades/{id}/estado-cuenta.pdf');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/pagos/online');
    expect(doc.paths).toHaveProperty('/api/v1/unidades/{id}/autopay');
    expect(doc.paths).toHaveProperty('/api/v1/cotos/{cotoId}/facturacion/timbrar/{pagoId}');
    expect(doc.paths).toHaveProperty('/api/v1/orgs/{id}/billing/portal');
  });
});
