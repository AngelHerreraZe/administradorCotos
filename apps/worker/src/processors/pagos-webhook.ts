import crypto from 'node:crypto';
import type { PrismaClient } from '@admcotos/db';
import { Colas, type PayloadCorreo } from '@admcotos/shared';
import { type ConnectionOptions, type Job, Worker } from 'bullmq';
import type { Logger } from 'pino';

export type EncoladorCorreoWorker = (payload: PayloadCorreo, opts?: { jobId?: string }) => Promise<void>;

interface ConektaDataPayload {
  id?: string;
  order_id?: string;
  payment_status?: string;
  metadata?: { pagoId?: string; cotoId?: string; unidadId?: string; intentoId?: string };
  charges?: { data?: { id?: string; failure_code?: string; failure_message?: string }[] };
  failure_code?: string;
  failure_message?: string;
}

function sumarDiasUtc(base: Date, dias: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dias));
}

function construirFiltroIntento(orderId: string | null | undefined, metaIntentoId: string | null | undefined) {
  if (orderId && metaIntentoId) {
    return { OR: [{ gatewayOrderId: orderId }, { id: metaIntentoId }] };
  }
  if (orderId) return { gatewayOrderId: orderId };
  if (metaIntentoId) return { id: metaIntentoId };
  return null;
}

/**
 * Procesa eventos Conekta persistidos en `webhook_events`:
 * - `order.paid` / `charge.paid`: exige encontrar el pago en BD (si aún no existe, falla y reintenta);
 *   confirma, aplica FIFO (`app.aplicar_pago`), marca intento Auto-Pay exitoso y encola recibo.
 * - `order.declined` / `order.expired` / `charge.declined`: rechaza pago pendiente y, si viene de Auto-Pay,
 *   avanza `intentosFallidos` o suspende al alcanzar `maxReintentos`.
 */
export async function procesarEventoConekta(
  prisma: PrismaClient,
  log: Logger,
  eventoId: string,
  encolarCorreo?: EncoladorCorreoWorker,
): Promise<{ estado: 'procesado' | 'ya_procesado' | 'ignorado'; pagoId?: string }> {
  const evento = await prisma.webhookEvent.findUnique({ where: { id: eventoId } });
  if (!evento) {
    throw new Error(`WebhookEvent ${eventoId} no encontrado`);
  }
  if (evento.procesadoEn) {
    return { estado: 'ya_procesado' };
  }

  const cuerpo = evento.payload as {
    type?: string;
    data?: { object?: ConektaDataPayload };
  };
  const tipo = cuerpo.type ?? evento.tipo;
  const obj = cuerpo.data?.object ?? {};

  const orderId = tipo.startsWith('charge.') ? (obj.order_id ?? null) : (obj.id ?? null);
  const chargeId = tipo.startsWith('charge.') ? (obj.id ?? null) : (obj.charges?.data?.[0]?.id ?? null);
  const metaPagoId = typeof obj.metadata?.pagoId === 'string' ? obj.metadata.pagoId : null;
  const metaIntentoId = typeof obj.metadata?.intentoId === 'string' ? obj.metadata.intentoId : null;

  let pagoConfirmadoId: string | undefined;
  let reciboPara: { email: string; coto: string; unidad: string; monto: string; fecha: string } | undefined;
  let avisoSuspensionAutopay: { cotoId: string; unidadId: string; intentoId: string; cotoNombre: string } | undefined;
  let pagoFaltanteEnPaid = false;

  try {
    await prisma.$transaction(async (tx) => {
      const pago = orderId
        ? ((await tx.pago.findFirst({ where: { gatewayOrderId: orderId } })) ??
          (metaPagoId ? await tx.pago.findUnique({ where: { id: metaPagoId } }) : null))
        : metaPagoId
          ? await tx.pago.findUnique({ where: { id: metaPagoId } })
          : null;

      if (tipo === 'order.paid' || tipo === 'charge.paid') {
        if (!pago) {
          pagoFaltanteEnPaid = true;
          throw new Error(`Pago no encontrado para evento Conekta ${tipo}`);
        }

        if (!pago.aplicadoEn) {
          await tx.pago.update({
            where: { id: pago.id },
            data: {
              estado: 'confirmado',
              fechaConfirmacion: new Date(),
              ...(!pago.gatewayOrderId && orderId ? { gatewayOrderId: orderId } : {}),
              ...(!pago.gatewayChargeId && chargeId ? { gatewayChargeId: chargeId } : {}),
            },
          });
          await tx.$executeRaw`SELECT app.aplicar_pago(${pago.id}::uuid)`;
          pagoConfirmadoId = pago.id;

          const [dest] = await tx.$queryRaw<{ email: string; coto: string; unidad: string }[]>`
            SELECT usr.email, c.nombre AS coto, u.numero AS unidad
              FROM unidades u
              JOIN cotos c ON c.id = u.coto_id
              JOIN miembros_coto mc ON mc.unidad_id = u.id AND mc.rol = 'residente_propietario' AND mc.activo
              JOIN usuarios usr ON usr.id = mc.usuario_id AND usr.activo
             WHERE u.id = ${pago.unidadId}::uuid
             ORDER BY mc.created_at
             LIMIT 1
          `;
          if (dest) {
            reciboPara = {
              email: dest.email,
              coto: dest.coto,
              unidad: dest.unidad,
              monto: pago.monto.toString(),
              fecha: pago.fechaPago.toISOString().slice(0, 10),
            };
          }
        }

        const filtroIntento = construirFiltroIntento(orderId, metaIntentoId);
        if (filtroIntento) {
          const intentos = await tx.autopayIntento.findMany({
            where: { ...filtroIntento, estado: 'pendiente' },
            select: { id: true, autopayId: true, autopay: { select: { diaCobro: true } } },
          });
          if (intentos.length > 0) {
            await tx.autopayIntento.updateMany({
              where: { id: { in: intentos.map((i) => i.id) }, estado: 'pendiente' },
              data: {
                estado: 'exitoso',
                pagoId: pago.id,
                ...(orderId ? { gatewayOrderId: orderId } : {}),
                ejecutadoEn: new Date(),
              },
            });
            for (const i of intentos) {
              const ahora = new Date();
              await tx.autopayConfig.update({
                where: { id: i.autopayId },
                data: {
                  intentosFallidos: 0,
                  ultimoCobroExitoso: ahora,
                  proximoCobro: new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, i.autopay.diaCobro)),
                },
              });
            }
          }
        }
      } else if (tipo === 'order.declined' || tipo === 'order.expired' || tipo === 'charge.declined') {
        if (pago && (pago.estado === 'pendiente' || pago.estado === 'en_revision')) {
          await tx.$executeRaw`
            SELECT app.rechazar_pago(${pago.id}::uuid, ${obj.failure_message ?? tipo})
          `;
        }

        const filtroIntento = construirFiltroIntento(orderId, metaIntentoId);
        if (filtroIntento) {
          const ahora = new Date();
          const intento = await tx.autopayIntento.findFirst({
            where: { ...filtroIntento, estado: 'pendiente' },
            include: {
              autopay: {
                select: {
                  id: true,
                  cotoId: true,
                  unidadId: true,
                  intentosFallidos: true,
                  maxReintentos: true,
                  diasEntreReintentos: true,
                },
              },
              coto: { select: { nombre: true } },
            },
          });
          if (intento) {
            const upd = await tx.autopayIntento.updateMany({
              where: { id: intento.id, estado: 'pendiente' },
              data: {
                estado: 'fallido',
                codigoError: obj.failure_code ?? tipo,
                mensajeError: obj.failure_message ?? tipo,
                ejecutadoEn: ahora,
              },
            });
            if (upd.count === 1) {
              const nuevoFallidos = intento.autopay.intentosFallidos + 1;
              const suspender = nuevoFallidos >= intento.autopay.maxReintentos;
              const diasOffset = intento.autopay.diasEntreReintentos[nuevoFallidos - 1] ?? 7;
              await tx.autopayConfig.update({
                where: { id: intento.autopay.id },
                data: suspender
                  ? { intentosFallidos: nuevoFallidos, activo: false, estado: 'suspendido_por_fallos' }
                  : { intentosFallidos: nuevoFallidos, proximoCobro: sumarDiasUtc(ahora, diasOffset) },
              });
              if (suspender) {
                avisoSuspensionAutopay = {
                  cotoId: intento.autopay.cotoId,
                  unidadId: intento.autopay.unidadId,
                  intentoId: intento.id,
                  cotoNombre: intento.coto.nombre,
                };
              }
            }
          }
        }
      } else if (tipo === 'charge.chargeback.created') {
        log.warn({ eventoId, orderId, pagoId: pago?.id }, 'contracargo recibido en Conekta');
      }

      await tx.webhookEvent.update({
        where: { id: eventoId },
        data: { procesadoEn: new Date(), error: null },
      });
    });
  } catch (err) {
    if (pagoFaltanteEnPaid) {
      await prisma.webhookEvent.update({
        where: { id: eventoId },
        data: {
          intentos: { increment: 1 },
          error: `Pago no encontrado aún para orden ${orderId ?? 'sin_order_id'}`,
        },
      });
    }
    throw err;
  }

  if (pagoConfirmadoId && reciboPara && encolarCorreo) {
    try {
      await encolarCorreo(
        {
          plantilla: 'recibo',
          para: reciboPara.email,
          datos: {
            coto: reciboPara.coto,
            unidad: reciboPara.unidad,
            monto: reciboPara.monto,
            fecha: reciboPara.fecha,
          },
        },
        { jobId: `recibo-${pagoConfirmadoId}` },
      );
    } catch (err) {
      log.warn({ err, pagoId: pagoConfirmadoId }, 'no se pudo encolar correo de recibo tras webhook');
    }
  }

  if (avisoSuspensionAutopay && encolarCorreo) {
    const dests = await prisma.$queryRaw<{ email: string }[]>`
      SELECT DISTINCT usr.email
        FROM usuarios usr
        JOIN miembros_coto mc ON mc.usuario_id = usr.id AND mc.activo
       WHERE usr.activo
         AND (
           (mc.unidad_id = ${avisoSuspensionAutopay.unidadId}::uuid AND mc.rol = 'residente_propietario')
           OR (mc.coto_id = ${avisoSuspensionAutopay.cotoId}::uuid AND mc.rol = 'coto_admin')
         )
    `;
    for (const d of dests) {
      try {
        await encolarCorreo(
          {
            plantilla: 'aviso',
            para: d.email,
            datos: {
              titulo: 'Domiciliación suspendida tras intentos fallidos',
              coto: avisoSuspensionAutopay.cotoNombre,
              detalle: 'Actualiza tu método de pago para reactivar el cobro automático.',
            },
          },
          {
            jobId: `ap-susp-${avisoSuspensionAutopay.intentoId}-${crypto.createHash('sha256').update(d.email).digest('hex').slice(0, 12)}`,
          },
        );
      } catch (err) {
        log.warn({ err, intentoId: avisoSuspensionAutopay.intentoId }, 'no se pudo encolar aviso autopay');
      }
    }
  }

  log.info({ eventoId, tipo, pagoConfirmadoId }, 'webhook Conekta procesado');
  return pagoConfirmadoId ? { estado: 'procesado', pagoId: pagoConfirmadoId } : { estado: 'ignorado' };
}

export function procesadorPagosWebhook(deps: {
  prisma: PrismaClient;
  log: Logger;
  encolarCorreo?: EncoladorCorreoWorker;
}) {
  return async (job: Pick<Job, 'id' | 'data'>) => {
    const payload = Colas.pagosWebhook.parse(job.data);
    return procesarEventoConekta(deps.prisma, deps.log, payload.eventoId, deps.encolarCorreo);
  };
}

export function iniciarPagosWebhook(opts: {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  log: Logger;
  encolarCorreo?: EncoladorCorreoWorker;
}) {
  const worker = new Worker('pagosWebhook', procesadorPagosWebhook(opts), {
    connection: opts.connection,
    concurrency: 5,
  });
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'pagosWebhook: job fallido'));
  return { worker };
}
