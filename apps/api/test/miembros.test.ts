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
const UNIDAD_ID = '55555555-5555-4555-8555-555555555555';
const MIEMBRO_ID = '99999999-9999-4999-8999-999999999999';

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

describe('módulo de miembros', () => {
  test('GET y PATCH /cotos/{cotoId}/miembros: feliz, desactivación sin 500, minimización LFPDPPP, 422, 403', async () => {
    const token = await firmarToken();
    const mBase = {
      id: MIEMBRO_ID,
      cotoId: COTO_ID,
      unidadId: UNIDAD_ID,
      usuarioId: USER_ID,
      rol: 'residente_propietario',
      activo: true,
      unidad: { numero: '101' },
      usuario: {
        nombre: 'Juan',
        apellidoPaterno: 'Pérez',
        apellidoMaterno: null,
        email: 'juan@alfa.mx',
        telefono: '3312345678',
      },
    };

    const app = appConTx({
      $queryRaw: async () => [{ staff: true, contacto: true }],
      miembroCoto: {
        findMany: async ({ where }: { where: { activo?: boolean } }) => {
          expect(where.activo).toBe(true);
          return [mBase];
        },
        findFirst: async () => ({ id: MIEMBRO_ID, rol: 'residente_propietario', unidadId: UNIDAD_ID }),
        update: async ({ data }: { data: { activo?: boolean; rol?: string } }) => ({
          id: MIEMBRO_ID,
          cotoId: COTO_ID,
          unidadId: UNIDAD_ID,
          usuarioId: USER_ID,
          rol: data.rol ?? 'residente_propietario',
          activo: data.activo ?? true,
          unidad: { numero: '101' },
        }),
      },
      usuario: { findUnique: async () => mBase.usuario },
    });

    const getOk = await app.request(`/api/v1/cotos/${COTO_ID}/miembros`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getOk.status).toBe(200);
    expect(await getOk.json()).toMatchObject({
      datos: [{ id: MIEMBRO_ID, unidadNumero: '101', email: 'juan@alfa.mx' }],
    });

    const patchSinUnidad = await app.request(`/api/v1/cotos/${COTO_ID}/miembros/${MIEMBRO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rol: 'residente_inquilino', unidadId: null }),
    });
    expect(patchSinUnidad.status).toBe(422);

    const patchDesactivar = await app.request(`/api/v1/cotos/${COTO_ID}/miembros/${MIEMBRO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activo: false }),
    });
    expect(patchDesactivar.status).toBe(200);
    expect(await patchDesactivar.json()).toMatchObject({ id: MIEMBRO_ID, activo: false, email: null, nombre: null });

    // Comité no recibe email ni teléfono (LFPDPPP)
    const appComite = appConTx({
      $queryRaw: async () => [{ staff: true, contacto: false }],
      miembroCoto: {
        findMany: async ({ select }: { select: { usuario: { select: Record<string, boolean> } } }) => {
          expect(select.usuario.select.email).toBeUndefined();
          expect(select.usuario.select.telefono).toBeUndefined();
          return [
            {
              ...mBase,
              usuario: { nombre: 'Juan', apellidoPaterno: 'Pérez', apellidoMaterno: null },
            },
          ];
        },
      },
    });
    const resComite = await appComite.request(`/api/v1/cotos/${COTO_ID}/miembros`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resComite.status).toBe(200);
    expect(await resComite.json()).toMatchObject({
      datos: [{ id: MIEMBRO_ID, nombre: 'Juan', email: null, telefono: null }],
    });

    const appSinPermiso = appConTx({ $queryRaw: async () => [{ staff: false, contacto: false }] });
    expect(
      (
        await appSinPermiso.request(`/api/v1/cotos/${COTO_ID}/miembros`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });
});
