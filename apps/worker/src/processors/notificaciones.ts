import type { PrismaClient } from '@admcotos/db';
import { Colas, type PayloadCorreo, type PayloadNotificaciones } from '@admcotos/shared';
import { calculateInterMessageDelay, checkWarmupLimit, type EvolutionApiClient } from '@admcotos/whatsapp';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export const LOTE_NOTIFICACIONES = 100;

export type EncoladorCorreoWorker = (payload: PayloadCorreo, opts?: { jobId?: string }) => Promise<void>;
export type ReencoladorNotificaciones = (
  payload: PayloadNotificaciones,
  opts: { jobId: string; delayMs?: number },
) => Promise<void>;

/** WhatsApp de avisos: envío + contador diario por instancia (calentamiento del chip). */
export interface CanalWhatsapp {
  enviarTexto(instancia: string, numero: string, texto: string): Promise<void>;
  enviadosHoy(instancia: string, dia: string): Promise<number>;
  registrarEnvio(instancia: string, dia: string): Promise<void>;
  esperar(ms: number): Promise<void>;
}

function horaLocal(fecha: Date, zona: string): { hora: number; minuto: number; dia: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(fecha)
      .map((x) => [x.type, x.value]),
  );
  return { hora: Number(p.hour), minuto: Number(p.minute), dia: `${p.year}-${p.month}-${p.day}` };
}

/** Horario de silencio 22:00–07:00 en la zona del coto (fijo; plan §8 4.1). */
export function enSilencio(fecha: Date, zona: string): boolean {
  const { hora } = horaLocal(fecha, zona);
  return hora >= 22 || hora < 7;
}

/** Milisegundos hasta las próximas 07:00 locales. */
export function msHastaLas7(fecha: Date, zona: string): number {
  const { hora, minuto } = horaLocal(fecha, zona);
  const horas = hora < 7 ? 7 - hora : 31 - hora;
  return (horas * 60 - minuto) * 60_000;
}

// ponytail: numeración MX; un número de 10 dígitos se completa con 52.
const numeroWhatsapp = (tel: string) => {
  const d = tel.replace(/\D/g, '');
  return d.length === 10 ? `52${d}` : d;
};

interface Destinatario {
  usuario_id: string;
  email: string;
  telefono: string | null;
  telefono_verificado: boolean;
  notif_correo: boolean;
  notif_whatsapp: boolean;
}

/**
 * Atiende un lote del comunicado y encola el siguiente. Idempotente y seguro con réplicas: cada lote se
 * reclama en SQL (`notificado_en`, SKIP LOCKED) antes de enviar.
 * ponytail: reclamar-y-enviar es "a lo más una vez": si el proceso muere a medio lote, esos destinatarios
 * no reciben el aviso (siguen viéndolo en la app). Pasar a un estado por canal si se vuelve necesario.
 */
export async function procesarNotificacion(params: {
  prisma: PrismaClient;
  payload: PayloadNotificaciones;
  encolarCorreo?: EncoladorCorreoWorker;
  whatsapp?: CanalWhatsapp;
  reencolar: ReencoladorNotificaciones;
  log: Logger;
  ahora?: Date;
}): Promise<{ resultado: 'fin' | 'lote' | 'silencio' | 'limite_whatsapp'; enviados: number }> {
  const { comunicadoId } = params.payload;
  const ahora = params.ahora ?? new Date();
  const c = await params.prisma.comunicado.findUnique({
    where: { id: comunicadoId },
    select: {
      titulo: true,
      cuerpo: true,
      prioridad: true,
      publicado: true,
      cotoId: true,
      coto: { select: { nombre: true, zonaHoraria: true } },
    },
  });
  if (!c?.publicado) return { resultado: 'fin', enviados: 0 };

  const zona = c.coto.zonaHoraria;
  const { dia } = horaLocal(ahora, zona);
  if (c.prioridad !== 'urgente' && enSilencio(ahora, zona)) {
    await params.reencolar(params.payload, {
      jobId: `notif-${comunicadoId}-silencio-${dia}`,
      delayMs: msHastaLas7(ahora, zona),
    });
    return { resultado: 'silencio', enviados: 0 };
  }

  // Calentamiento del chip: nunca reclamar más destinatarios que el cupo de WhatsApp que queda hoy.
  const instancia = params.whatsapp
    ? await params.prisma.evolutionInstance.findFirst({
        where: { cotoId: c.cotoId, activo: true },
        select: { instanceName: true, chipActivadoEn: true },
      })
    : null;
  let cupo = LOTE_NOTIFICACIONES;
  if (params.whatsapp && instancia) {
    const antiguedadDias = Math.floor((ahora.getTime() - instancia.chipActivadoEn.getTime()) / 86_400_000);
    const enviados = await params.whatsapp.enviadosHoy(instancia.instanceName, dia);
    const { limiteMaximo } = checkWarmupLimit(antiguedadDias, enviados);
    cupo = Math.min(cupo, limiteMaximo - enviados);
    if (cupo <= 0) {
      await params.reencolar(params.payload, {
        jobId: `notif-${comunicadoId}-cupo-${dia}`,
        delayMs: msHastaLas7(ahora, zona),
      });
      return { resultado: 'limite_whatsapp', enviados: 0 };
    }
  }

  const lote = await params.prisma.$queryRaw<Destinatario[]>`
    UPDATE comunicados_lectura l
       SET notificado_en = now()
      FROM usuarios us
     WHERE l.comunicado_id = ${comunicadoId}::uuid
       AND us.id = l.usuario_id
       AND l.usuario_id IN (
         SELECT x.usuario_id FROM comunicados_lectura x
          WHERE x.comunicado_id = ${comunicadoId}::uuid AND x.notificado_en IS NULL
          ORDER BY x.usuario_id
          LIMIT ${cupo}::int
            FOR UPDATE SKIP LOCKED)
    RETURNING l.usuario_id, us.email::text AS email, us.telefono, us.telefono_verificado, us.notif_correo, us.notif_whatsapp
  `;

  const textoWhatsapp = `*${c.titulo}*\n\n${c.cuerpo}`;
  let enviados = 0;
  for (const d of lote) {
    if (d.notif_correo && params.encolarCorreo) {
      await params.encolarCorreo(
        { plantilla: 'aviso', para: d.email, datos: { titulo: c.titulo, coto: c.coto.nombre, mensaje: c.cuerpo } },
        { jobId: `com-${comunicadoId}-${d.usuario_id}` },
      );
    }
    if (params.whatsapp && instancia && d.notif_whatsapp && d.telefono_verificado && d.telefono) {
      try {
        await params.whatsapp.enviarTexto(instancia.instanceName, numeroWhatsapp(d.telefono), textoWhatsapp);
        await params.whatsapp.registrarEnvio(instancia.instanceName, dia);
        await params.whatsapp.esperar(calculateInterMessageDelay());
      } catch (err) {
        params.log.warn({ err, comunicadoId }, 'aviso WhatsApp no entregado');
      }
    }
    enviados += 1;
  }

  const ultimo = lote.at(-1);
  if (lote.length === cupo && ultimo) {
    await params.reencolar(params.payload, { jobId: `notif-${comunicadoId}-${ultimo.usuario_id}` });
    params.log.info({ comunicadoId, enviados }, 'lote de comunicado enviado');
    return { resultado: 'lote', enviados };
  }
  params.log.info({ comunicadoId, enviados }, 'comunicado notificado');
  return { resultado: 'fin', enviados };
}

export function iniciarNotificaciones(opts: {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  redis: Redis;
  log: Logger;
  encolarCorreo?: EncoladorCorreoWorker;
  evolution?: Pick<EvolutionApiClient, 'sendTextMessage'>;
}) {
  const queue = new Queue('notificaciones', { connection: opts.connection });
  const reencolar: ReencoladorNotificaciones = async (payload, o) => {
    await queue.add('notificaciones', payload, {
      jobId: o.jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
      ...(o.delayMs ? { delay: o.delayMs } : {}),
    });
  };
  const evolution = opts.evolution;
  const whatsapp: CanalWhatsapp | undefined = evolution
    ? {
        enviarTexto: async (instancia, numero, texto) => {
          await evolution.sendTextMessage(instancia, numero, texto);
        },
        enviadosHoy: async (instancia, dia) => Number((await opts.redis.get(`wa:enviados:${instancia}:${dia}`)) ?? 0),
        registrarEnvio: async (instancia, dia) => {
          const llave = `wa:enviados:${instancia}:${dia}`;
          await opts.redis.multi().incr(llave).expire(llave, 172_800).exec();
        },
        esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
      }
    : undefined;

  const worker = new Worker(
    'notificaciones',
    async (job: Pick<Job, 'data'>) =>
      procesarNotificacion({
        prisma: opts.prisma,
        payload: Colas.notificaciones.parse(job.data),
        reencolar,
        log: opts.log,
        ...(opts.encolarCorreo ? { encolarCorreo: opts.encolarCorreo } : {}),
        ...(whatsapp ? { whatsapp } : {}),
      }),
    // Una instancia de WhatsApp por coto y retardos de minutos por lote: concurrencia baja a propósito.
    { connection: opts.connection, concurrency: 2, lockDuration: 120_000 },
  );
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'notificaciones: job fallido'));
  return { queue, worker };
}
