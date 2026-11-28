import { z } from '@hono/zod-openapi';

export const CotoParam = z.object({ cotoId: z.uuid() });

export const BalanceQuery = z.object({
  meses: z.coerce.number().int().min(1).max(36).default(12),
});

export const ResumenCotoDto = z
  .object({
    cotoId: z.uuid(),
    coto: z.string(),
    unidades: z.number().int(),
    emitidoMes: z.string(),
    cobradoMes: z.string(),
    pctCobrado: z.string().nullable(),
    adeudoVencido: z.string(),
    unidadesMorosas: z.number().int(),
    pagosPorRevisar: z.number().int(),
    ticketsAbiertos: z.number().int(),
  })
  .openapi('ResumenCoto');

export const FilaMorosidadDto = z
  .object({
    unidadId: z.uuid(),
    unidad: z.string(),
    adeudo: z.string(),
    cargosVencidos: z.number().int(),
    vencidoDesde: z.string(),
    mesesAtraso: z.number().int(),
  })
  .openapi('FilaMorosidad');

export const FilaBalanceDto = z
  .object({
    mes: z.string(),
    ingresos: z.string(),
    egresos: z.string(),
    neto: z.string(),
  })
  .openapi('FilaBalance');
