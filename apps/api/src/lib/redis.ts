import { AppError, OPCIONES_JOB_CORREO, type PayloadCorreo } from '@admcotos/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { crearLimitadorTasa } from '../middleware/rate-limit.ts';
import type { EncoladorCorreo, LimitadorTasa } from '../types.ts';

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

export function crearRecursosRedis(
  redisUrl: string,
  log: Logger,
  timeoutColaMs = 800,
): {
  limitador: LimitadorTasa;
  encolarCorreo: EncoladorCorreo;
  cerrar: () => Promise<void>;
} {
  const redisRate = crearConexionFailFast(redisUrl, log, 'rate-limit');
  const redisCola = crearConexionFailFast(redisUrl, log, 'cola-correo');
  const colaCorreo = new Queue('correo', { connection: redisCola });
  colaCorreo.on('error', (err) => log.error({ err }, 'error en cola correo'));

  const encolarCorreo: EncoladorCorreo = async (payload: PayloadCorreo, opts?: { jobId?: string }) => {
    if (redisCola.status !== 'ready') {
      throw new AppError(503, 'servicio_no_disponible', 'El servicio de correo no está disponible temporalmente');
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        colaCorreo.add('correo', payload, {
          ...OPCIONES_JOB_CORREO,
          ...(opts?.jobId ? { jobId: opts.jobId } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AppError(503, 'servicio_no_disponible', 'El servicio de correo no respondió a tiempo')),
            timeoutColaMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    limitador: crearLimitadorTasa(redisRate),
    encolarCorreo,
    cerrar: async () => {
      await Promise.allSettled([colaCorreo.close(), redisCola.quit(), redisRate.quit()]);
    },
  };
}
