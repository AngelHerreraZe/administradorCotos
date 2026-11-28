import crypto from 'node:crypto';
import type { PrismaClient } from '@admcotos/db';
import {
  type ClienteConektaApi,
  centavosAMonto,
  cobrarFuente,
  esRechazoDefinitivoConekta,
  montoACentavos,
} from '@admcotos/payments';
import { Colas, type PayloadAutopay, type PayloadCorreo } from '@admcotos/shared';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';

export type EncoladorAutopay = (payload: PayloadAutopay, opts?: { jobId?: string }) => Promise<void>;
export type EncoladorAvisoCorreo = (payload: PayloadCorreo, opts?: { jobId?: string }) => Promise<void>;

function calcularSiguienteMes(diaCobro: number, base: Date): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, diaCobro));
}

function sumarDiasUtc(base: Date, dias: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dias));
}

/**
 * Selecciona configuraciones Auto-Pay activas vencidas hoy (`proximo_cobro <= hoy`),
 * registra `autopay_intentos` únicos por `(autopayId, cargoId, intentoNum)` y encola jobs deterministas.
 */
export async function programarCobrosAutopay(
  prisma: PrismaClient,
  encolarIntento: EncoladorAutopay,
  log: Logger,
  hoy = new Date(),
): Promise<{ encolados: number }> {
  const fechaCorte = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
  const configs = await prisma.autopayConfig.findMany({
    where: {
      activo: true,
      estado: 'activo',
      paymentMethodId: { not: null },
      proximoCobro: { lte: fechaCorte },
    },
    select: {
      id: true,
      cotoId: true,
      unidadId: true,
      diaCobro: true,
      intentosFallidos: true,
    },
  });

  let encolados = 0;
  for (const cfg of configs) {
    const [deuda] = await prisma.$queryRaw<{ total: { toString(): string }; primer_cargo: string | null }[]>`
      SELECT coalesce(sum(saldo_pendiente), 0) AS total,
             (array_agg(id ORDER BY fecha_vencimiento, created_at, id))[1] AS primer_cargo
        FROM cargos
       WHERE unidad_id = ${cfg.unidadId}::uuid
         AND estado IN ('pendiente', 'parcial')
         AND saldo_pendiente > 0
    `;
    const totalStr = deuda?.total.toString() ?? '0';
    if (!deuda?.primer_cargo || /^0+(?:\.0+)?$/.test(totalStr)) {
      await prisma.autopayConfig.update({
        where: { id: cfg.id },
        data: { proximoCobro: calcularSiguienteMes(cfg.diaCobro, fechaCorte) },
      });
      continue;
    }

    const montoCentavos = montoACentavos(totalStr);
    const intentoNum = cfg.intentosFallidos + 1;
    const claveIdempotencia = `autopay:${cfg.id}:${deuda.primer_cargo}:${intentoNum}`;

    const existente = await prisma.autopayIntento.findUnique({ where: { claveIdempotencia } });
    const intento =
      existente ??
      (await prisma.autopayIntento.create({
        data: {
          autopayId: cfg.id,
          cotoId: cfg.cotoId,
          cargoId: deuda.primer_cargo,
          intentoNum,
          montoCentavos,
          gateway: 'conekta',
          claveIdempotencia,
          estado: 'pendiente',
          programadoPara: fechaCorte,
        },
      }));

    if (intento.estado === 'pendiente') {
      const diaUtc = fechaCorte.toISOString().slice(0, 10);
      await encolarIntento(
        { accion: 'cobrar_intento', intentoId: intento.id },
        { jobId: `autopay-${intento.id}-${diaUtc}` },
      );
      encolados += 1;
    }
  }

  log.info({ revisados: configs.length, encolados }, 'programación Auto-Pay ejecutada');
  return { encolados };
}

/**
 * Ejecuta un intento de cobro Auto-Pay.
 * - Crea el registro `pagos` `pendiente` antes de llamar a Conekta (conciliable por webhook aunque haya timeout).
 * - Solo un rechazo definitivo de tarjeta (`esRechazoDefinitivoConekta`) cuenta como fallo de domiciliación.
 * - Fallos transitorios (timeout, 5xx o error de BD tras cobro) se relanzan para que BullMQ reintente con la misma `Idempotency-Key`.
 */
export async function cobrarIntentoAutopay(params: {
  prisma: PrismaClient;
  conekta: ClienteConektaApi;
  log: Logger;
  intentoId: string;
  encolarCorreo?: EncoladorAvisoCorreo;
  ahora?: Date;
}): Promise<{ estado: 'exitoso' | 'fallido' | 'suspendido' | 'omitido' }> {
  const ahora = params.ahora ?? new Date();
  const intento = await params.prisma.autopayIntento.findUnique({
    where: { id: params.intentoId },
    include: {
      autopay: { include: { paymentMethod: true } },
      coto: { select: { nombre: true } },
    },
  });
  if (intento?.estado !== 'pendiente') {
    return { estado: 'omitido' };
  }

  const pm = intento.autopay.paymentMethod;
  if (!pm?.activo) {
    await params.prisma.autopayIntento.update({
      where: { id: intento.id },
      data: {
        estado: 'fallido',
        codigoError: 'metodo_inactivo',
        mensajeError: 'Sin método de pago activo',
        ejecutadoEn: ahora,
      },
    });
    return { estado: 'fallido' };
  }

  const clavePago = `ap-pago:${intento.id}`;
  const montoStr = centavosAMonto(intento.montoCentavos);
  const metodoBd = pm.tipo === 'clabe' ? 'autopay_clabe' : 'autopay_tarjeta';

  const pagoPre = await params.prisma.$transaction(async (tx) => {
    const existente = await tx.pago.findUnique({ where: { claveIdempotencia: clavePago } });
    if (existente) return existente;
    const creado = await tx.pago.create({
      data: {
        cotoId: intento.cotoId,
        unidadId: intento.autopay.unidadId,
        monto: montoStr,
        metodo: metodoBd,
        gateway: 'conekta',
        estado: 'pendiente',
        claveIdempotencia: clavePago,
      },
    });
    await tx.autopayIntento.update({
      where: { id: intento.id },
      data: { pagoId: creado.id },
    });
    return creado;
  });

  if (pagoPre.estado === 'confirmado' && pagoPre.aplicadoEn) {
    await params.prisma.$transaction(async (tx) => {
      await tx.autopayIntento.update({
        where: { id: intento.id },
        data: { estado: 'exitoso', pagoId: pagoPre.id, ejecutadoEn: ahora },
      });
      await tx.autopayConfig.update({
        where: { id: intento.autopayId },
        data: {
          intentosFallidos: 0,
          ultimoCobroExitoso: ahora,
          proximoCobro: calcularSiguienteMes(intento.autopay.diaCobro, ahora),
        },
      });
    });
    return { estado: 'exitoso' };
  }

  const idempotencyKey = intento.claveIdempotencia ?? `autopay:${intento.id}`;
  let orden: Awaited<ReturnType<typeof cobrarFuente>>;
  try {
    orden = await cobrarFuente(
      {
        montoCentavos: intento.montoCentavos,
        concepto: `Domiciliación ${intento.coto.nombre}`,
        customerConektaId: pm.gatewayCustomerId,
        ...(pm.gatewaySourceId ? { paymentSourceId: pm.gatewaySourceId } : {}),
        metadata: {
          pagoId: pagoPre.id,
          autopayId: intento.autopayId,
          intentoId: intento.id,
          cotoId: intento.cotoId,
          unidadId: intento.autopay.unidadId,
        },
        idempotencyKey,
      },
      params.conekta,
    );
  } catch (err) {
    if (!esRechazoDefinitivoConekta(err)) {
      throw err;
    }

    const mensaje = err instanceof Error ? err.message : 'Cargo rechazado por pasarela';
    const nuevoFallidos = intento.autopay.intentosFallidos + 1;
    const suspender = nuevoFallidos >= intento.autopay.maxReintentos;
    const diasOffset = intento.autopay.diasEntreReintentos[nuevoFallidos - 1] ?? 7;

    await params.prisma.$transaction(async (tx) => {
      if (pagoPre.estado === 'pendiente') {
        await tx.$executeRaw`SELECT app.rechazar_pago(${pagoPre.id}::uuid, ${mensaje.slice(0, 200)})`;
      }
      await tx.autopayIntento.update({
        where: { id: intento.id },
        data: {
          estado: 'fallido',
          codigoError: 'cargo_rechazado',
          mensajeError: mensaje.slice(0, 400),
          ejecutadoEn: ahora,
        },
      });
      await tx.autopayConfig.update({
        where: { id: intento.autopayId },
        data: suspender
          ? { intentosFallidos: nuevoFallidos, activo: false, estado: 'suspendido_por_fallos' }
          : { intentosFallidos: nuevoFallidos, proximoCobro: sumarDiasUtc(ahora, diasOffset) },
      });
    });

    if (suspender && params.encolarCorreo) {
      const destinatarios = await params.prisma.$queryRaw<{ email: string }[]>`
        SELECT DISTINCT usr.email
          FROM usuarios usr
          JOIN miembros_coto mc ON mc.usuario_id = usr.id AND mc.activo
         WHERE usr.activo
           AND (
             (mc.unidad_id = ${intento.autopay.unidadId}::uuid AND mc.rol = 'residente_propietario')
             OR (mc.coto_id = ${intento.cotoId}::uuid AND mc.rol = 'coto_admin')
           )
      `;
      for (const dest of destinatarios) {
        try {
          await params.encolarCorreo(
            {
              plantilla: 'aviso',
              para: dest.email,
              datos: {
                titulo: 'Domiciliación suspendida tras 3 intentos fallidos',
                coto: intento.coto.nombre,
                detalle: 'Actualiza tu método de pago para reactivar el cobro automático.',
              },
            },
            {
              jobId: `ap-susp-${intento.id}-${crypto.createHash('sha256').update(dest.email).digest('hex').slice(0, 12)}`,
            },
          );
        } catch (errMail) {
          params.log.warn({ err: errMail, intentoId: intento.id }, 'no se pudo encolar aviso autopay');
        }
      }
    }

    return { estado: suspender ? 'suspendido' : 'fallido' };
  }

  const pagado = orden.paymentStatus === 'paid';
  await params.prisma.$transaction(async (tx) => {
    const pagoActual = await tx.pago.findUniqueOrThrow({ where: { id: pagoPre.id } });
    if (!pagoActual.aplicadoEn) {
      await tx.pago.update({
        where: { id: pagoPre.id },
        data: {
          ...(!pagoActual.gatewayOrderId ? { gatewayOrderId: orden.gatewayOrderId } : {}),
          ...(!pagoActual.gatewayChargeId && orden.gatewayChargeId ? { gatewayChargeId: orden.gatewayChargeId } : {}),
          ...(pagado ? { estado: 'confirmado', fechaConfirmacion: ahora } : {}),
        },
      });
      if (pagado) {
        await tx.$executeRaw`SELECT app.aplicar_pago(${pagoPre.id}::uuid)`;
      }
    }

    await tx.autopayIntento.update({
      where: { id: intento.id },
      data: {
        estado: pagado ? 'exitoso' : 'pendiente',
        pagoId: pagoPre.id,
        gatewayOrderId: orden.gatewayOrderId,
        ejecutadoEn: ahora,
      },
    });

    if (pagado) {
      await tx.autopayConfig.update({
        where: { id: intento.autopayId },
        data: {
          intentosFallidos: 0,
          ultimoCobroExitoso: ahora,
          proximoCobro: calcularSiguienteMes(intento.autopay.diaCobro, ahora),
        },
      });
    }
  });

  return { estado: 'exitoso' };
}

export function procesadorAutopay(deps: {
  prisma: PrismaClient;
  conekta: ClienteConektaApi;
  encolarIntento: EncoladorAutopay;
  encolarCorreo?: EncoladorAvisoCorreo;
  log: Logger;
}) {
  return async (job: Pick<Job, 'id' | 'name' | 'data'>) => {
    if (job.name === 'autopay-programado') {
      return programarCobrosAutopay(deps.prisma, deps.encolarIntento, deps.log);
    }
    const payload = Colas.autopay.parse(job.data);
    if (payload.accion === 'programar_dia') {
      const hoy = payload.fecha ? new Date(`${payload.fecha}T12:00:00Z`) : new Date();
      return programarCobrosAutopay(deps.prisma, deps.encolarIntento, deps.log, hoy);
    }
    return cobrarIntentoAutopay({
      prisma: deps.prisma,
      conekta: deps.conekta,
      log: deps.log,
      intentoId: payload.intentoId,
      ...(deps.encolarCorreo ? { encolarCorreo: deps.encolarCorreo } : {}),
    });
  };
}

export async function iniciarAutopay(opts: {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  conekta: ClienteConektaApi;
  log: Logger;
  encolarCorreo?: EncoladorAvisoCorreo;
}) {
  const queue = new Queue('autopay', { connection: opts.connection });
  await queue.upsertJobScheduler(
    'autopay-diario',
    { pattern: '0 6 * * *', tz: 'America/Mexico_City' },
    { name: 'autopay-programado' },
  );

  const encolarIntento: EncoladorAutopay = async (payload, jobOpts) => {
    await queue.add('autopay', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: true,
      ...(jobOpts?.jobId ? { jobId: jobOpts.jobId } : {}),
    });
  };

  const worker = new Worker('autopay', procesadorAutopay({ ...opts, encolarIntento }), {
    connection: opts.connection,
    concurrency: 3,
  });
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'autopay: job fallido'));
  return { queue, worker };
}
