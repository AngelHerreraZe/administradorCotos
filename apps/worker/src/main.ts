import { createPrisma } from '@admcotos/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadEnv } from './env.ts';
import { iniciarAuditoria } from './processors/auditoria.ts';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, base: { service: 'worker', colas: env.WORKER_QUEUES } });
const prisma = createPrisma({
  url: env.WORKER_DATABASE_URL,
  applicationName: `worker:${env.WORKER_QUEUES.join('+')}`,
  max: 5,
});
// BullMQ exige maxRetriesPerRequest: null en conexiones de workers (comandos bloqueantes).
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const cerrables: { close(): Promise<void> }[] = [];
if (env.WORKER_QUEUES.includes('auditoria') && env.AUDIT_LOG_HMAC_SECRET) {
  const { queue, worker } = await iniciarAuditoria({ prisma, connection, log, hmacSecret: env.AUDIT_LOG_HMAC_SECRET });
  cerrables.push(worker, queue);
}
log.info('worker listo');

// Apagado ordenado: los jobs en curso terminan; los pendientes quedan en Redis para otra réplica.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'apagando');
    setTimeout(() => process.exit(1), 30_000).unref();
    Promise.all(cerrables.map((c) => c.close()))
      .then(() => Promise.all([prisma.$disconnect(), connection.quit()]))
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
