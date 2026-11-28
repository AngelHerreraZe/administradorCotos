import { Monto } from '@admcotos/shared';
import { z } from '@hono/zod-openapi';

export const TipoConcepto = z.enum(['ordinario', 'extraordinario', 'multa', 'cuota_especial', 'reserva']);

export const CotoParam = z.object({ cotoId: z.uuid() });
export const ConceptoParam = z.object({ cotoId: z.uuid(), id: z.uuid() });

export const ListarConceptosQuery = z.object({
  activo: z.enum(['true', 'false']).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const CrearConcepto = z
  .object({
    nombre: z.string().trim().min(1).max(100),
    tipo: TipoConcepto,
    montoDefault: Monto.nullable().optional(),
    usaIndiviso: z.boolean().default(false),
    esRecurrente: z.boolean().default(true),
  })
  .openapi('CrearConcepto');

export const ActualizarConcepto = z
  .object({
    nombre: z.string().trim().min(1).max(100).optional(),
    tipo: TipoConcepto.optional(),
    montoDefault: Monto.nullable().optional(),
    usaIndiviso: z.boolean().optional(),
    esRecurrente: z.boolean().optional(),
    activo: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Envía al menos un campo para actualizar')
  .openapi('ActualizarConcepto');

export const Concepto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    nombre: z.string(),
    tipo: TipoConcepto,
    montoDefault: z.string().nullable(),
    usaIndiviso: z.boolean(),
    esRecurrente: z.boolean(),
    activo: z.boolean(),
  })
  .openapi('ConceptoCargo');
