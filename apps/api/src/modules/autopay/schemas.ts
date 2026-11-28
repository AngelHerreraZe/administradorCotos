import { z } from '@hono/zod-openapi';

export const UnidadParam = z.object({ id: z.uuid() });
export const MetodoPagoParam = z.object({ id: z.uuid(), metodoId: z.uuid() });

export const TipoMetodoPago = z.enum(['card', 'clabe', 'spei_mandate']);
export const EstadoAutopay = z.enum(['activo', 'pausado', 'suspendido_por_fallos', 'cancelado_por_usuario']);

export const AgregarMetodoPago = z
  .object({
    tipo: TipoMetodoPago.default('card'),
    tokenId: z.string().trim().min(4).max(120),
    label: z.string().trim().max(100).optional(),
    ultimos4: z
      .string()
      .regex(/^\d{4}$/, 'Últimos 4 dígitos inválidos')
      .optional(),
    marcaTarjeta: z.string().trim().max(20).optional(),
    fechaExpiracion: z
      .string()
      .regex(/^\d{2}\/\d{2,4}$/, 'Usa MM/AA')
      .optional(),
    esDefault: z.boolean().default(true),
  })
  .openapi('AgregarMetodoPago');

export const MetodoPagoDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    unidadId: z.uuid(),
    tipo: TipoMetodoPago,
    gateway: z.string(),
    label: z.string().nullable(),
    ultimos4: z.string().nullable(),
    marcaTarjeta: z.string().nullable(),
    fechaExpiracion: z.string().nullable(),
    esDefault: z.boolean(),
    activo: z.boolean(),
  })
  .openapi('MetodoPago');

export const ActivarAutopay = z
  .object({
    paymentMethodId: z.uuid(),
    diaCobro: z.number().int().min(1).max(28),
    terminosVersion: z.string().trim().min(1).max(30),
    aceptoTerminos: z.literal(true),
  })
  .openapi('ActivarAutopay');

export const ActualizarAutopay = z
  .object({
    paymentMethodId: z.uuid().optional(),
    diaCobro: z.number().int().min(1).max(28).optional(),
    estado: z.enum(['pausado', 'activo', 'cancelado_por_usuario']).optional(),
    terminosVersion: z.string().trim().min(1).max(30).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Envía al menos un campo para actualizar')
  .openapi('ActualizarAutopay');

export const AutopayConfigDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    unidadId: z.uuid(),
    paymentMethodId: z.uuid().nullable(),
    activo: z.boolean(),
    diaCobro: z.number().int(),
    maxReintentos: z.number().int(),
    intentosFallidos: z.number().int(),
    ultimoCobroExitoso: z.string().nullable(),
    proximoCobro: z.string().nullable(),
    estado: EstadoAutopay,
    terminosVersion: z.string().nullable(),
    terminosAceptadosEn: z.string().nullable(),
  })
  .openapi('AutopayConfig');

export const AutopayIntentoDto = z
  .object({
    id: z.uuid(),
    cargoId: z.uuid().nullable(),
    pagoId: z.uuid().nullable(),
    intentoNum: z.number().int(),
    montoCentavos: z.number().int(),
    gateway: z.string(),
    estado: z.enum(['pendiente', 'exitoso', 'fallido', 'reembolsado']),
    codigoError: z.string().nullable(),
    mensajeError: z.string().nullable(),
    programadoPara: z.string(),
    ejecutadoEn: z.string().nullable(),
  })
  .openapi('AutopayIntento');
