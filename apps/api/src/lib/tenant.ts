import { type Prisma, withPreAuthTenant, withTenant } from '@admcotos/db';
import { AppError, Uuid } from '@admcotos/shared';
import type { Context } from 'hono';
import type { AppEnv, Deps } from '../types.ts';

function cotoDesdeHeader(c: Context<AppEnv>): string | undefined {
  const raw = c.req.header('X-Coto-Id');
  if (!raw) return undefined;
  const parsed = Uuid.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(422, 'validacion', 'El encabezado X-Coto-Id debe ser un UUID válido');
  }
  return parsed.data;
}

/** Único camino de una ruta autenticada hacia PostgreSQL. */
export function conTenant<T>(
  c: Context<AppEnv>,
  deps: Pick<Deps, 'prisma'>,
  cotoId: string | undefined,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const { usuarioId, aal } = c.get('auth');
  const cotoHeader = cotoDesdeHeader(c);
  if (cotoId && cotoHeader && cotoId.toLowerCase() !== cotoHeader.toLowerCase()) {
    throw new AppError(403, 'sin_permiso', 'El coto indicado no coincide con el contexto');
  }
  return withTenant(
    deps.prisma,
    { userId: usuarioId, aal, cotoId: cotoId ?? cotoHeader, requestId: c.get('requestId') },
    fn,
  );
}

/** Usado únicamente al aceptar una invitación antes de tener fila en `usuarios` (contexto firmado `auth.<auth_id>`). */
export function conTenantPreRegistro<T>(
  c: Context<AppEnv>,
  deps: Pick<Deps, 'prisma'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const { authId, aal } = c.get('authPre');
  return withPreAuthTenant(deps.prisma, { authId, aal, requestId: c.get('requestId') }, fn);
}
