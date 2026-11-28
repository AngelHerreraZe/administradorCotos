import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import { validarLlaveObjeto } from '@admcotos/storage';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls, conIdempotencia } from '../../lib/prisma.ts';
import type { StorageService } from '../../types.ts';
import type {
  ActualizarTicket,
  ComentarioDto,
  CrearComentario,
  CrearTicket,
  SolicitarUrlAdjunto,
  TicketDto,
} from './schemas.ts';

const select = {
  id: true,
  cotoId: true,
  unidadId: true,
  reportadoPor: true,
  numero: true,
  titulo: true,
  descripcion: true,
  categoria: true,
  estado: true,
  adjuntos: true,
  slaVenceEn: true,
  slaVencido: true,
  createdAt: true,
  updatedAt: true,
} as const;

function aDto(r: Prisma.TicketGetPayload<{ select: typeof select }>): z.infer<typeof TicketDto> {
  return {
    ...r,
    estado: r.estado as z.infer<typeof TicketDto>['estado'],
    adjuntos: r.adjuntos.length,
    slaVenceEn: r.slaVenceEn.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const selectComentario = {
  id: true,
  ticketId: true,
  usuarioId: true,
  comentario: true,
  esInterno: true,
  createdAt: true,
} as const;

function comentarioDto(
  r: Prisma.TicketComentarioGetPayload<{ select: typeof selectComentario }>,
): z.infer<typeof ComentarioDto> {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

async function orgDelCoto(tx: Prisma.TransactionClient, cotoId: string): Promise<string> {
  const coto = await tx.coto.findUnique({ where: { id: cotoId }, select: { orgId: true } });
  if (!coto) throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  return coto.orgId;
}

async function ticketVisible(tx: Prisma.TransactionClient, id: string) {
  const t = await tx.ticket.findUnique({ where: { id }, select: { id: true, cotoId: true, adjuntos: true } });
  if (!t) throw new AppError(404, 'ticket_no_encontrado', 'Ticket no encontrado');
  return t;
}

/** RLS: cualquier miembro reporta a su nombre; la unidad debe ser suya (o la administración). */
export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearTicket>,
  idempotencyKey?: string,
) {
  let adjuntos: string[] = [];
  if (datos.adjuntos?.length) {
    const prefijo = `${(await orgDelCoto(tx, cotoId)).toLowerCase()}/${cotoId.toLowerCase()}/tickets/`;
    adjuntos = datos.adjuntos.map(validarLlaveObjeto);
    if (adjuntos.some((k) => !k.startsWith(prefijo))) {
      throw new AppError(422, 'llave_invalida', 'Un adjunto no corresponde a este coto');
    }
  }
  const clave = idempotencyKey ? `ticket:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.ticket.create({
        data: {
          cotoId,
          reportadoPor: usuarioId,
          titulo: datos.titulo,
          descripcion: datos.descripcion,
          adjuntos,
          ...(datos.categoria ? { categoria: datos.categoria } : {}),
          ...(datos.unidadId ? { unidadId: datos.unidadId } : {}),
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select,
      }),
    () => (clave ? tx.ticket.findUnique({ where: { claveIdempotencia: clave }, select }) : Promise.resolve(null)),
  );
  return { creado: res.creado, dato: aDto(res.dato) };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  q: { estado?: string | undefined; limite: number; cursor?: string | undefined },
) {
  const filas = await tx.ticket.findMany({
    where: { cotoId, ...(q.estado ? { estado: q.estado } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: q.limite + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select,
  });
  const siguiente = filas.length > q.limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), ...(siguiente ? { siguiente } : {}) };
}

/** RLS: solo la administración cambia estado o categoría. */
export async function actualizar(tx: Prisma.TransactionClient, id: string, datos: z.infer<typeof ActualizarTicket>) {
  await ticketVisible(tx, id);
  const fila = await actualizarConRls(() =>
    tx.ticket.update({
      where: { id },
      data: {
        ...(datos.estado ? { estado: datos.estado } : {}),
        ...(datos.categoria !== undefined ? { categoria: datos.categoria } : {}),
      },
      select,
    }),
  );
  return aDto(fila);
}

export async function comentar(
  tx: Prisma.TransactionClient,
  ticketId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearComentario>,
  idempotencyKey?: string,
) {
  const t = await ticketVisible(tx, ticketId);
  const clave = idempotencyKey ? `ticket-com:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.ticketComentario.create({
        data: {
          cotoId: t.cotoId,
          ticketId,
          usuarioId,
          comentario: datos.comentario,
          esInterno: datos.esInterno,
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select: selectComentario,
      }),
    () =>
      clave
        ? tx.ticketComentario.findUnique({ where: { claveIdempotencia: clave }, select: selectComentario })
        : Promise.resolve(null),
  );
  return { creado: res.creado, dato: comentarioDto(res.dato) };
}

/** RLS oculta los comentarios internos a quien no es staff. */
export async function listarComentarios(tx: Prisma.TransactionClient, ticketId: string) {
  await ticketVisible(tx, ticketId);
  const filas = await tx.ticketComentario.findMany({
    where: { ticketId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: selectComentario,
  });
  return { datos: filas.map(comentarioDto) };
}

export async function urlSubidaAdjunto(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof SolicitarUrlAdjunto>,
  storage: StorageService,
) {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_miembro())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No perteneces a este coto');
  const llave = storage.llaveParaArchivo(await orgDelCoto(tx, cotoId), cotoId, 'tickets', datos.contentType);
  return storage.urlDeSubida({ llave, contentType: datos.contentType });
}

/** Descarga con URL de 2 minutos; la visibilidad la decide la RLS del ticket. */
export async function urlsAdjuntos(tx: Prisma.TransactionClient, ticketId: string, storage: StorageService) {
  const t = await ticketVisible(tx, ticketId);
  const urls = await Promise.all(t.adjuntos.map((llave) => storage.urlDeDescarga({ llave, ttlSegundos: 120 })));
  return { datos: urls.map((u) => u.url), expiraEnSegundos: 120 };
}
