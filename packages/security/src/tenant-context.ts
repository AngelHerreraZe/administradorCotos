/**
 * Inyección de Contexto Multi-Tenant para PostgreSQL RLS
 * IMPORTANTE: Siempre usa is_local = true para que el contexto quede
 * estrictamente ligado a la transacción actual y no contamine otras
 * conexiones de PgBouncer.
 */
export interface TenantSessionContext {
  orgId: string;
  cotoId: string;
  userId: string;
  userRole: string;
}

export function buildTenantContextSql(ctx: TenantSessionContext): string {
  // Sanitización de UUIDs y strings para prevenir SQLi antes de set_config
  const sanitize = (val: string) => val.replace(/[^a-zA-Z0-9_-]/g, '');

  const safeOrgId = sanitize(ctx.orgId);
  const safeCotoId = sanitize(ctx.cotoId);
  const safeUserId = sanitize(ctx.userId);
  const safeRole = sanitize(ctx.userRole);

  return `
    SELECT 
      set_config('app.current_org_id', '${safeOrgId}', true),
      set_config('app.current_coto_id', '${safeCotoId}', true),
      set_config('app.current_user_id', '${safeUserId}', true),
      set_config('app.current_user_role', '${safeRole}', true);
  `;
}
