import { Monto } from '@admcotos/shared';
import { TIPOS_ARCHIVO_PERMITIDOS } from '@admcotos/storage';
import { z } from '@hono/zod-openapi';

const FechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD');

export const EstadoEgreso = z.enum(['pendiente', 'aprobado', 'rechazado', 'pagado']);

export const CotoParam = z.object({ cotoId: z.uuid() });
export const EgresoCotoParam = z.object({ cotoId: z.uuid(), id: z.uuid() });
export const EgresoParam = z.object({ id: z.uuid() });

export const ListarEgresosQuery = z.object({
  estado: EstadoEgreso.optional(),
  categoria: z.string().trim().max(40).optional(),
  desde: FechaIso.optional(),
  hasta: FechaIso.optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const CrearEgreso = z
  .object({
    concepto: z.string().trim().min(1).max(200),
    monto: Monto,
    fecha: FechaIso.optional(),
    categoria: z.string().trim().min(1).max(40).default('mantenimiento'),
    cuentaBancariaId: z.uuid().optional(),
    proveedorId: z.uuid().optional(),
    tieneFactura: z.boolean().default(false),
    facturaUuid: z.uuid().optional(),
    comprobanteUrl: z.string().trim().min(10).max(255).optional(),
    notas: z.string().trim().max(1000).optional(),
  })
  .openapi('CrearEgreso');

export const ActualizarEgreso = z
  .object({
    concepto: z.string().trim().min(1).max(200).optional(),
    categoria: z.string().trim().min(1).max(40).optional(),
    cuentaBancariaId: z.uuid().nullable().optional(),
    proveedorId: z.uuid().nullable().optional(),
    tieneFactura: z.boolean().optional(),
    facturaUuid: z.uuid().nullable().optional(),
    comprobanteUrl: z.string().trim().min(10).max(255).nullable().optional(),
    notas: z.string().trim().max(1000).nullable().optional(),
    marcarPagado: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Envía al menos un campo para actualizar')
  .refine(
    (v) => !v.marcarPagado || Object.keys(v).length === 1,
    'Al marcar como pagado no puedes modificar otros campos del egreso',
  )
  .openapi('ActualizarEgreso');

export const SolicitarUrlComprobanteEgreso = z
  .object({
    contentType: z.enum(TIPOS_ARCHIVO_PERMITIDOS),
  })
  .openapi('SolicitarUrlComprobanteEgreso');

export const RechazarEgreso = z
  .object({
    motivo: z.string().trim().max(500).optional(),
  })
  .openapi('RechazarEgreso');

export const EgresoDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    cuentaBancariaId: z.uuid().nullable(),
    proveedorId: z.uuid().nullable(),
    categoria: z.string(),
    concepto: z.string(),
    monto: z.string(),
    fecha: z.string(),
    estado: EstadoEgreso,
    solicitadoPor: z.uuid().nullable(),
    aprobadoPor: z.uuid().nullable(),
    aprobadoEn: z.string().nullable(),
    rechazadoEn: z.string().nullable(),
    motivoRechazo: z.string().nullable(),
    tieneFactura: z.boolean(),
    facturaUuid: z.uuid().nullable(),
    comprobanteUrl: z.string().nullable(),
    notas: z.string().nullable(),
  })
  .openapi('Egreso');
