import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { conIdempotencia } from '../../lib/prisma.ts';
import type { ComunicadoDto, CrearComunicado } from './schemas.ts';

const select = {
  id: true,
  cotoId: true,
  titulo: true,
  cuerpo: true,
  prioridad: true,
  dirigidoA: true,
  publicado: true,
  publicadoEn: true,
  createdAt: true,
} as const;

type Fila = Prisma.ComunicadoGetPayload<{ select: typeof select }> & { lecturas?: { leidoEn: Date | null }[] };

function aDto(r: Fila): z.infer<typeof ComunicadoDto> {
  return {
    id: r.id,
    cotoId: r.cotoId,
    titulo: r.titulo,
    cuerpo: r.cuerpo,
    prioridad: r.prioridad as 'normal' | 'urgente',
    dirigidoA: r.dirigidoA as z.infer<typeof ComunicadoDto>['dirigidoA'],
    publicado: r.publicado,
    publicadoEn: r.publicadoEn?.toISOString() ?? null,
    leidoEn: r.lecturas?.[0]?.leidoEn?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Crea un borrador. RLS: solo administración del coto. */
export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearComunicado>,
  idempotencyKey?: string,
) {
  const clave = idempotencyKey ? `com:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.comunicado.create({
        data: {
          cotoId,
          titulo: datos.titulo,
          cuerpo: datos.cuerpo,
          prioridad: datos.prioridad,
          dirigidoA: datos.dirigidoA,
          ...(datos.dirigidoA === 'sector' && datos.sectorId ? { sectorId: datos.sectorId } : {}),
          ...(datos.dirigidoA === 'unidades' && datos.unidadesIds ? { unidadesIds: datos.unidadesIds } : {}),
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select,
      }),
    () => (clave ? tx.comunicado.findUnique({ where: { claveIdempotencia: clave }, select }) : Promise.resolve(null)),
  );
  return { creado: res.creado, dato: aDto(res.dato) };
}

/** Lista lo visible: staff ve todo; el resto solo lo publicado que le llegó (RLS por `comunicados_lectura`). */
export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  limite: number,
  cursor?: string,
) {
  const filas = await tx.comunicado.findMany({
    where: { cotoId },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { ...select, lecturas: { where: { usuarioId }, select: { leidoEn: true } } },
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), ...(siguiente ? { siguiente } : {}) };
}

/**
 * Publica y materializa destinatarios en SQL (`app.publicar_comunicado`). Repetir la llamada no
 * vuelve a publicar: devuelve los mismos destinatarios para que la ruta reencole la notificación.
 */
export async function publicar(tx: Prisma.TransactionClient, id: string): Promise<{ destinatarios: number }> {
  const actual = await tx.comunicado.findUnique({ where: { id }, select: { publicado: true } });
  if (!actual) throw new AppError(404, 'comunicado_no_encontrado', 'Comunicado no encontrado');
  if (actual.publicado) {
    const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT c.coto_id = ANY (app.cotos_admin()) AS ok FROM comunicados c WHERE c.id = ${id}::uuid`;
    if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'Solo la administración puede publicar comunicados');
    return { destinatarios: await tx.comunicadoLectura.count({ where: { comunicadoId: id } }) };
  }
  const [r] = await tx.$queryRaw<{ n: number }[]>`SELECT app.publicar_comunicado(${id}::uuid) AS n`;
  return { destinatarios: r?.n ?? 0 };
}

/** Acuse de lectura de la persona que consulta (solo su propia fila). */
export async function marcarLeido(tx: Prisma.TransactionClient, id: string, usuarioId: string): Promise<void> {
  const fila = await tx.comunicadoLectura.findUnique({
    where: { comunicadoId_usuarioId: { comunicadoId: id, usuarioId } },
    select: { leidoEn: true },
  });
  if (!fila) throw new AppError(404, 'comunicado_no_encontrado', 'Comunicado no encontrado');
  if (!fila.leidoEn) {
    await tx.comunicadoLectura.update({
      where: { comunicadoId_usuarioId: { comunicadoId: id, usuarioId } },
      data: { leidoEn: new Date(), canal: 'app' },
    });
  }
}
