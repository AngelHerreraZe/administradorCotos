import type { Prisma } from '@admcotos/db';
import { crearSesionPortalBilling } from '@admcotos/payments';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import type { StripeDeps } from '../../types.ts';
import type { EstadoBillingDto } from './schemas.ts';

export async function obtenerEstadoBilling(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<z.infer<typeof EstadoBillingDto>> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${orgId}::uuid = ANY (app.orgs_lectura())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Sin permiso para consultar facturación de esta organización');
  }

  const org = await tx.organizacion.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      tierMayoreo: true,
      estadoSuscripcion: true,
      walletCreditos: true,
      autoRecarga: true,
      montoRecargaMin: true,
    },
  });
  if (!org) throw new AppError(404, 'org_no_encontrada', 'Organización no encontrada');

  const [timbres] = await tx.$queryRaw<{ disponibles: number }[]>`
    SELECT coalesce(sum(cantidad - usados), 0)::int AS disponibles
      FROM paquetes_timbres
     WHERE org_id = ${orgId}::uuid AND estado = 'activo' AND usados < cantidad
  `;

  return {
    orgId: org.id,
    tierMayoreo: org.tierMayoreo,
    estadoSuscripcion: org.estadoSuscripcion as z.infer<typeof EstadoBillingDto>['estadoSuscripcion'],
    walletCreditos: org.walletCreditos.toString(),
    autoRecarga: org.autoRecarga,
    montoRecargaMin: org.montoRecargaMin.toString(),
    timbresDisponibles: timbres?.disponibles ?? 0,
  };
}

export async function generarUrlPortalBilling(params: {
  txWrapper: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  orgId: string;
  returnUrl: string;
  stripe: StripeDeps;
}) {
  const customerId = await params.txWrapper(async (tx) => {
    const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${params.orgId}::uuid = ANY (app.orgs_owner())) AS ok`;
    if (!perm?.ok) {
      throw new AppError(403, 'sin_permiso', 'Solo la persona propietaria de la organización accede al portal de pago');
    }
    const org = await tx.organizacion.findUnique({
      where: { id: params.orgId },
      select: { stripeCustomerId: true },
    });
    if (!org) throw new AppError(404, 'org_no_encontrada', 'Organización no encontrada');
    if (!org.stripeCustomerId) {
      throw new AppError(409, 'billing_no_configurado', 'La organización aún no tiene cliente en Stripe');
    }
    return org.stripeCustomerId;
  });

  return crearSesionPortalBilling(params.stripe.cliente, customerId, params.returnUrl);
}
