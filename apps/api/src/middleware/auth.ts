import type { PrismaClient } from '@admcotos/db';
import { AppError, Uuid } from '@admcotos/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { AppEnv } from '../types.ts';

export interface OpcionesAuth {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  resolverUsuario: (authId: string) => Promise<string | null>;
}

const MAX_CACHE_USUARIOS = 10_000;
const TTL_CACHE_MS = 60_000;

/**
 * Resuelve auth_id -> usuario_id vía app.usuario_por_auth(uuid) con caché acotada (TTL 60 s).
 * Solo cachea resultados no nulos para que un usuario recién invitado sea visible de inmediato tras aceptar.
 */
export function crearResolvedorUsuario(
  prisma: PrismaClient,
  opts: { ttlMs?: number; ahora?: () => number } = {},
): (authId: string) => Promise<string | null> {
  const ttlMs = opts.ttlMs ?? TTL_CACHE_MS;
  const ahora = opts.ahora ?? (() => Date.now());
  const cache = new Map<string, { id: string; expira: number }>();

  return async (authId: string) => {
    const ts = ahora();
    const enCache = cache.get(authId);
    if (enCache && enCache.expira > ts) return enCache.id;
    if (enCache) cache.delete(authId);

    const [fila] = await prisma.$queryRaw<{ id: string | null }[]>`SELECT app.usuario_por_auth(${authId}::uuid) AS id`;
    const id = fila?.id ?? null;
    if (id) {
      if (cache.size >= MAX_CACHE_USUARIOS) cache.clear();
      cache.set(authId, { id, expira: ts + ttlMs });
    }
    return id;
  };
}

async function verificarJwt(
  c: Context<AppEnv>,
  o: Pick<OpcionesAuth, 'jwks' | 'issuer' | 'audience'>,
): Promise<{ payload: JWTPayload; authId: string; aal: 'aal1' | 'aal2' }> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new AppError(401, 'no_autenticado', 'Inicia sesión para continuar');
  }
  const { payload } = await jwtVerify(header.slice(7), o.jwks, {
    issuer: o.issuer,
    audience: o.audience,
    algorithms: ['ES256', 'RS256'],
    clockTolerance: 5,
  }).catch(() => {
    throw new AppError(401, 'sesion_invalida', 'Tu sesión venció, vuelve a entrar');
  });

  const sub = Uuid.safeParse(payload.sub);
  if (!sub.success) {
    throw new AppError(401, 'sesion_invalida', 'Tu sesión venció, vuelve a entrar');
  }

  return {
    payload,
    authId: sub.data,
    aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
  };
}

export function autenticacion(o: OpcionesAuth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { authId, aal } = await verificarJwt(c, o);
    const usuarioId = await o.resolverUsuario(authId);
    if (!usuarioId) {
      throw new AppError(403, 'sin_cuenta', 'Tu cuenta aún no está activa en ningún coto');
    }
    c.set('auth', { usuarioId, authId, aal });
    await next();
  };
}

/**
 * Middleware exclusivo para aceptar invitaciones antes de que exista fila en `usuarios`.
 * Exige Confirm email habilitado en Supabase Auth: confía únicamente en `payload.email`
 * de nivel superior (nunca en `user_metadata`) y rechaza sesiones anónimas o `email_verified === false`.
 */
export function autenticacionPreRegistro(
  o: Pick<OpcionesAuth, 'jwks' | 'issuer' | 'audience'>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { payload, authId, aal } = await verificarJwt(c, o);
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!email) {
      throw new AppError(403, 'correo_requerido', 'Tu sesión no incluye un correo electrónico');
    }
    if (payload.is_anonymous === true || payload.email_verified === false) {
      throw new AppError(403, 'correo_no_verificado', 'Verifica tu correo electrónico antes de aceptar la invitación');
    }
    c.set('authPre', { authId, aal, email });
    await next();
  };
}
