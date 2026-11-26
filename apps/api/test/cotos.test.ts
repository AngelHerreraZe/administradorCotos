import type { PrismaClient } from '@admcotos/db';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';

const ISSUER = 'https://test.supabase.co/auth/v1';
const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const COTO_ID = '33333333-3333-4333-8333-333333333333';

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

const cotoBase = {
  id: COTO_ID,
  orgId: ORG_ID,
  nombre: 'Miraflores',
  slug: 'miraflores',
  zonaHoraria: 'America/Mexico_City',
  direccion: null,
  colonia: null,
  ciudad: null,
  estado: null,
  cp: null,
  tipo: 'coto',
  regimenLegal: null,
  diaCorte: 1,
  diaLimitePago: 10,
  tasaMoratoria: '2.50',
  tipoMoratoria: 'porcentaje',
  descuentoProntoPago: '0.00',
  diasGracia: 5,
  bloquearAmenidadesMorosos: true,
  mesesMorosidadBloqueo: 2,
  rfcCoto: null,
  razonSocialCoto: null,
  regimenFiscal: null,
  cpFiscal: null,
  activo: true,
};

describe('módulo de cotos', () => {
  test('GET y PATCH /cotos/{cotoId}: caso feliz, 422, 404 (otro coto) y 403 (otro rol)', async () => {
    const token = await firmarToken();
    const appOk = appConTx({
      coto: {
        findUnique: async () => cotoBase,
        update: async () => ({ ...cotoBase, diaLimitePago: 12 }),
      },
    });

    const getOk = await appOk.request(`/api/v1/cotos/${COTO_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(getOk.status).toBe(200);
    expect(await getOk.json()).toMatchObject({ id: COTO_ID, tasaMoratoria: '2.50' });

    const patchOk = await appOk.request(`/api/v1/cotos/${COTO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ diaLimitePago: 12 }),
    });
    expect(patchOk.status).toBe(200);

    const patch422 = await appOk.request(`/api/v1/cotos/${COTO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ diaLimitePago: 31 }),
    });
    expect(patch422.status).toBe(422);

    const appOtroCoto = appConTx({ coto: { findUnique: async () => null } });
    expect(
      (await appOtroCoto.request(`/api/v1/cotos/${COTO_ID}`, { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(404);

    const appOtroRol = appConTx({
      coto: {
        findUnique: async () => cotoBase,
        update: async () => {
          throw Object.assign(new Error('RLS'), { code: 'P2025' });
        },
      },
    });
    expect(
      (
        await appOtroRol.request(`/api/v1/cotos/${COTO_ID}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nombre: 'Nuevo' }),
        })
      ).status,
    ).toBe(403);
  });
});
