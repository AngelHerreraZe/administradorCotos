import type { PrismaClient } from '@admcotos/db';
import { Colas } from '@admcotos/shared';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';

interface CotoMensualRow {
  coto_id: string;
  periodo: string;
  concepto_id: string;
}

interface CotoMoratorioRow {
  coto_id: string;
  fecha_local: Date | string;
}

async function mapConConcurrencia<T>(items: T[], concurrencia: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let indice = 0;
  const trabajadores = Array.from({ length: Math.min(concurrencia, items.length) }, async () => {
    while (indice < items.length) {
      const actual = items[indice];
      indice += 1;
      if (actual !== undefined) {
        await fn(actual);
      }
    }
  });
  await Promise.all(trabajadores);
}

/**
 * Genera cargos mensuales recurrentes para cotos con `dia_corte <= hoy` que aún no tengan
 * cargos en el periodo (recuperación ante caídas), aislando errores por coto y aplicando
 * después saldo a favor en todas las unidades sanas.
 */
export async function ejecutarGenerarMensual(
  prisma: PrismaClient,
  log: Logger,
  opts: { cotoId?: string; fechaReferencia?: Date; respetarHoraCorte?: boolean; concurrencia?: number } = {},
): Promise<{ cotosProcesados: number; cargosCreados: number; saldosAplicados: number; errores: number }> {
  const ref = opts.fechaReferencia ?? new Date();
  const respetarHora = opts.respetarHoraCorte ?? false;

  const filas = await prisma.$queryRaw<CotoMensualRow[]>`
    SELECT c.id AS coto_id,
           to_char((${ref}::timestamptz AT TIME ZONE c.zona_horaria)::date, 'YYYY-MM') AS periodo,
           cc.id AS concepto_id
      FROM cotos c
      JOIN conceptos_cargo cc ON cc.coto_id = c.id AND cc.es_recurrente AND cc.activo
     WHERE c.activo
       AND (${opts.cotoId ?? null}::uuid IS NULL OR c.id = ${opts.cotoId ?? null}::uuid)
       AND c.dia_corte <= extract(day FROM (${ref}::timestamptz AT TIME ZONE c.zona_horaria))::int
       AND (NOT ${respetarHora} OR extract(hour FROM (${ref}::timestamptz AT TIME ZONE c.zona_horaria))::int >= 3)
       AND (
         ${opts.cotoId ?? null}::uuid IS NOT NULL
         OR cc.created_at <= (
           (
             date_trunc('month', (${ref}::timestamptz AT TIME ZONE c.zona_horaria))::date
             + (least(
                 c.dia_corte,
                 extract(day FROM (date_trunc('month', (${ref}::timestamptz AT TIME ZONE c.zona_horaria)) + interval '1 month - 1 day'))::int
               ) - 1)
           )::timestamp + interval '3 hours'
         ) AT TIME ZONE c.zona_horaria
       )
       AND NOT EXISTS (
         SELECT 1
           FROM cargos g
          WHERE g.coto_id = c.id
            AND g.concepto_id = cc.id
            AND g.periodo = to_char((${ref}::timestamptz AT TIME ZONE c.zona_horaria)::date, 'YYYY-MM')
       )
  `;

  let cargosCreados = 0;
  let saldosAplicados = 0;
  let errores = 0;
  const cotosVistos = new Set<string>();
  const cotosSanos = new Set<string>();

  await mapConConcurrencia(filas, opts.concurrencia ?? 8, async (fila) => {
    cotosVistos.add(fila.coto_id);
    try {
      const [res] = await prisma.$queryRaw<{ creados: number }[]>`
        SELECT app.generar_cargos(${fila.coto_id}::uuid, ${fila.concepto_id}::uuid, ${fila.periodo}) AS creados
      `;
      cargosCreados += res?.creados ?? 0;
      cotosSanos.add(fila.coto_id);
    } catch (err) {
      errores += 1;
      log.error({ err, cotoId: fila.coto_id, conceptoId: fila.concepto_id }, 'error generando cargos del coto');
    }
  });

  await mapConConcurrencia([...cotosSanos], opts.concurrencia ?? 8, async (cotoId) => {
    try {
      const unidades = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM unidades WHERE coto_id = ${cotoId}::uuid AND activo AND saldo_a_favor > 0
      `;
      for (const u of unidades) {
        const [ap] = await prisma.$queryRaw<{ aplicado: { toString(): string } }[]>`
          SELECT app.aplicar_saldo_a_favor(${u.id}::uuid) AS aplicado
        `;
        if (ap && ap.aplicado.toString() !== '0' && ap.aplicado.toString() !== '0.00') {
          saldosAplicados += 1;
        }
      }
    } catch (err) {
      errores += 1;
      log.error({ err, cotoId }, 'error aplicando saldo a favor en coto');
    }
  });

  log.info(
    { cotosProcesados: cotosVistos.size, cargosCreados, saldosAplicados, errores },
    'generación mensual completada',
  );
  return { cotosProcesados: cotosVistos.size, cargosCreados, saldosAplicados, errores };
}

/** Aplica moratorios diarios a cotos con moratoria configurada aislando fallos por coto. */
export async function ejecutarMoratoriosDiario(
  prisma: PrismaClient,
  log: Logger,
  opts: { cotoId?: string; fechaReferencia?: Date; respetarHora?: boolean } = {},
): Promise<{ cotosProcesados: number; cargosAfectados: number; errores: number }> {
  const ref = opts.fechaReferencia ?? new Date();
  const respetarHora = opts.respetarHora ?? false;

  const cotos = await prisma.$queryRaw<CotoMoratorioRow[]>`
    SELECT c.id AS coto_id,
           (${ref}::timestamptz AT TIME ZONE c.zona_horaria)::date AS fecha_local
      FROM cotos c
     WHERE c.activo
       AND c.tipo_moratoria <> 'ninguno'
       AND c.tasa_moratoria > 0
       AND (${opts.cotoId ?? null}::uuid IS NULL OR c.id = ${opts.cotoId ?? null}::uuid)
       AND (NOT ${respetarHora} OR extract(hour FROM (${ref}::timestamptz AT TIME ZONE c.zona_horaria))::int >= 4)
  `;

  let cargosAfectados = 0;
  let errores = 0;
  for (const c of cotos) {
    try {
      const [res] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT app.aplicar_moratorios(${c.coto_id}::uuid, ${c.fecha_local}::date) AS n
      `;
      cargosAfectados += res?.n ?? 0;
    } catch (err) {
      errores += 1;
      log.error({ err, cotoId: c.coto_id }, 'error aplicando moratorios en coto');
    }
  }

  log.info({ cotosProcesados: cotos.length, cargosAfectados, errores }, 'moratorios aplicados');
  return { cotosProcesados: cotos.length, cargosAfectados, errores };
}

export function procesadorFinanzas(deps: { prisma: PrismaClient; log: Logger }) {
  return async (job: Pick<Job, 'id' | 'name' | 'data'>) => {
    if (job.name === 'generar-mensual-programado') {
      return ejecutarGenerarMensual(deps.prisma, deps.log, { respetarHoraCorte: true });
    }
    if (job.name === 'moratorios-programado') {
      return ejecutarMoratoriosDiario(deps.prisma, deps.log, { respetarHora: true });
    }
    const payload = Colas.finanzas.parse(job.data);
    const fechaRef = payload.fecha ? new Date(`${payload.fecha}T12:00:00Z`) : undefined;
    if (payload.accion === 'generar_mensual') {
      return ejecutarGenerarMensual(deps.prisma, deps.log, {
        cotoId: payload.cotoId,
        ...(fechaRef ? { fechaReferencia: fechaRef } : {}),
      });
    }
    return ejecutarMoratoriosDiario(deps.prisma, deps.log, {
      cotoId: payload.cotoId,
      ...(fechaRef ? { fechaReferencia: fechaRef } : {}),
    });
  };
}

export async function iniciarFinanzas(opts: { prisma: PrismaClient; connection: ConnectionOptions; log: Logger }) {
  const queue = new Queue('finanzas', { connection: opts.connection });
  await queue.upsertJobScheduler(
    'finanzas-generar-mensual',
    { pattern: '0 * * * *' },
    { name: 'generar-mensual-programado' },
  );
  await queue.upsertJobScheduler('finanzas-moratorios', { pattern: '5 * * * *' }, { name: 'moratorios-programado' });

  const worker = new Worker('finanzas', procesadorFinanzas(opts), {
    connection: opts.connection,
    concurrency: 2,
  });
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'finanzas: job fallido'));
  return { queue, worker };
}
