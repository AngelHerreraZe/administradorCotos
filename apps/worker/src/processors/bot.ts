import crypto from 'node:crypto';
import { type ClienteIa, clasificarIntencion, extraerComprobante, type Intencion } from '@admcotos/ai';
import { type Prisma, type PrismaClient, withTenant } from '@admcotos/db';
import { Colas, type PayloadWhatsappEntrante } from '@admcotos/shared';
import { llaveParaArchivo, TIPOS_ARCHIVO_PERMITIDOS, type TipoArchivoPermitido } from '@admcotos/storage';
import { calculateTypingTime, type EvolutionApiClient } from '@admcotos/whatsapp';
import { type ConnectionOptions, type Job, Worker } from 'bullmq';
import type { Logger } from 'pino';

export interface DepsBot {
  /** Conexión con rol app_service: el bot solo ve lo que vería el residente (RLS). */
  prisma: PrismaClient;
  ia: ClienteIa;
  modelo: string;
  evolution: Pick<EvolutionApiClient, 'sendTextMessage' | 'setPresence' | 'getBase64FromMediaMessage'>;
  subir: (llave: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  esperar?: (ms: number) => Promise<void>;
  log: Logger;
}

const MAX_BYTES = 10 * 1024 * 1024;

const AYUDA = [
  'Hola, soy el asistente de tu coto. Puedo ayudarte con:',
  '• "¿Cuánto debo?" para tu estado de cuenta',
  '• Enviar la foto de tu comprobante de transferencia',
  '• Reportar un problema (fuga, luminaria, ruido…)',
  '• Ver votaciones abiertas',
].join('\n');

type Accion = 'desconocido' | 'comprobante' | Intencion['intencion'];

/**
 * 1. instancia → coto y teléfono → residente con `app.bot_resolver` (solo verificados).
 * 2. Todo lo demás con `withTenant` como ese residente: la IA solo clasifica; nunca elige unidad, coto ni montos.
 * Ni el texto ni el teléfono van a logs.
 */
export async function procesarMensajeBot(deps: DepsBot, msg: PayloadWhatsappEntrante): Promise<{ accion: Accion }> {
  const [quien] = await deps.prisma.$queryRaw<{ coto_id: string; usuario_id: string }[]>`
    SELECT coto_id, usuario_id FROM app.bot_resolver(${msg.instancia}, ${msg.telefono})`;
  if (!quien) {
    // Número no registrado o no verificado: no se responde (no confirma que el bot exista).
    deps.log.info({ instancia: msg.instancia }, 'bot: remitente no resuelto');
    return { accion: 'desconocido' };
  }
  const ctx = { userId: quien.usuario_id, cotoId: quien.coto_id, aal: 'aal1' as const };
  const enTenant: EnTenant = (fn) => withTenant(deps.prisma, ctx, fn);

  let accion: Accion;
  let respuesta: string;
  if (msg.media) {
    accion = 'comprobante';
    respuesta = await registrarComprobante(deps, msg, quien.coto_id, enTenant);
  } else {
    const texto = msg.texto ?? '';
    const intencion = await clasificarIntencion(texto, deps.ia, deps.modelo).catch(
      (): Intencion => ({ intencion: 'otro', resumen: '' }),
    );
    accion = intencion.intencion;
    respuesta = await responderIntencion(intencion, texto, ctx, enTenant);
  }

  await deps.evolution.setPresence(msg.instancia, msg.telefono, 'composing').catch(() => undefined);
  await (deps.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(calculateTypingTime(respuesta.length));
  await deps.evolution.sendTextMessage(msg.instancia, msg.telefono, respuesta);
  deps.log.info({ cotoId: quien.coto_id, accion }, 'bot: mensaje atendido');
  return { accion };
}

type EnTenant = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

async function responderIntencion(
  intencion: Intencion,
  texto: string,
  ctx: { userId: string; cotoId: string },
  enTenant: EnTenant,
): Promise<string> {
  switch (intencion.intencion) {
    case 'estado_cuenta': {
      const filas = await enTenant(
        (tx) =>
          tx.$queryRaw<{ numero: string; total: { toString(): string } | null; vencidos: number }[]>`
          SELECT u.numero::text AS numero,
                 (SELECT max(e.total_pendiente) FROM app.estado_cuenta(u.id) e) AS total,
                 (SELECT count(*)::int FROM app.estado_cuenta(u.id) e WHERE e.vencido) AS vencidos
            FROM unidades u
           WHERE u.id = ANY (app.unidades_propias())
           ORDER BY u.numero`,
      );
      if (!filas.length) return 'No encontramos unidades a tu nombre como propietario en este coto.';
      return filas
        .map((f) =>
          f.total
            ? `Unidad ${f.numero}: saldo pendiente $${f.total.toString()} MXN${f.vencidos ? ` (${f.vencidos} vencido(s))` : ''}.`
            : `Unidad ${f.numero}: estás al corriente.`,
        )
        .join('\n');
    }
    case 'ticket':
    case 'humano': {
      const ticket = await enTenant(async (tx) => {
        const unidades = await tx.$queryRaw<{ id: string }[]>`SELECT unnest(app.unidades_mias()) AS id`;
        return tx.ticket.create({
          data: {
            cotoId: ctx.cotoId,
            reportadoPor: ctx.userId,
            titulo: (intencion.resumen || 'Reporte por WhatsApp').slice(0, 200),
            descripcion: texto.slice(0, 5_000) || '(sin texto)',
            categoria: intencion.intencion === 'humano' ? 'whatsapp_humano' : 'whatsapp',
            ...(unidades.length === 1 && unidades[0] ? { unidadId: unidades[0].id } : {}),
          },
          select: { numero: true },
        });
      });
      return intencion.intencion === 'humano'
        ? `Listo, una persona de la administración te contactará. Folio #${ticket.numero}.`
        : `Registramos tu reporte con folio #${ticket.numero}. Te avisaremos cuando avance.`;
    }
    case 'votaciones': {
      const abiertas = await enTenant((tx) =>
        tx.votacion.findMany({
          where: { cotoId: ctx.cotoId, estado: 'activa' },
          select: { titulo: true, fechaFin: true },
          orderBy: { fechaFin: 'asc' },
          take: 5,
        }),
      );
      if (!abiertas.length) return 'No hay votaciones abiertas en este momento.';
      // ponytail: el voto se emite en la app (elegir opción por chat exigiría estado de conversación).
      return `Votaciones abiertas:\n${abiertas.map((v) => `• ${v.titulo} (cierra ${v.fechaFin.toISOString().slice(0, 10)})`).join('\n')}\nVota desde la app.`;
    }
    case 'visita':
      return 'Las invitaciones de visita se generan desde la app, en la sección Accesos.';
    default:
      return AYUDA;
  }
}

async function registrarComprobante(
  deps: DepsBot,
  msg: PayloadWhatsappEntrante,
  cotoId: string,
  enTenant: EnTenant,
): Promise<string> {
  const media = await deps.evolution.getBase64FromMediaMessage(msg.instancia, msg.mensajeId);
  const mime = media.mimetype.split(';')[0]?.trim() ?? '';
  const bytes = Buffer.from(media.base64, 'base64');
  if (!(TIPOS_ARCHIVO_PERMITIDOS as readonly string[]).includes(mime) || bytes.length > MAX_BYTES) {
    return 'Solo puedo leer comprobantes en imagen (JPG, PNG, WEBP) o PDF de hasta 10 MB.';
  }

  // La unidad sale de RLS, nunca del mensaje ni de la IA: con más de una, se pide usar la app.
  const contexto = await enTenant(async (tx) => {
    const unidades = await tx.$queryRaw<{ id: string }[]>`SELECT unnest(app.unidades_propias()) AS id`;
    const coto = await tx.coto.findUnique({ where: { id: cotoId }, select: { orgId: true } });
    return { unidades, orgId: coto?.orgId };
  });
  const unidad = contexto.unidades.length === 1 ? contexto.unidades[0] : undefined;
  if (!unidad || !contexto.orgId) {
    return 'Para registrar tu pago por aquí necesitas ser propietario de una sola unidad. Regístralo desde la app.';
  }

  const datos = await extraerComprobante({ base64: media.base64, mimeType: mime }, deps.ia, deps.modelo).catch(
    () => null,
  );
  if (!datos?.monto) return 'No pude leer el monto del comprobante. Regístralo desde la app, por favor.';

  const llave = llaveParaArchivo(contexto.orgId, cotoId, 'comprobantes', mime as TipoArchivoPermitido);
  await deps.subir(llave, bytes, mime);
  const monto = datos.monto;
  try {
    await enTenant((tx) =>
      tx.pago.create({
        data: {
          cotoId,
          unidadId: unidad.id,
          monto,
          metodo: 'transferencia_manual',
          gateway: 'manual',
          comprobanteUrl: llave,
          estado: 'en_revision', // la sugerencia del OCR nunca confirma un pago
          claveIdempotencia: `wa:${crypto.createHash('sha256').update(`${msg.instancia}:${msg.mensajeId}`).digest('hex').slice(0, 64)}`,
          notas: [
            'Sugerido por OCR (WhatsApp)',
            datos.banco,
            datos.cuentaDestinoUltimos4 && `cta ****${datos.cuentaDestinoUltimos4}`,
          ]
            .filter(Boolean)
            .join(' · ')
            .slice(0, 300),
          ...(datos.fecha ? { fechaPago: new Date(`${datos.fecha}T12:00:00Z`) } : {}),
          ...(datos.claveRastreo ? { claveRastreo: datos.claveRastreo } : {}),
        },
        select: { id: true },
      }),
    );
  } catch (err) {
    // ponytail: el objeto ya subido queda huérfano en este caso; lo limpia la retención del bucket.
    if ((err as { code?: string }).code === 'P2002') {
      return 'Ese comprobante ya estaba registrado. Si crees que es un error, escribe "hablar con alguien".';
    }
    throw err;
  }
  return `Recibimos tu comprobante por $${monto} MXN. Quedó en revisión; la administración lo confirmará.`;
}

export function iniciarBot(opts: DepsBot & { connection: ConnectionOptions }) {
  const worker = new Worker(
    'whatsappEntrante',
    (job: Pick<Job, 'data'>) => procesarMensajeBot(opts, Colas.whatsappEntrante.parse(job.data)),
    { connection: opts.connection, concurrency: 4 },
  );
  // Sin `job.data` en el log: contiene el mensaje y el teléfono del residente.
  worker.on('failed', (job, err) => opts.log.error({ err: { name: err.name }, jobId: job?.id }, 'bot: job fallido'));
  return { worker };
}
