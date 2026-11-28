import { z } from 'zod';

const Uuid = z.uuid();

export const Colas = {
  correo: z.object({
    plantilla: z.enum(['invitacion', 'recibo', 'aviso']),
    para: z.email(),
    datos: z.record(z.string(), z.string()),
  }),
  finanzas: z.discriminatedUnion('accion', [
    z.object({
      accion: z.literal('generar_mensual'),
      cotoId: Uuid,
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    z.object({
      accion: z.literal('aplicar_moratorios'),
      cotoId: Uuid,
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
  ]),
  pagosWebhook: z.object({
    eventoId: Uuid,
  }),
  autopay: z.discriminatedUnion('accion', [
    z.object({
      accion: z.literal('programar_dia'),
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    z.object({
      accion: z.literal('cobrar_intento'),
      intentoId: Uuid,
    }),
  ]),
  cfdi: z.discriminatedUnion('accion', [
    z.object({
      accion: z.literal('sincronizar_llave'),
      cotoId: Uuid,
      facturapiOrgId: z.string().min(1),
    }),
    z.object({
      accion: z.literal('timbrar'),
      cotoId: Uuid,
      pagoId: Uuid,
      receptor: z.object({
        rfc: z.string().min(12).max(13),
        nombre: z.string().min(1).max(300),
        regimenFiscal: z.string().regex(/^\d{3}$/),
        cpFiscal: z.string().regex(/^\d{5}$/),
        usoCfdi: z.string().min(3).max(5).default('G03'),
        email: z.email().optional(),
      }),
      claveIdempotencia: z.string().min(1).max(100),
    }),
    z.object({
      accion: z.literal('cancelar'),
      cotoId: Uuid,
      facturaId: Uuid,
      motivo: z.enum(['01', '02', '03', '04']),
      sustitucionUuid: Uuid.optional(),
    }),
    z.object({
      accion: z.literal('verificar_cancelacion'),
      cotoId: Uuid,
      facturaId: Uuid,
      intento: z.number().int().min(1).max(20).default(1),
    }),
  ]),
  billing: z.discriminatedUnion('accion', [
    z.object({
      accion: z.literal('censo_mensual'),
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    z.object({
      accion: z.literal('revisar_mora'),
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    z.object({
      accion: z.literal('procesar_webhook'),
      eventoId: Uuid,
    }),
  ]),
  /** Fan-out de un comunicado publicado: cada job atiende el siguiente lote de 100 destinatarios. */
  notificaciones: z.object({
    accion: z.literal('comunicado'),
    comunicadoId: Uuid,
  }),
  /**
   * Mensaje entrante de WhatsApp ya verificado por la API. El texto viaja solo en Redis (job efímero),
   * nunca en logs ni en `webhook_events`.
   */
  whatsappEntrante: z.object({
    instancia: z.string().regex(/^coto_[0-9a-f-]{36}$/),
    telefono: z.string().regex(/^\d{10,15}$/),
    mensajeId: z.string().min(1).max(100),
    texto: z.string().max(4_000).optional(),
    media: z.object({ tipo: z.enum(['imagen', 'documento']), mimetype: z.string().max(100) }).optional(),
  }),
  /** Jobs programados de gobernanza: abrir/cerrar votaciones por fecha y marcar SLA vencido de tickets. */
  gobernanza: z.object({
    accion: z.enum(['votaciones', 'sla_tickets']),
  }),
} as const;

export type Cola = keyof typeof Colas;
export type PayloadCorreo = z.infer<typeof Colas.correo>;
export type PayloadFinanzas = z.infer<typeof Colas.finanzas>;
export type PayloadPagosWebhook = z.infer<typeof Colas.pagosWebhook>;
export type PayloadAutopay = z.infer<typeof Colas.autopay>;
export type PayloadCfdi = z.infer<typeof Colas.cfdi>;
export type PayloadBilling = z.infer<typeof Colas.billing>;
export type PayloadNotificaciones = z.infer<typeof Colas.notificaciones>;
export type PayloadWhatsappEntrante = z.infer<typeof Colas.whatsappEntrante>;
export type PayloadGobernanza = z.infer<typeof Colas.gobernanza>;

export const OPCIONES_JOB_CORREO = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 3_600 },
} as const;

export const OPCIONES_JOB_ESTANDAR = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
} as const;
