import { z } from '@hono/zod-openapi';

export const OrgParam = z.object({ id: z.uuid() });

export const PortalBillingDto = z
  .object({
    url: z.string(),
  })
  .openapi('PortalBilling');

export const EstadoBillingDto = z
  .object({
    orgId: z.uuid(),
    tierMayoreo: z.string(),
    estadoSuscripcion: z.enum(['activo', 'solo_lectura', 'suspendido']),
    walletCreditos: z.string(),
    autoRecarga: z.boolean(),
    montoRecargaMin: z.string(),
    timbresDisponibles: z.number().int(),
  })
  .openapi('EstadoBilling');
