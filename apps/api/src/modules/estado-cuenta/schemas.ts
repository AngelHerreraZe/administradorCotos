import { z } from '@hono/zod-openapi';

export const UnidadParam = z.object({ id: z.uuid() });

export const LineaEstadoCuenta = z
  .object({
    cargoId: z.uuid(),
    concepto: z.string(),
    periodo: z.string(),
    vence: z.string(),
    saldo: z.string(),
    vencido: z.boolean(),
  })
  .openapi('LineaEstadoCuenta');

export const EstadoCuentaDto = z
  .object({
    unidadId: z.uuid(),
    unidad: z.string(),
    cotoId: z.uuid(),
    coto: z.string(),
    saldoAFavor: z.string(),
    totalPendiente: z.string(),
    cargos: z.array(LineaEstadoCuenta),
  })
  .openapi('EstadoCuenta');
