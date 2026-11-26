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
const UNIDAD_ID = '55555555-5555-4555-8555-555555555555';

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

describe('módulo de unidades e importación CSV', () => {
  test('CRUD /cotos/{cotoId}/unidades: feliz, 422, 403/404', async () => {
    const token = await firmarToken();
    const uBase = {
      id: UNIDAD_ID,
      cotoId: COTO_ID,
      sectorId: null,
      numero: '101',
      tipo: 'casa',
      superficieM2: '120.50',
      indiviso: '0.25',
      ocupada: true,
      activo: true,
    };

    const app = appConTx({
      $queryRaw: async () => [{ ok: true }],
      unidad: {
        create: async () => uBase,
        findMany: async () => [uBase],
        findFirst: async () => uBase,
        update: async () => ({ ...uBase, ocupada: false }),
      },
    });

    const postOk = await app.request(`/api/v1/cotos/${COTO_ID}/unidades`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: '101', indiviso: '0.25', superficieM2: '120.50' }),
    });
    expect(postOk.status).toBe(201);
    expect(postOk.headers.get('location')).toBe(`/api/v1/cotos/${COTO_ID}/unidades/${UNIDAD_ID}`);

    const post422 = await app.request(`/api/v1/cotos/${COTO_ID}/unidades`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: '101', indiviso: '0' }),
    });
    expect(post422.status).toBe(422);

    const getOk = await app.request(`/api/v1/cotos/${COTO_ID}/unidades`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getOk.status).toBe(200);

    const patchOk = await app.request(`/api/v1/cotos/${COTO_ID}/unidades/${UNIDAD_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ocupada: false }),
    });
    expect(patchOk.status).toBe(200);

    const appSinPermiso = appConTx({ $queryRaw: async () => [{ ok: false }] });
    expect(
      (
        await appSinPermiso.request(`/api/v1/cotos/${COTO_ID}/unidades`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });

  test('POST /unidades/importar valida todo antes de insertar y reporta errores por fila', async () => {
    const token = await firmarToken();
    let insertadas: unknown[] = [];
    const app = appConTx({
      $queryRaw: async () => [{ ok: true }],
      sector: { findMany: async () => [{ id: SECTOR_ID, nombre: 'Torre A' }] },
      unidad: {
        findMany: async () => [{ numero: 'EXISTENTE' }],
        createMany: async ({ data }: { data: unknown[] }) => {
          insertadas = data;
          return { count: data.length };
        },
      },
    });

    const csvInvalido = [
      'numero,tipo,sector,indiviso,ocupada',
      'EXISTENTE,casa,Torre A,0.5,true',
      '202,nave_espacial,NoExiste,0,si',
    ].join('\n');

    const res422 = await app.request(`/api/v1/cotos/${COTO_ID}/unidades/importar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
      body: csvInvalido,
    });
    expect(res422.status).toBe(422);
    expect(insertadas).toHaveLength(0);
    const body422 = (await res422.json()) as { code: string; errors: { path: string; message: string }[] };
    expect(body422.code).toBe('csv_con_errores');
    expect(body422.errors.length).toBeGreaterThanOrEqual(3);

    const csvValido = [
      'numero,tipo,sector,indiviso,ocupada',
      '301,departamento,Torre A,0.25,true',
      '302,casa,,0.25,no',
    ].join('\n');
    const res201 = await app.request(`/api/v1/cotos/${COTO_ID}/unidades/importar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
      body: csvValido,
    });
    expect(res201.status).toBe(201);
    expect(await res201.json()).toEqual({ creadas: 2 });
    expect(insertadas).toHaveLength(2);
  });

  test('POST /unidades/importar rechaza más de 5 000 filas', async () => {
    const token = await firmarToken();
    const app = appConTx({
      $queryRaw: async () => [{ ok: true }],
      sector: { findMany: async () => [] },
      unidad: { findMany: async () => [] },
    });

    const filas = ['numero'];
    for (let i = 1; i <= 5_001; i++) filas.push(`U-${i}`);

    const res = await app.request(`/api/v1/cotos/${COTO_ID}/unidades/importar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
      body: filas.join('\n'),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'demasiadas_filas' });
  });
});
