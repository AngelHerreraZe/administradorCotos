import { type CorreoTransport, enviarCorreo } from '@admcotos/notifications';
import { Colas } from '@admcotos/shared';
import { type ConnectionOptions, type Job, Worker } from 'bullmq';
import type { Logger } from 'pino';

export interface ProcesadorCorreoDeps {
  apiKey: string;
  from: string;
  log: Logger;
  transport?: CorreoTransport;
}

/** Procesador de la cola `correo`: valida el payload con Zod y envía vía Resend sin loguear PII. */
export function procesadorCorreo(deps: ProcesadorCorreoDeps) {
  return async (job: Pick<Job, 'id' | 'data'>) => {
    const datos = Colas.correo.parse(job.data);
    const res = await enviarCorreo(datos, {
      apiKey: deps.apiKey,
      from: deps.from,
      transport: deps.transport,
    });
    deps.log.info({ jobId: job.id, plantilla: datos.plantilla, emailId: res.id }, 'correo enviado');
    return res;
  };
}

export function iniciarCorreo(opts: ProcesadorCorreoDeps & { connection: ConnectionOptions; concurrency?: number }) {
  const worker = new Worker('correo', procesadorCorreo(opts), {
    connection: opts.connection,
    concurrency: opts.concurrency ?? 5,
  });
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'correo: job fallido'));
  return { worker };
}
