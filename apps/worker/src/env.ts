import { z } from 'zod';

export const COLAS = ['auditoria'] as const;

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
    SENTRY_DSN: z.url().optional(),
  })
  .refine((e) => !e.WORKER_QUEUES.includes('auditoria') || e.AUDIT_LOG_HMAC_SECRET, {
    message: 'La cola auditoria requiere AUDIT_LOG_HMAC_SECRET',
    path: ['AUDIT_LOG_HMAC_SECRET'],
  });

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) throw new Error(`Variables de entorno inválidas:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
