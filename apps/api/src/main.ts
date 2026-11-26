import { assertRestrictedRole, createPrisma } from '@admcotos/db';
import { OPCIONES_JOB_CORREO } from '@admcotos/shared';
import { serve } from '@hono/node-server';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';
import { crearLimitadorTasa } from './middleware/rate-limit.ts';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const prisma = createPrisma({ url: env.DATABASE_URL, applicationName: 'api', max: env.DB_POOL_MAX });

// Si DATABASE_URL apunta a un rol que puede saltarse RLS, no arrancamos.
await assertRestrictedRole(prisma);

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const colaCorreo = new Queue('correo', { connection: redis });
const jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`));

const app = createApp({
  env,
  prisma,
  log,
  jwks,
  limitador: crearLimitadorTasa(redis),
  encolarCorreo: async (payload, opts) => {
    await colaCorreo.add('correo', payload, {
      ...OPCIONES_JOB_CORREO,
      ...(opts?.jobId ? { jobId: opts.jobId } : {}),
    });
  },
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port }, 'api lista'),
);

// Apagado ordenado: deja de aceptar conexiones, termina las peticiones en curso y cierra conexiones.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'apagando');
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      Promise.all([colaCorreo.close(), redis.quit(), prisma.$disconnect()]).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  });
}
