import { BlockList, isIP } from 'node:net';
import { AppError } from '@admcotos/shared';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import type { AppEnv, LimitadorTasa } from '../types.ts';

/**
 * Rangos oficiales de Cloudflare (IPv4 e IPv6).
 * Solo confiamos en CF-Connecting-IP cuando la conexión TCP proviene de Cloudflare.
 */
const CLOUDFLARE_IPS = new BlockList();
for (const cidr of [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]) {
  const [net, prefix] = cidr.split('/');
  if (net && prefix) CLOUDFLARE_IPS.addSubnet(net, Number(prefix), 'ipv4');
}
for (const cidr of [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]) {
  const [net, prefix] = cidr.split('/');
  if (net && prefix) CLOUDFLARE_IPS.addSubnet(net, Number(prefix), 'ipv6');
}

function esIpCloudflare(ip: string): boolean {
  const tipo = isIP(ip);
  if (tipo === 4) return CLOUDFLARE_IPS.check(ip, 'ipv4');
  if (tipo === 6) return CLOUDFLARE_IPS.check(ip, 'ipv6');
  return false;
}

export function resolverIpCliente(c: Context<AppEnv>): string {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    remote = undefined;
  }
  const cfIp = c.req.header('CF-Connecting-IP');
  if (remote && cfIp && esIpCloudflare(remote) && isIP(cfIp) !== 0) {
    return cfIp;
  }
  return remote ?? 'local';
}

export interface RedisRateClient {
  status?: string;
  defineCommand?: (name: string, definition: { numberOfKeys: number; lua: string }) => void;
}

/**
 * Construye un LimitadorTasa respaldado por RateLimiterRedis con `rejectIfRedisNotReady: true`
 * para fallar de inmediato (sin colas offline) cuando Redis no está listo.
 */
export function crearLimitadorTasa(redis: RedisRateClient): LimitadorTasa {
  const instancias = new Map<string, RateLimiterRedis>();

  function obtener(prefijo: string, puntos: number, duracionSegundos: number): RateLimiterRedis {
    const id = `${prefijo}:${puntos}:${duracionSegundos}`;
    let rl = instancias.get(id);
    if (!rl) {
      rl = new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: prefijo,
        points: puntos,
        duration: duracionSegundos,
        rejectIfRedisNotReady: true,
      });
      instancias.set(id, rl);
    }
    return rl;
  }

  return {
    async consumir(clave: string, puntos: number, duracionSegundos: number, prefijo: string): Promise<void> {
      const rl = obtener(prefijo, puntos, duracionSegundos);
      await rl.consume(clave);
    },
  };
}

function manejarFallo(c: Context<AppEnv>, err: unknown, falloCerrado: boolean): void {
  if (err instanceof RateLimiterRes) {
    const retryAfter = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
    c.header('Retry-After', String(retryAfter));
    throw new AppError(429, 'demasiadas_peticiones', 'Demasiadas peticiones, intenta más tarde');
  }
  c.get('log').error({ err }, 'fallo en limitador de tasa');
  if (falloCerrado) {
    throw new AppError(503, 'servicio_no_disponible', 'Servicio temporalmente no disponible');
  }
}

/** Límite por IP (600 req/min): corre antes de autenticar para proteger la BD de tokens sin cuenta. */
export function limiteTasaPorIp(
  limitador: LimitadorTasa,
  opts: { falloCerrado?: boolean; obtenerIp?: (c: Context<AppEnv>) => string } = {},
): MiddlewareHandler<AppEnv> {
  const resolverIp = opts.obtenerIp ?? resolverIpCliente;
  const falloCerrado = opts.falloCerrado ?? false;

  return async (c, next) => {
    const ip = resolverIp(c);
    try {
      await limitador.consumir(ip, 600, 60, 'rl:ip');
    } catch (err) {
      manejarFallo(c, err, falloCerrado);
    }
    await next();
  };
}

/** Límite por usuario autenticado (300 req/min). */
export function limiteTasaPorUsuario(
  limitador: LimitadorTasa,
  opts: { falloCerrado?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  const falloCerrado = opts.falloCerrado ?? false;

  return async (c, next) => {
    const auth = c.get('auth') as { usuarioId: string } | undefined;
    const authPre = c.get('authPre') as { authId: string } | undefined;
    const sujeto = auth?.usuarioId ?? authPre?.authId;
    if (sujeto) {
      try {
        await limitador.consumir(sujeto, 300, 60, 'rl:u');
      } catch (err) {
        manejarFallo(c, err, falloCerrado);
      }
    }
    await next();
  };
}

/** Límite estricto por ruta sensible (ej. invitaciones: 60/hora por usuario). */
export function limiteTasaEstricto(
  limitador: LimitadorTasa,
  opts: { prefijo: string; puntos: number; duracionSegundos: number; falloCerrado?: boolean },
): MiddlewareHandler<AppEnv> {
  const falloCerrado = opts.falloCerrado ?? false;

  return async (c, next) => {
    const auth = c.get('auth') as { usuarioId: string } | undefined;
    const clave = auth?.usuarioId ?? resolverIpCliente(c);
    try {
      await limitador.consumir(clave, opts.puntos, opts.duracionSegundos, opts.prefijo);
    } catch (err) {
      manejarFallo(c, err, falloCerrado);
    }
    await next();
  };
}
