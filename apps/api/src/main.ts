import { assertRestrictedRole, createPrisma } from '@admcotos/db';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const prisma = createPrisma({ url: env.DATABASE_URL, applicationName: 'api', max: env.DB_POOL_MAX });

// Si DATABASE_URL apunta a un rol que puede saltarse RLS, no arrancamos.
await assertRestrictedRole(prisma);

const app = createApp({ env, prisma, log });
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port }, 'api lista'),
);

// Apagado ordenado: deja de aceptar conexiones, termina las peticiones en curso y cierra el pool.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'apagando');
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      prisma.$disconnect().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  });
}
