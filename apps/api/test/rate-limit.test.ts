import { Hono } from 'hono';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { manejarError } from '../src/middleware/errors.ts';
import {
  crearLimitadorTasa,
  limiteTasaEstricto,
  limiteTasaGeneral,
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

describe('rate limit (RateLimiterRedis con Redis mínimo)', () => {
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

  test('si Redis falla, permite en ruta general y rechaza con 503 en ruta crítica', async () => {
    const redis = new RedisFalso();
    const limitador = crearLimitadorTasa(redis);
    const app = new Hono<AppEnv>();
    const log = pino({ level: 'silent' });
    app.onError(manejarError(log));
    app.use('*', async (c, next) => {
      c.set('log', log);
      await next();
    });
    app.get('/general', limiteTasaGeneral(limitador), (c) => c.json({ ok: true }));
    app.post('/critico', limiteTasaGeneral(limitador, { falloCerrado: true }), (c) => c.json({ ok: true }));

    redis.fallar = true;
    expect((await app.request('/general')).status).toBe(200);
    expect((await app.request('/critico', { method: 'POST' })).status).toBe(503);
  });
});
