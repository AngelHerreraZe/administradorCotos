import crypto from 'node:crypto';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { beforeAll, describe, expect, test } from 'vitest';
import { autenticacion, autenticacionPreRegistro } from '../src/middleware/auth.ts';
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

  test('pre-registro exige correo verificado', async () => {
    const app = crearApp();
    const sinVerificar = await new SignJWT({ email: 'a@b.mx', email_verified: false })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(
      (await app.request('/inv/ok', { method: 'POST', headers: { Authorization: `Bearer ${sinVerificar}` } })).status,
    ).toBe(403);

    const verificado = await new SignJWT({ email: 'a@b.mx', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(AUTH_ID)
      .setExpirationTime('5m')
      .sign(privateKey);
    const ok = await app.request('/inv/ok', { method: 'POST', headers: { Authorization: `Bearer ${verificado}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authId: AUTH_ID, aal: 'aal1', email: 'a@b.mx' });
  });
});
