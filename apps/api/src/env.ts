import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Rol app_service. La API aborta si el rol puede saltarse RLS. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  /** Firma de app.ctx (hex ≥ 32 bytes). Lo consume @admcotos/db en withTenant. */
  DB_CTX_SECRET: z.string().regex(/^(?:[0-9a-f]{2}){32,}$/i, 'hex de al menos 32 bytes'),
  /** URL base de Supabase para JWKS e issuer (ej. https://proyecto.supabase.co). */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  AUTH_AUDIENCE: z.string().min(1).default('authenticated'),
  /** Redis para rate limit y cola de correos BullMQ. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** URL base del portal web para enlaces en correos de invitación. */
  APP_PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  /** Orígenes exactos permitidos por CORS, separados por coma. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  /** Publica /openapi.json. Apágalo en producción salvo que sea la API de partners. */
  API_DOCS: z.stringbool().default(false),
  SENTRY_DSN: z.url().optional(),
  /** Almacenamiento privado S3/R2 para comprobantes y CFDI XML/PDF. */
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Conekta (pagos en línea + versión fija + firma RSA de webhooks). */
  CONEKTA_API_KEY: z.string().min(1).optional(),
  CONEKTA_API_VERSION: z.string().min(10).default('application/vnd.conekta-v2.3.0+json'),
  CONEKTA_WEBHOOK_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  /** PAC para plataformas (Facturapi; llaves de organización cifradas en worker cfdi). */
  FACTURAPI_API_KEY: z.string().min(1).optional(),
  /** Stripe Billing B2B. */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PORTAL_RETURN_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Llave que Evolution API envía en el header `apikey` de sus webhooks (se compara por hash). */
  EVOLUTION_WEBHOOK_APIKEY: z.string().min(32).optional(),
});

export type Env = z.infer<typeof Schema>;

/** Falla al arrancar con un mensaje claro; nunca imprime valores (pueden ser secretos). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) throw new Error(`Variables de entorno inválidas:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
