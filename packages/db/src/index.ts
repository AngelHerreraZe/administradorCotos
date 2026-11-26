import { type AalLevel, assertUuid, calculateAuditHash, signDbContext, signPreAuthContext } from '@admcotos/security';
import type { Prisma, PrismaClient } from './generated/prisma/client.ts';

export { createPrisma, type DbOptions } from './client.ts';
export type { Prisma, PrismaClient } from './generated/prisma/client.ts';

export interface DbContext {
  userId: string; // de un JWT ya verificado; NUNCA de headers o body
  aal?: AalLevel; // nivel de autenticación del JWT ('aal1' | 'aal2')
  cotoId?: string | null; // acota la vista a un coto (opcional, solo restringe)
  requestId?: string; // viaja a la metadata de auditoría
}

export interface PreAuthDbContext {
  authId: string;
  aal?: AalLevel;
  requestId?: string;
}

let ctxSecret: Buffer | undefined;
function contextSecret(): Buffer {
  if (!ctxSecret) {
    const hex = process.env.DB_CTX_SECRET ?? '';
    if (!/^(?:[0-9a-f]{2}){32,}$/i.test(hex)) throw new Error('DB_CTX_SECRET debe ser hex de al menos 32 bytes');
    ctxSecret = Buffer.from(hex, 'hex');
  }
  return ctxSecret;
}

/**
 * Única puerta de la API a la base de datos.
 * Abre una transacción, fija el contexto RLS con set_config(..., true)
 * (muere con la transacción: seguro con PgBouncer en modo transaction)
 * y ejecuta fn. Fuera de withTenant, app_service no ve ninguna fila.
 */
export function withTenant<T>(
  prisma: PrismaClient,
  ctx: DbContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  const firma = signDbContext(ctx.userId, contextSecret(), { aal: ctx.aal ?? 'aal1' });
  const coto = ctx.cotoId ? assertUuid(ctx.cotoId, 'cotoId') : '';
  const req = (ctx.requestId ?? '').slice(0, 100);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.ctx', ${firma}, true), set_config('app.coto_id', ${coto}, true), set_config('app.req', ${req}, true)`;
    return fn(tx);
  }, options);
}

/** Transacción previa a la creación de `usuarios` (solo para `app.aceptar_invitacion`). */
export function withPreAuthTenant<T>(
  prisma: PrismaClient,
  ctx: PreAuthDbContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  const firma = signPreAuthContext(ctx.authId, contextSecret(), { aal: ctx.aal ?? 'aal1' });
  const req = (ctx.requestId ?? '').slice(0, 100);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.ctx', ${firma}, true), set_config('app.coto_id', '', true), set_config('app.req', ${req}, true)`;
    return fn(tx);
  }, options);
}

/** Llamar al arrancar la API: aborta si la conexión puede saltarse RLS. */
export async function assertRestrictedRole(prisma: PrismaClient): Promise<void> {
  const [r] = await prisma.$queryRaw<{ rol: string; inseguro: boolean }[]>`
    SELECT current_user AS rol,
           (r.rolsuper OR r.rolbypassrls OR EXISTS (
              SELECT 1 FROM pg_tables t
               WHERE t.schemaname = 'public' AND pg_has_role(current_user, t.tableowner, 'USAGE'))) AS inseguro
      FROM pg_roles r WHERE r.rolname = current_user`;
  if (!r || r.inseguro) {
    throw new Error(`Conexión insegura: el rol "${r?.rol}" puede saltarse RLS. DATABASE_URL debe usar app_service.`);
  }
}

interface OutboxRow {
  id: bigint;
  org_id: string;
  coto_id: string | null;
  usuario_id: string | null;
  accion: string;
  recurso_tipo: string;
  recurso_id: string | null;
  datos_antes: unknown;
  datos_despues: unknown;
  metadata: unknown;
  created_at: Date;
}

const GENESIS = '0'.repeat(64);
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

/**
 * Worker de auditoría (conexión app_worker + AUDIT_LOG_HMAC_SECRET).
 * Encadena audit_outbox → audit_log con HMAC por organización. Un solo
 * drenador a la vez (advisory lock). Devuelve cuántos registros movió.
 * ponytail: inserts fila por fila; pasar a unnest() si el lote pesa.
 */
export function drainAuditOutbox(prisma: PrismaClient, hmacSecret: string, batch = 500): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(7243001) AS ok`;
      if (!lock?.ok) return 0;
      const rows = await tx.$queryRaw<OutboxRow[]>`SELECT * FROM audit_outbox ORDER BY id LIMIT ${batch}`;
      const heads = new Map<string, string>();
      for (const r of rows) {
        let prev = heads.get(r.org_id);
        if (prev === undefined) {
          const [h] = await tx.$queryRaw<{ ultimo_hash: string }[]>`
            SELECT ultimo_hash FROM audit_chain_head WHERE org_id = ${r.org_id}::uuid`;
          prev = h?.ultimo_hash ?? GENESIS;
        }
        const hash = calculateAuditHash(
          {
            orgId: r.org_id,
            cotoId: r.coto_id,
            usuarioId: r.usuario_id,
            accion: r.accion,
            recursoTipo: r.recurso_tipo,
            recursoId: r.recurso_id,
            timestamp: r.created_at.toISOString(),
            datosAntes: r.datos_antes,
            datosDespues: r.datos_despues,
            metadata: r.metadata,
          },
          prev,
          hmacSecret,
        );
        await tx.$executeRaw`
          INSERT INTO audit_log (org_id, coto_id, usuario_id, accion, recurso_tipo, recurso_id,
                                 datos_antes, datos_despues, metadata, hash_anterior, hash_integridad, created_at)
          VALUES (${r.org_id}::uuid, ${r.coto_id}::uuid, ${r.usuario_id}::uuid, ${r.accion}, ${r.recurso_tipo},
                  ${r.recurso_id}::uuid, ${json(r.datos_antes)}::jsonb, ${json(r.datos_despues)}::jsonb,
                  ${json(r.metadata)}::jsonb, ${prev}, ${hash}, ${r.created_at})`;
        heads.set(r.org_id, hash);
      }
      for (const [org, hash] of heads) {
        await tx.$executeRaw`
          INSERT INTO audit_chain_head (org_id, ultimo_hash) VALUES (${org}::uuid, ${hash})
          ON CONFLICT (org_id) DO UPDATE SET ultimo_hash = EXCLUDED.ultimo_hash, updated_at = now()`;
      }
      // Solo los ids leídos: un id menor que confirme tarde se encadena en el siguiente lote.
      if (rows.length)
        await tx.$executeRaw`DELETE FROM audit_outbox WHERE id = ANY(${rows.map((r) => String(r.id))}::bigint[])`;
      return rows.length;
    },
    { timeout: 60_000 },
  );
}
