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
});

export type Env = z.infer<typeof Schema>;

/** Falla al arrancar con un mensaje claro; nunca imprime valores (pueden ser secretos). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) throw new Error(`Variables de entorno inválidas:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
