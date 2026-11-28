import { assertRestrictedRole, createPrisma } from '@admcotos/db';
import { serve } from '@hono/node-server';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { crearAdaptadoresExternos } from './lib/adaptadores.ts';
import { crearRecursosRedis } from './lib/redis.ts';
import { createLogger } from './logger.ts';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const prisma = createPrisma({ url: env.DATABASE_URL, applicationName: 'api', max: env.DB_POOL_MAX });

// Si DATABASE_URL apunta a un rol que puede saltarse RLS, no arrancamos.
await assertRestrictedRole(prisma);

const recursosRedis = crearRecursosRedis(env.REDIS_URL, log);
const adaptadores = crearAdaptadoresExternos(env);
const jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`));

const app = createApp({
  env,
  prisma,
  log,
  jwks,
  limitador: recursosRedis.limitador,
  encolarCorreo: recursosRedis.encolarCorreo,
  encolarPagosWebhook: recursosRedis.encolarPagosWebhook,
  encolarCfdi: recursosRedis.encolarCfdi,
  encolarBilling: recursosRedis.encolarBilling,
  encolarNotificaciones: recursosRedis.encolarNotificaciones,
  encolarWhatsappEntrante: recursosRedis.encolarWhatsappEntrante,
  ...adaptadores,
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
      Promise.all([recursosRedis.cerrar(), prisma.$disconnect()]).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  });
}
