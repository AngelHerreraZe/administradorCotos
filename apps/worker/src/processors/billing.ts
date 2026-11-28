import type { PrismaClient } from '@admcotos/db';
import { registrarUsoUnidadesStripe } from '@admcotos/payments';
import { Colas } from '@admcotos/shared';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type Stripe from 'stripe';

interface CensoOrgRow {
  org_id: string;
  stripe_customer_id: string;
  unidades_activas: number;
}

/** Censo día 1 del mes: reporta unidades activas por organización a Stripe Billing Meters. */
export async function reportarCensoMensualStripe(
  prisma: PrismaClient,
  stripe: Stripe,
  eventName: string,
  log: Logger,
  fecha = new Date(),
): Promise<{ reportadas: number }> {
  const periodo = fecha.toISOString().slice(0, 7);
  const timestampEpoch = Math.floor(fecha.getTime() / 1000);
  const filas = await prisma.$queryRaw<CensoOrgRow[]>`
    SELECT o.id AS org_id,
           o.stripe_customer_id,
           count(u.id)::int AS unidades_activas
      FROM organizaciones o
      LEFT JOIN cotos c ON c.org_id = o.id AND c.activo
      LEFT JOIN unidades u ON u.coto_id = c.id AND u.activo
     WHERE o.activo AND o.stripe_customer_id IS NOT NULL
     GROUP BY o.id, o.stripe_customer_id
  `;

  for (const fila of filas) {
    await registrarUsoUnidadesStripe(stripe, {
      eventName,
      stripeCustomerId: fila.stripe_customer_id,
      unidadesActivas: fila.unidades_activas,
      timestampEpoch,
      identifier: `censo:${periodo}:${fila.org_id}`,
    });
  }

  log.info({ periodo, reportadas: filas.length }, 'censo mensual reportado a Stripe');
  return { reportadas: filas.length };
}

/**
 * Revisa facturas abiertas en Stripe por despacho:
 * - >= 6 días vencida → `solo_lectura` (staff lee, no escribe; residentes y caseta no se bloquean)
 * - >= 16 días vencida → `suspendido`
 */
export async function revisarMoraDespachos(
  prisma: PrismaClient,
  stripe: Stripe,
  log: Logger,
  hoy = new Date(),
): Promise<{ actualizadas: number }> {
  const orgs = await prisma.organizacion.findMany({
    where: { activo: true, stripeCustomerId: { not: null } },
    select: { id: true, stripeCustomerId: true, estadoSuscripcion: true },
  });

  const hoyMs = hoy.getTime();
  let actualizadas = 0;

  for (const org of orgs) {
    const customerId = org.stripeCustomerId;
    if (!customerId) continue;

    const invoices = await stripe.invoices.list({ customer: customerId, status: 'open', limit: 10 });
    let maxDiasMora = 0;
    for (const inv of invoices.data) {
      if (typeof inv.due_date === 'number') {
        const dias = Math.floor((hoyMs - inv.due_date * 1000) / 86_400_000);
        if (dias > maxDiasMora) maxDiasMora = dias;
      }
    }

    const nuevoEstado: 'activo' | 'solo_lectura' | 'suspendido' =
      maxDiasMora >= 16
        ? 'suspendido'
        : maxDiasMora >= 6
          ? 'solo_lectura'
          : org.estadoSuscripcion === 'activo'
            ? 'activo'
            : (org.estadoSuscripcion as 'solo_lectura' | 'suspendido');

    if (nuevoEstado !== org.estadoSuscripcion) {
      await prisma.organizacion.update({
        where: { id: org.id },
        data: { estadoSuscripcion: nuevoEstado },
      });
      actualizadas += 1;
      log.info(
        { orgId: org.id, estado: nuevoEstado, diasMora: maxDiasMora },
        'estado suscripción actualizado por mora',
      );
    }
  }

  return { actualizadas };
}

/** Procesa eventos Stripe persistidos en `webhook_events` (invoice.paid reactiva el despacho). */
export async function procesarWebhookStripe(
  prisma: PrismaClient,
  log: Logger,
  eventoId: string,
): Promise<{ estado: 'procesado' | 'ya_procesado' | 'ignorado' }> {
  const evento = await prisma.webhookEvent.findUnique({ where: { id: eventoId } });
  if (!evento) throw new Error(`WebhookEvent ${eventoId} no encontrado`);
  if (evento.procesadoEn) return { estado: 'ya_procesado' };

  const body = evento.payload as {
    type?: string;
    data?: { object?: { customer?: unknown } };
  };
  const tipo = body.type ?? evento.tipo;
  const customerId = typeof body.data?.object?.customer === 'string' ? body.data.object.customer : null;

  await prisma.$transaction(async (tx) => {
    if (customerId) {
      if (tipo === 'invoice.paid') {
        await tx.organizacion.updateMany({
          where: { stripeCustomerId: customerId },
          data: { estadoSuscripcion: 'activo' },
        });
      } else if (tipo === 'customer.subscription.deleted') {
        await tx.organizacion.updateMany({
          where: { stripeCustomerId: customerId },
          data: { estadoSuscripcion: 'suspendido' },
        });
      }
    }
    await tx.webhookEvent.update({
      where: { id: eventoId },
      data: { procesadoEn: new Date(), error: null },
    });
  });

  log.info({ eventoId, tipo }, 'webhook Stripe procesado');
  return {
    estado:
      customerId && (tipo === 'invoice.paid' || tipo === 'customer.subscription.deleted') ? 'procesado' : 'ignorado',
  };
}

export function procesadorBilling(deps: { prisma: PrismaClient; stripe: Stripe; meterEventName: string; log: Logger }) {
  return async (job: Pick<Job, 'id' | 'name' | 'data'>) => {
    if (job.name === 'censo-mensual-programado') {
      return reportarCensoMensualStripe(deps.prisma, deps.stripe, deps.meterEventName, deps.log);
    }
    if (job.name === 'mora-diaria-programada') {
      return revisarMoraDespachos(deps.prisma, deps.stripe, deps.log);
    }
    const payload = Colas.billing.parse(job.data);
    if (payload.accion === 'censo_mensual') {
      const fecha = payload.fecha ? new Date(`${payload.fecha}T12:00:00Z`) : new Date();
      return reportarCensoMensualStripe(deps.prisma, deps.stripe, deps.meterEventName, deps.log, fecha);
    }
    if (payload.accion === 'revisar_mora') {
      const hoy = payload.fecha ? new Date(`${payload.fecha}T12:00:00Z`) : new Date();
      return revisarMoraDespachos(deps.prisma, deps.stripe, deps.log, hoy);
    }
    if (payload.eventoId) {
      return procesarWebhookStripe(deps.prisma, deps.log, payload.eventoId);
    }
    return { estado: 'ignorado' };
  };
}

export async function iniciarBilling(opts: {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  stripe: Stripe;
  meterEventName: string;
  log: Logger;
}) {
  const queue = new Queue('billing', { connection: opts.connection });
  await queue.upsertJobScheduler(
    'billing-censo-mensual',
    { pattern: '0 5 1 * *', tz: 'America/Mexico_City' },
    { name: 'censo-mensual-programado' },
  );
  await queue.upsertJobScheduler(
    'billing-mora-diaria',
    { pattern: '0 7 * * *', tz: 'America/Mexico_City' },
    { name: 'mora-diaria-programada' },
  );

  const worker = new Worker('billing', procesadorBilling(opts), {
    connection: opts.connection,
    concurrency: 2,
  });
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'billing: job fallido'));
  return { queue, worker };
}
