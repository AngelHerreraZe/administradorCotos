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
const SOPORTE_ID = '77777777-7777-4777-8777-777777777777';

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

async function firmarToken(aal: 'aal1' | 'aal2' = 'aal2') {
  return new SignJWT({ aal })
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

const orgBase = {
  id: ORG_ID,
  nombre: 'Despacho Alfa',
  slug: 'alfa',
  rfc: null,
  razonSocial: null,
  emailContacto: 'contacto@alfa.mx',
  telefono: null,
  customDomain: null,
  logoUrl: null,
  colorPrimario: '#1E40AF',
  colorSecundario: '#3B82F6',
  faviconUrl: null,
  tierMayoreo: 'tier_1',
  estadoSuscripcion: 'activo',
  exigirMfa: true,
  avisoPrivacidadUrl: null,
  avisoVersion: 1,
  activo: true,
};

describe('módulo de organizaciones', () => {
  test('GET y PATCH /orgs/{orgId}: caso feliz, 422 en billing/XSS, 403/404 sin permiso', async () => {
    const app = appConTx({
      organizacion: {
        findUnique: async () => orgBase,
        update: async () => ({ ...orgBase, colorPrimario: '#0F172A' }),
      },
    });
    const token = await firmarToken();

    expect(
      (await app.request(`/api/v1/orgs/${ORG_ID}`, { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(200);

    const patchBilling = await app.request(`/api/v1/orgs/${ORG_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletCreditos: '999999.00' }),
    });
    expect(patchBilling.status).toBe(422);

    const patchUrl = await app.request(`/api/v1/orgs/${ORG_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ logoUrl: 'http://inseguro.mx/logo.png' }),
    });
    expect(patchUrl.status).toBe(422);

    const patchOk = await app.request(`/api/v1/orgs/${ORG_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ colorPrimario: '#0F172A' }),
    });
    expect(patchOk.status).toBe(200);

    const appSinPermiso = appConTx({
      organizacion: {
        findUnique: async () => orgBase,
        update: async () => {
          throw Object.assign(new Error('No rows'), { code: 'P2025' });
        },
      },
    });
    expect(
      (
        await appSinPermiso.request(`/api/v1/orgs/${ORG_ID}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nombre: 'X' }),
        })
      ).status,
    ).toBe(403);
  });

  test('GET /orgs/{orgId}/cotos y POST /orgs/{orgId}/cotos', async () => {
    const app = appConTx({
      $queryRaw: async (strings: TemplateStringsArray) => {
        if (strings.join('').includes('orgs_lectura')) return [{ ok: true }];
        return [
          {
            coto_id: COTO_ID,
            coto: 'Miraflores',
            unidades: 10,
            emitido_mes: '10000.00',
            cobrado_mes: '8000.00',
            pct_cobrado: '80.0',
            adeudo_vencido: '2000.00',
            unidades_morosas: 2,
            pagos_por_revisar: 1,
            tickets_abiertos: 3,
          },
        ];
      },
      coto: {
        findMany: async () => [
          {
            id: COTO_ID,
            nombre: 'Miraflores',
            slug: 'miraflores',
            tipo: 'coto',
            zonaHoraria: 'America/Mexico_City',
            activo: true,
          },
        ],
        create: async () => ({
          id: COTO_ID,
          orgId: ORG_ID,
          nombre: 'Altavista',
          slug: 'altavista',
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
          tasaMoratoria: '0.00',
          tipoMoratoria: 'ninguno',
          descuentoProntoPago: '0.00',
          diasGracia: 0,
          bloquearAmenidadesMorosos: true,
          mesesMorosidadBloqueo: 2,
          rfcCoto: null,
          razonSocialCoto: null,
          regimenFiscal: null,
          cpFiscal: null,
          activo: true,
        }),
      },
    });
    const token = await firmarToken();

    const lista = await app.request(`/api/v1/orgs/${ORG_ID}/cotos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(lista.status).toBe(200);
    expect(await lista.json()).toMatchObject({
      datos: [{ cotoId: COTO_ID, unidades: 10, emitidoMes: '10000.00', cobradoMes: '8000.00' }],
    });

    const crear = await app.request(`/api/v1/orgs/${ORG_ID}/cotos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Altavista', slug: 'altavista' }),
    });
    expect(crear.status).toBe(201);
    expect(crear.headers.get('location')).toBe(`/api/v1/cotos/${COTO_ID}`);

    const slugMalo = await app.request(`/api/v1/orgs/${ORG_ID}/cotos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Altavista', slug: 'Slug Inválido!' }),
    });
    expect(slugMalo.status).toBe(422);
  });

  test('POST /orgs/{orgId}/soporte: máximo 72 horas (422) y creación (201)', async () => {
    const ahora = new Date('2026-11-26T16:00:00Z');
    const app = appConTx({
      soporteAcceso: {
        create: async () => ({
          id: SOPORTE_ID,
          orgId: ORG_ID,
          otorgadoPor: USER_ID,
          ticketRef: 'T-4092',
          desde: ahora,
          hasta: new Date(ahora.getTime() + 24 * 3_600_000),
        }),
      },
    });
    const token = await firmarToken();

    const exceso = await app.request(`/api/v1/orgs/${ORG_ID}/soporte`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketRef: 'T-4092', duracionHoras: 73 }),
    });
    expect(exceso.status).toBe(422);

    const ok = await app.request(`/api/v1/orgs/${ORG_ID}/soporte`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketRef: 'T-4092', duracionHoras: 24 }),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ id: SOPORTE_ID, ticketRef: 'T-4092' });
  });
});
