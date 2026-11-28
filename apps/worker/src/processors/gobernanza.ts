import type { PrismaClient } from '@admcotos/db';
import { Colas, type PayloadGobernanza } from '@admcotos/shared';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';

/** Abre/cierra votaciones por fecha y marca el SLA vencido de tickets. Idempotente (solo transiciones). */
export async function procesarGobernanza(prisma: PrismaClient, payload: PayloadGobernanza, log: Logger) {
  if (payload.accion === 'votaciones') {
    const abiertas = await prisma.$executeRaw`
      UPDATE votaciones SET estado = 'activa'
       WHERE estado = 'programada' AND fecha_inicio <= now() AND fecha_fin > now()`;
    const cerradas = await prisma.$executeRaw`
      UPDATE votaciones SET estado = 'cerrada'
       WHERE estado IN ('programada', 'activa') AND fecha_fin <= now()`;
    if (abiertas || cerradas) log.info({ abiertas, cerradas }, 'votaciones actualizadas por fecha');
    return { abiertas, cerradas };
  }
  // ponytail: solo marca; la administración los ve con `slaVencido`. Avisar por correo si lo piden.
  const vencidos = await prisma.$executeRaw`
    UPDATE tickets SET sla_vencido = true, updated_at = now()
     WHERE NOT sla_vencido AND estado IN ('abierto', 'en_proceso') AND sla_vence_en < now()`;
  if (vencidos) log.info({ vencidos }, 'tickets con SLA vencido');
  return { vencidos };
}

export async function iniciarGobernanza(opts: { prisma: PrismaClient; connection: ConnectionOptions; log: Logger }) {
  const queue = new Queue('gobernanza', { connection: opts.connection });
  await queue.upsertJobScheduler(
    'gobernanza-votaciones',
    { pattern: '*/5 * * * *' },
    { name: 'votaciones', data: { accion: 'votaciones' } },
  );
  await queue.upsertJobScheduler(
    'gobernanza-sla-tickets',
    { pattern: '0 8 * * *', tz: 'America/Mexico_City' },
    { name: 'sla_tickets', data: { accion: 'sla_tickets' } },
  );
  const worker = new Worker(
    'gobernanza',
    (job: Pick<Job, 'data'>) => procesarGobernanza(opts.prisma, Colas.gobernanza.parse(job.data), opts.log),
    { connection: opts.connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'gobernanza: job fallido'));
  return { queue, worker };
}
