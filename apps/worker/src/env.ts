import { z } from 'zod';

export const COLAS = [
  'auditoria',
  'correo',
  'finanzas',
  'pagosWebhook',
  'autopay',
  'cfdi',
  'billing',
  'notificaciones',
  'gobernanza',
  'whatsappEntrante',
] as const;

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Rol app_worker (multi-tenant por política explícita). Nunca el rol dueño ni app_service. */
    WORKER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    /** Qué colas procesa esta instancia. Cada despliegue recibe SOLO los secretos de sus colas. */
    WORKER_QUEUES: z
      .string()
      .transform((s) => s.split(',').map((q) => q.trim()))
      .pipe(z.array(z.enum(COLAS)).min(1)),
    AUDIT_LOG_HMAC_SECRET: z.string().min(32).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3).optional(),
    CONEKTA_API_KEY: z.string().min(1).optional(),
    CONEKTA_API_VERSION: z.string().min(10).default('application/vnd.conekta-v2.3.0+json'),
    FACTURAPI_API_KEY: z.string().min(1).optional(),
    FACTURAPI_TEST_MODE: z.stringbool().default(true),
    MASTER_KEKS: z.string().min(10).optional(),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_METER_EVENT_NAME: z.string().min(1).default('unidades_activas'),
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** Evolution API (WhatsApp): avisos de `notificaciones` (opcional) y respuestas del bot. */
    EVOLUTION_URL: z.url({ protocol: /^https?$/ }).optional(),
    EVOLUTION_API_KEY: z.string().min(1).optional(),
    /** Gemini para el bot (clasificación y OCR). El modelo lo fija operaciones (Flash estable vigente). */
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).optional(),
    /** Solo el bot: firma el contexto RLS del residente (actúa con app_service, no con app_worker). */
    DB_CTX_SECRET: z
      .string()
      .regex(/^(?:[0-9a-f]{2}){32,}$/i, 'hex de al menos 32 bytes')
      .optional(),
    SENTRY_DSN: z.url().optional(),
  })
  .refine((e) => !e.WORKER_QUEUES.includes('auditoria') || e.AUDIT_LOG_HMAC_SECRET, {
    message: 'La cola auditoria requiere AUDIT_LOG_HMAC_SECRET',
    path: ['AUDIT_LOG_HMAC_SECRET'],
  })
  .refine((e) => !e.WORKER_QUEUES.includes('correo') || (e.RESEND_API_KEY && e.EMAIL_FROM), {
    message: 'La cola correo requiere RESEND_API_KEY y EMAIL_FROM',
    path: ['RESEND_API_KEY'],
  })
  .refine((e) => !e.WORKER_QUEUES.includes('autopay') || e.CONEKTA_API_KEY, {
    message: 'La cola autopay requiere CONEKTA_API_KEY',
    path: ['CONEKTA_API_KEY'],
  })
  .refine(
    (e) =>
      !e.WORKER_QUEUES.includes('cfdi') ||
      (e.FACTURAPI_API_KEY &&
        e.MASTER_KEKS &&
        e.S3_ENDPOINT &&
        e.S3_BUCKET &&
        e.S3_ACCESS_KEY_ID &&
        e.S3_SECRET_ACCESS_KEY),
    {
      message: 'La cola cfdi requiere FACTURAPI_API_KEY, MASTER_KEKS y configuración S3_*',
      path: ['FACTURAPI_API_KEY'],
    },
  )
  .refine((e) => !e.WORKER_QUEUES.includes('billing') || e.STRIPE_SECRET_KEY, {
    message: 'La cola billing requiere STRIPE_SECRET_KEY',
    path: ['STRIPE_SECRET_KEY'],
  })
  .refine((e) => !e.EVOLUTION_URL === !e.EVOLUTION_API_KEY, {
    message: 'EVOLUTION_URL y EVOLUTION_API_KEY van juntas',
    path: ['EVOLUTION_API_KEY'],
  })
  // El bot es un despliegue propio con app_service: no comparte proceso (ni secretos) con colas de app_worker.
  .refine((e) => !e.WORKER_QUEUES.includes('whatsappEntrante') || e.WORKER_QUEUES.length === 1, {
    message: 'La cola whatsappEntrante se despliega sola (rol app_service)',
    path: ['WORKER_QUEUES'],
  })
  .refine(
    (e) =>
      !e.WORKER_QUEUES.includes('whatsappEntrante') ||
      (e.DB_CTX_SECRET &&
        e.EVOLUTION_URL &&
        e.GEMINI_API_KEY &&
        e.GEMINI_MODEL &&
        e.S3_ENDPOINT &&
        e.S3_BUCKET &&
        e.S3_ACCESS_KEY_ID &&
        e.S3_SECRET_ACCESS_KEY),
    {
      message: 'La cola whatsappEntrante requiere DB_CTX_SECRET, EVOLUTION_*, GEMINI_API_KEY, GEMINI_MODEL y S3_*',
      path: ['DB_CTX_SECRET'],
    },
  )
  .refine((e) => e.WORKER_QUEUES.includes('whatsappEntrante') || !e.DB_CTX_SECRET, {
    message: 'DB_CTX_SECRET solo lo recibe el despliegue del bot',
    path: ['DB_CTX_SECRET'],
  });

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) throw new Error(`Variables de entorno inválidas:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
