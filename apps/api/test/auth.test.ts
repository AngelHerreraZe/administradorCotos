import crypto from 'node:crypto';
import type { PrismaClient } from '@admcotos/db';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { beforeAll, describe, expect, test } from 'vitest';
import { autenticacion, autenticacionPreRegistro, crearResolvedorUsuario } from '../src/middleware/auth.ts';
import { manejarError } from '../src/middleware/errors.ts';
import type { AppEnv } from '../src/types.ts';

const ISSUER = 'https://auth.ejemplo.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';
const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

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

function crearApp(resolverUsuario = async (id: string) => (id === AUTH_ID ? USER_ID : null)) {
  const log = pino({ level: 'silent' });
  const app = new Hono<AppEnv>();
  app.onError(manejarError(log));
  app.use('/privado/*', autenticacion({ jwks, issuer: ISSUER, audience: AUDIENCE, resolverUsuario }));
  app.get('/privado/ok', (c) => c.json(c.get('auth')));
  app.use('/inv/*', autenticacionPreRegistro({ jwks, issuer: ISSUER, audience: AUDIENCE }));
  app.post('/inv/ok', (c) => c.json(c.get('authPre')));
  return app;
}

describe('middleware de autenticación (JWT ES256 + JWKS)', () => {
  test('acepta token ES256 válido con aal1/aal2', async () => {
    const app = crearApp();
    const jwt = await new SignJWT({ aal: 'aal2' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);

    const res = await app.request('/privado/ok', { headers: { Authorization: `Bearer ${jwt}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usuarioId: USER_ID, authId: AUTH_ID, aal: 'aal2' });
  });

  test('rechaza falta de header, token vencido, otra audiencia, alg: none, HS256 y sin sub', async () => {
    const app = crearApp();

    expect((await app.request('/privado/ok')).status).toBe(401);

    const vencido = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    expect((await app.request('/privado/ok', { headers: { Authorization: `Bearer ${vencido}` } })).status).toBe(401);

    const otraAud = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('otra-audiencia')
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await app.request('/privado/ok', { headers: { Authorization: `Bearer ${otraAud}` } })).status).toBe(401);

    const sinSub = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await app.request('/privado/ok', { headers: { Authorization: `Bearer ${sinSub}` } })).status).toBe(401);

    const algNoneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const algNonePayload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: AUTH_ID, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    expect(
      (await app.request('/privado/ok', { headers: { Authorization: `Bearer ${algNoneHeader}.${algNonePayload}.` } }))
        .status,
    ).toBe(401);

    const hsSecret = crypto.randomBytes(32);
    const hs256 = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(hsSecret);
    expect((await app.request('/privado/ok', { headers: { Authorization: `Bearer ${hs256}` } })).status).toBe(401);
  });

  test('rechaza con 403 si el usuario aún no tiene cuenta en BD', async () => {
    const app = crearApp(async () => null);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);

    const res = await app.request('/privado/ok', { headers: { Authorization: `Bearer ${jwt}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'sin_cuenta' });
  });

  test('caché de resolvedor expira por TTL (60s) para reflejar desactivación de usuarios', async () => {
    let llamadas = 0;
    let activo = true;
    let reloj = 1_000_000;
    const prisma = {
      $queryRaw: async () => {
        llamadas += 1;
        return [{ id: activo ? USER_ID : null }];
      },
    } as unknown as PrismaClient;

    const resolver = crearResolvedorUsuario(prisma, { ttlMs: 60_000, ahora: () => reloj });
    expect(await resolver(AUTH_ID)).toBe(USER_ID);
    reloj += 30_000;
    expect(await resolver(AUTH_ID)).toBe(USER_ID);
    expect(llamadas).toBe(1);

    activo = false;
    reloj += 35_000;
    expect(await resolver(AUTH_ID)).toBeNull();
    expect(llamadas).toBe(2);
  });

  test('pre-registro ignora user_metadata, rechaza anónimos/email_verified=false y acepta email top-level', async () => {
    const app = crearApp();

    // Solo user_metadata.email_verified = true con email_verified: false -> rechazado
    const soloUserMeta = await new SignJWT({
      email: 'a@b.mx',
      email_verified: false,
      user_metadata: { email_verified: true },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(
      (await app.request('/inv/ok', { method: 'POST', headers: { Authorization: `Bearer ${soloUserMeta}` } })).status,
    ).toBe(403);

    // Solo user_metadata sin claim email top-level -> rechazado
    const sinEmailTop = await new SignJWT({ user_metadata: { email: 'a@b.mx', email_verified: true } })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(
      (await app.request('/inv/ok', { method: 'POST', headers: { Authorization: `Bearer ${sinEmailTop}` } })).status,
    ).toBe(403);

    // Sesión anónima aunque manipule user_metadata -> rechazada
    const anon = await new SignJWT({
      email: 'a@b.mx',
      is_anonymous: true,
      user_metadata: { email_verified: true },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(
      (await app.request('/inv/ok', { method: 'POST', headers: { Authorization: `Bearer ${anon}` } })).status,
    ).toBe(403);

    // JWT emitido por Supabase Auth con Confirm email activo (claim email top-level) -> aceptado
    const confirmado = await new SignJWT({ email: 'a@b.mx' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    const ok = await app.request('/inv/ok', { method: 'POST', headers: { Authorization: `Bearer ${confirmado}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authId: AUTH_ID, aal: 'aal1', email: 'a@b.mx' });
  });
});
