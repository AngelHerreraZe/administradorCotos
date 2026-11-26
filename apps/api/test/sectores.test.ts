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
const SECTOR_ID = '88888888-8888-4888-8888-888888888888';

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

async function firmarToken() {
  return new SignJWT({ aal: 'aal2' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(AUTH_ID)
    .setExpirationTime('5m')
    .sign(privateKey);
}

function appConTx(tx: Record<string, unknown>) {
  const prisma = {
    $queryRaw: async () => [{ id: USER_ID }],
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

describe('módulo de sectores', () => {
  test('GET, POST y PATCH /cotos/{cotoId}/sectores: feliz, 422, 403/404', async () => {
    const token = await firmarToken();
    const sectorBase = { id: SECTOR_ID, cotoId: COTO_ID, nombre: 'Torre A', tipo: 'torre', orden: 1, activo: true };

    const app = appConTx({
      $queryRaw: async () => [{ ok: true }],
      sector: {
        findMany: async () => [sectorBase],
        create: async () => sectorBase,
        findFirst: async () => sectorBase,
        update: async () => ({ ...sectorBase, nombre: 'Torre B' }),
      },
    });

    const getOk = await app.request(`/api/v1/cotos/${COTO_ID}/sectores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getOk.status).toBe(200);

    const postOk = await app.request(`/api/v1/cotos/${COTO_ID}/sectores`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Torre A', tipo: 'torre', orden: 1 }),
    });
    expect(postOk.status).toBe(201);
    expect(postOk.headers.get('location')).toBe(`/api/v1/cotos/${COTO_ID}/sectores/${SECTOR_ID}`);

    const post422 = await app.request(`/api/v1/cotos/${COTO_ID}/sectores`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: '' }),
    });
    expect(post422.status).toBe(422);

    const patchOk = await app.request(`/api/v1/cotos/${COTO_ID}/sectores/${SECTOR_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Torre B' }),
    });
    expect(patchOk.status).toBe(200);

    const appSinPermiso = appConTx({ $queryRaw: async () => [{ ok: false }] });
    expect(
      (
        await appSinPermiso.request(`/api/v1/cotos/${COTO_ID}/sectores`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });
});
