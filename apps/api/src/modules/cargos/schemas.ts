import { Monto, Periodo } from '@admcotos/shared';
import { z } from '@hono/zod-openapi';

const FechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD');

export const EstadoCargo = z.enum(['pendiente', 'parcial', 'pagado', 'condonado', 'cancelado']);

export const CotoParam = z.object({ cotoId: z.uuid() });
export const CargoParam = z.object({ id: z.uuid() });

export const GenerarCargos = z
  .object({
    conceptoId: z.uuid(),
    periodo: Periodo,
    monto: Monto.optional(),
    fechaVencimiento: FechaIso.optional(),
  })
  .openapi('GenerarCargos');

export const CrearCargo = z
  .object({
    unidadId: z.uuid(),
    conceptoId: z.uuid(),
    periodo: Periodo,
    montoOriginal: Monto,
    fechaVencimiento: FechaIso,
    notas: z.string().trim().max(500).optional(),
  })
  .openapi('CrearCargo');

export const ListarCargosQuery = z.object({
  periodo: Periodo.optional(),
  estado: EstadoCargo.optional(),
  unidadId: z.uuid().optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const CondonarCargo = z
  .object({
    motivo: z.string().trim().min(3).max(500),
  })
  .openapi('CondonarCargo');

export const CargoDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    unidadId: z.uuid(),
    conceptoId: z.uuid(),
    periodo: z.string(),
    montoOriginal: z.string(),
    montoMoratoria: z.string(),
    montoDescuento: z.string(),
    saldoPendiente: z.string(),
    estado: EstadoCargo,
    fechaEmision: z.string(),
    fechaVencimiento: z.string(),
    notas: z.string().nullable(),
  })
  .openapi('Cargo');
