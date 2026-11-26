import type { PrismaClient } from '@admcotos/db';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';
import { crearRecursosRedis } from '../src/lib/redis.ts';
import { manejarError } from '../src/middleware/errors.ts';
import {
  crearLimitadorTasa,
  limiteTasaEstricto,
  limiteTasaPorIp,
  type RedisRateClient,
} from '../src/middleware/rate-limit.ts';
import type { AppEnv } from '../src/types.ts';

class RedisFalso implements RedisRateClient {
  private contadores = new Map<string, { n: number; expira: number }>();
  fallar = false;
  [key: string]: unknown;

  defineCommand(nombre: string) {
    this[nombre] = async (args: string[]) => {
      if (this.fallar) throw new Error('Redis desconectado');
      const [clave, puntosStr, segStr] = args;
      if (!clave) throw new Error('falta clave');
      const puntos = Number(puntosStr ?? '1');
      const seg = Number(segStr ?? '60');
      const ahora = Date.now();
      const actual = this.contadores.get(clave);
      if (!actual || actual.expira <= ahora) {
        const expira = ahora + seg * 1000;
        this.contadores.set(clave, { n: puntos, expira });
        return [puntos, seg * 1000];
      }
      actual.n += puntos;
      return [actual.n, Math.max(1, actual.expira - ahora)];
    };
  }
}

describe('rate limit (RateLimiterRedis con Redis mínimo y fallo rápido)', () => {
  test('devuelve 429 con Retry-After cuando excede el límite estricto', async () => {
    const redis = new RedisFalso();
    const limitador = crearLimitadorTasa(redis);
    const app = new Hono<AppEnv>();
    const log = pino({ level: 'silent' });
    app.onError(manejarError(log));
    app.use('*', async (c, next) => {
      c.set('log', log);
      c.set('auth', { usuarioId: 'u-1', authId: 'a-1', aal: 'aal2' });
      await next();
    });
    app.post('/inv', limiteTasaEstricto(limitador, { prefijo: 'rl:inv', puntos: 2, duracionSegundos: 3600 }), (c) =>
      c.json({ ok: true }),
    );

    expect((await app.request('/inv', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/inv', { method: 'POST' })).status).toBe(200);
    const tercero = await app.request('/inv', { method: 'POST' });
    expect(tercero.status).toBe(429);
    expect(Number(tercero.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await tercero.json()).toMatchObject({ code: 'demasiadas_peticiones' });
  });

  test('con Redis inalcanzable real (sin puerto escuchando), general pasa y crítico da 503 en <= 1 s', async () => {
    const log = pino({ level: 'silent' });
    const recursos = crearRecursosRedis('redis://127.0.0.1:59999', log, 300);
    try {
      const app = new Hono<AppEnv>();
      app.onError(manejarError(log));
      app.use('*', async (c, next) => {
        c.set('log', log);
        await next();
      });
      app.get('/general', limiteTasaPorIp(recursos.limitador), (c) => c.json({ ok: true }));
      app.post('/critico', limiteTasaPorIp(recursos.limitador, { falloCerrado: true }), (c) => c.json({ ok: true }));

      const inicio = Date.now();
      expect((await app.request('/general')).status).toBe(200);
      expect((await app.request('/critico', { method: 'POST' })).status).toBe(503);
      await expect(
        recursos.encolarCorreo({ plantilla: 'aviso', para: 'a@b.mx', datos: { titulo: 't', mensaje: 'm' } }),
      ).rejects.toThrow(/disponible/);
      expect(Date.now() - inicio).toBeLessThan(1_000);
    } finally {
      await recursos.cerrar();
    }
  });

  test('el límite por IP frena antes de consultar usuario_por_auth en BD (M11)', async () => {
    const pair = await generateKeyPair('ES256');
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = 'k1';
    jwk.alg = 'ES256';
    jwk.use = 'sig';
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('https://test.supabase.co/auth/v1')
      .setAudience('authenticated')
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setExpirationTime('5m')
      .sign(pair.privateKey);

    let consultasBd = 0;
    const prisma = {
      $queryRaw: async () => {
        consultasBd += 1;
        return [{ id: null }];
      },
    } as unknown as PrismaClient;

    let intentosIp = 0;
    const app = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://app_service:x@localhost:5432/test',
        DB_CTX_SECRET: 'ab'.repeat(32),
        SUPABASE_URL: 'https://test.supabase.co',
        REDIS_URL: 'redis://localhost:6379',
      }),
      prisma,
      log: pino({ level: 'silent' }),
      jwks,
      limitador: {
        async consumir(_clave, _puntos, _duracion, prefijo) {
          if (prefijo === 'rl:ip') {
            intentosIp += 1;
            if (intentosIp > 1) throw new RateLimiterRes(0, 1000, 0, false);
          }
        },
      },
      encolarCorreo: async () => {},
    });

    expect((await app.request('/api/v1/me', { headers: { Authorization: `Bearer ${jwt}` } })).status).toBe(403);
    expect(consultasBd).toBe(1);
    expect((await app.request('/api/v1/me', { headers: { Authorization: `Bearer ${jwt}` } })).status).toBe(429);
    expect(consultasBd).toBe(1);
  });
});
