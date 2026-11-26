import { drainAuditOutbox, type PrismaClient } from '@admcotos/db';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';

const LOTE = 500;

/** Drena hasta vaciar el outbox. Separado de BullMQ para probarlo sin Redis. */
export async function drenarTodo(drenar: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let n = LOTE; n === LOTE; total += n) n = await drenar();
  return total;
}

/**
 * Cadena de auditoría (plan seguridad §9). Un job programado cada 5 s; concurrencia 1 y el
 * advisory lock de drainAuditOutbox garantizan un solo encadenador aunque haya réplicas.
 */
export async function iniciarAuditoria(opts: {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  log: Logger;
  hmacSecret: string;
}) {
  const queue = new Queue('auditoria', { connection: opts.connection });
  await queue.upsertJobScheduler('drenar-outbox', { every: 5_000 }, { name: 'drenar' });

  const worker = new Worker(
    'auditoria',
    async () => ({ encadenados: await drenarTodo(() => drainAuditOutbox(opts.prisma, opts.hmacSecret, LOTE)) }),
    { connection: opts.connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'auditoría: lote fallido'));
  return { queue, worker };
}
