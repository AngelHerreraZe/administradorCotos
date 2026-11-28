import {
  AppError,
  type Cola,
  OPCIONES_JOB_CORREO,
  OPCIONES_JOB_ESTANDAR,
  type PayloadBilling,
  type PayloadCfdi,
  type PayloadCorreo,
  type PayloadNotificaciones,
  type PayloadPagosWebhook,
  type PayloadWhatsappEntrante,
} from '@admcotos/shared';
import { type JobsOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { crearLimitadorTasa } from '../middleware/rate-limit.ts';
import type {
  EncoladorBilling,
  EncoladorCfdi,
  EncoladorCorreo,
  EncoladorNotificaciones,
  EncoladorPagosWebhook,
  EncoladorWhatsappEntrante,
  LimitadorTasa,
} from '../types.ts';

function crearConexionFailFast(redisUrl: string, log: Logger, nombre: string): Redis {
  const cliente = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    commandTimeout: 500,
    retryStrategy: (intentos) => Math.min(intentos * 200, 2_000),
  });
  cliente.on('error', (err) => log.error({ err, cliente: nombre }, 'error de conexión Redis'));
  return cliente;
}

function crearEncolador<T>(
  nombreCola: Cola,
  cola: Queue,
  redisCola: Redis,
  opciones: JobsOptions,
  timeoutColaMs: number,
) {
  return async (payload: T, opts?: { jobId?: string }): Promise<void> => {
    if (redisCola.status !== 'ready') {
      throw new AppError(503, 'servicio_no_disponible', `La cola ${nombreCola} no está disponible temporalmente`);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        cola.add(nombreCola, payload, {
          ...opciones,
          ...(opts?.jobId ? { jobId: opts.jobId } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AppError(503, 'servicio_no_disponible', `La cola ${nombreCola} no respondió a tiempo`)),
            timeoutColaMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export function crearRecursosRedis(
  redisUrl: string,
  log: Logger,
  timeoutColaMs = 800,
): {
  limitador: LimitadorTasa;
  encolarCorreo: EncoladorCorreo;
  encolarPagosWebhook: EncoladorPagosWebhook;
  encolarCfdi: EncoladorCfdi;
  encolarBilling: EncoladorBilling;
  encolarNotificaciones: EncoladorNotificaciones;
  encolarWhatsappEntrante: EncoladorWhatsappEntrante;
  cerrar: () => Promise<void>;
} {
  const redisRate = crearConexionFailFast(redisUrl, log, 'rate-limit');
  const redisCola = crearConexionFailFast(redisUrl, log, 'colas-api');

  const colaCorreo = new Queue('correo', { connection: redisCola });
  const colaPagosWebhook = new Queue('pagosWebhook', { connection: redisCola });
  const colaCfdi = new Queue('cfdi', { connection: redisCola });
  const colaBilling = new Queue('billing', { connection: redisCola });
  const colaNotificaciones = new Queue('notificaciones', { connection: redisCola });
  const colaWhatsapp = new Queue('whatsappEntrante', { connection: redisCola });

  for (const [nombre, cola] of [
    ['correo', colaCorreo],
    ['pagosWebhook', colaPagosWebhook],
    ['cfdi', colaCfdi],
    ['billing', colaBilling],
    ['notificaciones', colaNotificaciones],
    ['whatsappEntrante', colaWhatsapp],
  ] as const) {
    cola.on('error', (err) => log.error({ err, cola: nombre }, 'error en cola'));
  }

  return {
    limitador: crearLimitadorTasa(redisRate),
    encolarCorreo: crearEncolador<PayloadCorreo>('correo', colaCorreo, redisCola, OPCIONES_JOB_CORREO, timeoutColaMs),
    encolarPagosWebhook: crearEncolador<PayloadPagosWebhook>(
      'pagosWebhook',
      colaPagosWebhook,
      redisCola,
      OPCIONES_JOB_ESTANDAR,
      timeoutColaMs,
    ),
    encolarCfdi: crearEncolador<PayloadCfdi>('cfdi', colaCfdi, redisCola, OPCIONES_JOB_ESTANDAR, timeoutColaMs),
    encolarBilling: crearEncolador<PayloadBilling>(
      'billing',
      colaBilling,
      redisCola,
      OPCIONES_JOB_ESTANDAR,
      timeoutColaMs,
    ),
    encolarNotificaciones: crearEncolador<PayloadNotificaciones>(
      'notificaciones',
      colaNotificaciones,
      redisCola,
      OPCIONES_JOB_ESTANDAR,
      timeoutColaMs,
    ),
    // Mensajes de residentes: el job se borra al terminar o fallar (el texto no se queda en Redis).
    encolarWhatsappEntrante: crearEncolador<PayloadWhatsappEntrante>(
      'whatsappEntrante',
      colaWhatsapp,
      redisCola,
      { ...OPCIONES_JOB_ESTANDAR, attempts: 2, removeOnFail: true },
      timeoutColaMs,
    ),
    cerrar: async () => {
      await Promise.allSettled([
        colaNotificaciones.close(),
        colaWhatsapp.close(),
        colaCorreo.close(),
        colaPagosWebhook.close(),
        colaCfdi.close(),
        colaBilling.close(),
        redisCola.quit(),
        redisRate.quit(),
      ]);
    },
  };
}
