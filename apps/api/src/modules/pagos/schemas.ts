import { Monto } from '@admcotos/shared';
import { TIPOS_ARCHIVO_PERMITIDOS } from '@admcotos/storage';
import { z } from '@hono/zod-openapi';

const FechaHoraIso = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/, 'Fecha inválida');

export const MetodoManual = z.enum(['efectivo', 'cheque', 'transferencia_manual']);
export const MetodoOnline = z.enum(['checkout', 'tarjeta', 'spei', 'oxxo']);
export const EstadoPago = z.enum(['pendiente', 'en_revision', 'confirmado', 'rechazado', 'reembolsado']);

export const CotoParam = z.object({ cotoId: z.uuid() });
export const PagoParam = z.object({ id: z.uuid() });

export const ListarPagosQuery = z.object({
  estado: EstadoPago.optional(),
  unidadId: z.uuid().optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const CrearPagoManual = z
  .object({
    unidadId: z.uuid(),
    monto: Monto,
    metodo: MetodoManual,
    referenciaBancaria: z.string().trim().max(50).optional(),
    claveRastreo: z.string().trim().min(4).max(50).optional(),
    fechaPago: FechaHoraIso.optional(),
    notas: z.string().trim().max(500).optional(),
  })
  .openapi('CrearPagoManual');

export const SolicitarUrlComprobante = z
  .object({
    unidadId: z.uuid(),
    contentType: z.enum(TIPOS_ARCHIVO_PERMITIDOS),
  })
  .openapi('SolicitarUrlComprobante');

export const RegistrarComprobante = z
  .object({
    unidadId: z.uuid(),
    monto: Monto,
    fechaPago: FechaHoraIso.optional(),
    claveRastreo: z.string().trim().min(4).max(50).optional(),
    referenciaBancaria: z.string().trim().max(50).optional(),
    llaveArchivo: z.string().trim().min(10).max(255),
    notas: z.string().trim().max(500).optional(),
  })
  .openapi('RegistrarComprobante');

export const RechazarPago = z
  .object({
    motivo: z.string().trim().min(3).max(500),
  })
  .openapi('RechazarPago');

export const CrearPagoOnline = z
  .object({
    unidadId: z.uuid(),
    monto: Monto,
    metodo: MetodoOnline,
    concepto: z.string().trim().min(1).max(120).optional(),
    tokenTarjeta: z.string().trim().min(4).max(120).optional(),
    successUrl: z.url().optional(),
    failureUrl: z.url().optional(),
  })
  .refine((v) => v.metodo !== 'tarjeta' || Boolean(v.tokenTarjeta), {
    message: 'El método tarjeta requiere tokenTarjeta generado en el cliente',
    path: ['tokenTarjeta'],
  })
  .refine((v) => v.metodo !== 'checkout' || (Boolean(v.successUrl) && Boolean(v.failureUrl)), {
    message: 'El método checkout requiere successUrl y failureUrl',
    path: ['successUrl'],
  })
  .openapi('CrearPagoOnline');

export const PagoDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    unidadId: z.uuid(),
    monto: z.string(),
    metodo: z.string(),
    gateway: z.string().nullable(),
    gatewayOrderId: z.string().nullable(),
    gatewayChargeId: z.string().nullable(),
    comprobanteUrl: z.string().nullable(),
    referenciaBancaria: z.string().nullable(),
    claveRastreo: z.string().nullable(),
    estado: EstadoPago,
    motivoRechazo: z.string().nullable(),
    notas: z.string().nullable(),
    fechaPago: z.string(),
    fechaConfirmacion: z.string().nullable(),
    aplicadoEn: z.string().nullable(),
  })
  .openapi('Pago');

export const PagoOnlineDto = z
  .object({
    pago: PagoDto,
    gatewayOrderId: z.string(),
    checkoutUrl: z.string().optional(),
    clabeSpei: z.string().optional(),
    referenciaOxxo: z.string().optional(),
  })
  .openapi('ResultadoPagoOnline');
