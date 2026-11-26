import type { PrismaClient } from '@admcotos/db';
import type { PayloadCorreo } from '@admcotos/shared';
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
const UNIDAD_ID = '55555555-5555-4555-8555-555555555555';
const INV_ID = '66666666-6666-4666-8666-666666666666';
const IDEM_KEY = '77777777-7777-4777-8777-777777777777';

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

async function firmarToken(extra: Record<string, unknown> = { aal: 'aal2' }) {
  return new SignJWT(extra)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(AUTH_ID)
    .setExpirationTime('5m')
    .sign(privateKey);
}

function crearApp(tx: Record<string, unknown>, encolados: PayloadCorreo[] = []) {
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
    encolarCorreo: async (p) => {
      encolados.push(p);
    },
  });
}

describe('módulo de invitaciones', () => {
  test('POST /cotos/{cotoId}/invitaciones usa fragmento #token= y respeta Idempotency-Key (200 sin reenviar correo)', async () => {
    const encolados: PayloadCorreo[] = [];
    const ahora = new Date('2026-11-26T16:00:00Z');
    const guardadas = new Map<string, Record<string, unknown>>();

    const app = crearApp(
      {
        $queryRaw: async () => [{ ok: true }],
        coto: { findUnique: async () => ({ id: COTO_ID, orgId: ORG_ID, nombre: 'Miraflores', activo: true }) },
        invitacionMiembro: {
          create: async ({
            data,
          }: {
            data: { email: string; rol: string; unidadId: string | null; claveIdempotencia?: string };
          }) => {
            if (data.claveIdempotencia && guardadas.has(data.claveIdempotencia)) {
              throw Object.assign(new Error('Unique violation'), { code: 'P2002' });
            }
            const fila = {
              id: INV_ID,
              orgId: ORG_ID,
              cotoId: COTO_ID,
              unidadId: data.unidadId,
              email: data.email,
              rol: data.rol,
              expiraEn: new Date(ahora.getTime() + 7 * 86_400_000 - 60_000),
              aceptadaEn: null,
              revocadaEn: null,
              createdAt: ahora,
            };
            if (data.claveIdempotencia) guardadas.set(data.claveIdempotencia, fila);
            return fila;
          },
          findFirst: async ({ where }: { where: { claveIdempotencia?: string } }) =>
            where.claveIdempotencia ? (guardadas.get(where.claveIdempotencia) ?? null) : null,
        },
      },
      encolados,
    );

    const token = await firmarToken();
    const res1 = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': IDEM_KEY },
      body: JSON.stringify({ email: 'vecino@alfa.mx', rol: 'residente_propietario', unidadId: UNIDAD_ID }),
    });
    expect(res1.status).toBe(201);
    expect(res1.headers.get('location')).toBe(`/api/v1/invitaciones/${INV_ID}`);
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1).not.toHaveProperty('tokenHash');
    expect(body1).not.toHaveProperty('token');
    expect(encolados).toHaveLength(1);
    expect(encolados[0]?.datos.url).toContain('/invitaciones/aceptar#token=');

    const res2 = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': IDEM_KEY },
      body: JSON.stringify({ email: 'vecino@alfa.mx', rol: 'residente_propietario', unidadId: UNIDAD_ID }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual(body1);
    expect(encolados).toHaveLength(1);

    const badIdem = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'no-uuid' },
      body: JSON.stringify({ email: 'vecino@alfa.mx', rol: 'residente_propietario', unidadId: UNIDAD_ID }),
    });
    expect(badIdem.status).toBe(422);
  });

  test('POST /cotos/{cotoId}/invitaciones rechaza residente sin unidadId y roles de org (422) y sin permiso (403)', async () => {
    const app = crearApp({ $queryRaw: async () => [{ ok: false }] });
    const token = await firmarToken();

    const sinUnidad = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'vecino@alfa.mx', rol: 'residente_propietario' }),
    });
    expect(sinUnidad.status).toBe(422);

    const rolOrg = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@alfa.mx', rol: 'org_owner' }),
    });
    expect(rolOrg.status).toBe(422);

    const sinPermiso = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'guardia@alfa.mx', rol: 'guardia' }),
    });
    expect(sinPermiso.status).toBe(403);
  });

  test('GET /cotos/{cotoId}/invitaciones y POST /invitaciones/{id}/revocar (idempotente)', async () => {
    const ahora = new Date('2026-11-26T16:00:00Z');
    const baseInv = {
      id: INV_ID,
      orgId: ORG_ID,
      cotoId: COTO_ID,
      unidadId: null,
      email: 'guardia@alfa.mx',
      rol: 'guardia',
      expiraEn: ahora,
      aceptadaEn: null,
      revocadaEn: null,
      createdAt: ahora,
    };
    let revocada = false;
    const app = crearApp({
      $queryRaw: async () => [{ ok: true }],
      invitacionMiembro: {
        findMany: async () => [baseInv],
        findUnique: async () => ({ ...baseInv, revocadaEn: revocada ? ahora : null }),
        update: async () => {
          revocada = true;
          return { ...baseInv, revocadaEn: ahora };
        },
      },
    });
    const token = await firmarToken();

    const lista = await app.request(`/api/v1/cotos/${COTO_ID}/invitaciones`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(lista.status).toBe(200);
    expect(((await lista.json()) as { datos: unknown[] }).datos).toHaveLength(1);

    const rev1 = await app.request(`/api/v1/invitaciones/${INV_ID}/revocar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rev1.status).toBe(200);

    const rev2 = await app.request(`/api/v1/invitaciones/${INV_ID}/revocar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rev2.status).toBe(200);
  });

  test('POST /invitaciones/aceptar rechaza JWT con solo user_metadata.email_verified y acepta email confirmado', async () => {
    const prisma = {
      $queryRaw: async () => [{ id: null }],
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ usuario_id: USER_ID }],
        }),
    } as unknown as PrismaClient;

    const app = createApp({
      env,
      prisma,
      log: pino({ level: 'silent' }),
      jwks,
      limitador: { async consumir() {} },
      encolarCorreo: async () => {},
    });

    const tokenSoloMeta = await firmarToken({
      email: 'nuevo@alfa.mx',
      email_verified: false,
      user_metadata: { email_verified: true },
    });
    const r403 = await app.request('/api/v1/invitaciones/aceptar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSoloMeta}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(32), nombre: 'Luis', apellidoPaterno: 'Díaz' }),
    });
    expect(r403.status).toBe(403);

    const tokenOk = await firmarToken({ email: 'nuevo@alfa.mx' });
    const r200 = await app.request('/api/v1/invitaciones/aceptar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(32), nombre: 'Luis', apellidoPaterno: 'Díaz' }),
    });
    expect(r200.status).toBe(200);
    expect(await r200.json()).toEqual({ usuarioId: USER_ID });
  });
});
