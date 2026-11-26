import type { PrismaClient } from '@admcotos/db';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';

const ISSUER = 'https://test.supabase.co/auth/v1';
const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const COTO_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';

process.env.DB_CTX_SECRET ??= 'ab'.repeat(32);

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_service:x@localhost:5432/test',
  DB_CTX_SECRET: 'ab'.repeat(32),
  SUPABASE_URL: 'https://test.supabase.co',
  REDIS_URL: 'redis://localhost:6379',
});

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function firmarToken(aal: 'aal1' | 'aal2' = 'aal1') {
  return new SignJWT({ aal })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(AUTH_ID)
    .setExpirationTime('5m')
    .sign(privateKey);
}

function appConTx(tx: Record<string, unknown>, sinCuenta = false) {
  const prisma = {
    $queryRaw: async () => [{ id: sinCuenta ? null : USER_ID }],
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({ $executeRaw: async () => 1, ...tx }),
  } as unknown as PrismaClient;

  return createApp({
    env,
    prisma,
    log: pino({ level: 'silent' }),
    jwks,
    limitador: { async consumir() {} },
    encolarCorreo: async () => {},
  });
}

describe('/api/v1/me', () => {
  test('GET /me devuelve perfil y membresías del usuario autenticado', async () => {
    const usuarioBase = {
      id: USER_ID,
      nombre: 'Ana',
      apellidoPaterno: 'López',
      apellidoMaterno: null,
      email: 'ana@alfa.mx',
      telefono: null,
      telefonoVerificado: false,
      mfaActivo: false,
      aceptoAvisoPrivacidad: false,
      fechaAceptacionAviso: null,
      versionAvisoAceptado: null,
    };
    const app = appConTx({
      $queryRaw: async () => [
        {
          coto_id: COTO_ID,
          coto: 'Miraflores',
          org_id: ORG_ID,
          rol: 'residente_propietario',
          unidad_id: null,
          unidad: null,
        },
      ],
      usuario: { findUnique: async () => usuarioBase },
      orgMiembro: { findMany: async () => [] },
    });

    const token = await firmarToken();
    const res = await app.request('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: USER_ID,
      nombre: 'Ana',
      membresias: [{ cotoId: COTO_ID, coto: 'Miraflores', rol: 'residente_propietario' }],
    });
  });

  test('GET /me sin token (401), sin cuenta (403) y X-Coto-Id inválido (422)', async () => {
    const app = appConTx({});
    expect((await app.request('/api/v1/me')).status).toBe(401);

    const token = await firmarToken();
    expect(
      (await appConTx({}, true).request('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(403);

    const res422 = await app.request('/api/v1/me', {
      headers: { Authorization: `Bearer ${token}`, 'X-Coto-Id': 'no-es-uuid' },
    });
    expect(res422.status).toBe(422);
  });

  test('PATCH /me rechaza campos protegidos como email (422) y actualiza permitidos (200)', async () => {
    const actualizado = {
      id: USER_ID,
      nombre: 'Ana María',
      apellidoPaterno: 'López',
      apellidoMaterno: null,
      email: 'ana@alfa.mx',
      telefono: '3312345678',
      telefonoVerificado: false,
      mfaActivo: false,
      aceptoAvisoPrivacidad: true,
      fechaAceptacionAviso: new Date('2026-11-26T12:00:00Z'),
      versionAvisoAceptado: 2,
    };
    const app = appConTx({
      $queryRaw: async () => [],
      usuario: {
        update: async () => actualizado,
        findUnique: async () => actualizado,
      },
      orgMiembro: { findMany: async () => [] },
    });
    const token = await firmarToken();

    const invalido = await app.request('/api/v1/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hack@alfa.mx' }),
    });
    expect(invalido.status).toBe(422);

    const ok = await app.request('/api/v1/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Ana María',
        telefono: '3312345678',
        aceptoAvisoPrivacidad: true,
        versionAvisoAceptado: 2,
      }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ nombre: 'Ana María', telefono: '3312345678', aceptoAvisoPrivacidad: true });
  });
});
