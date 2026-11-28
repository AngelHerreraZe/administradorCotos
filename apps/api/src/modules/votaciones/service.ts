import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls, conIdempotencia } from '../../lib/prisma.ts';
import type { CrearVotacion, EmitirVoto, ResultadosDto, VotacionDto } from './schemas.ts';

const select = {
  id: true,
  cotoId: true,
  titulo: true,
  ponderadaPorIndiviso: true,
  fechaInicio: true,
  fechaFin: true,
  estado: true,
  createdAt: true,
  opciones: { select: { id: true, texto: true }, orderBy: { texto: 'asc' } },
} as const;

function aDto(r: Prisma.VotacionGetPayload<{ select: typeof select }>): z.infer<typeof VotacionDto> {
  return {
    ...r,
    estado: r.estado as z.infer<typeof VotacionDto>['estado'],
    fechaInicio: r.fechaInicio.toISOString(),
    fechaFin: r.fechaFin.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

/** RLS: solo administración. Nace en `borrador`; `abrir` la programa o activa. */
export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearVotacion>,
  idempotencyKey?: string,
) {
  const clave = idempotencyKey ? `vot:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.votacion.create({
        data: {
          cotoId,
          titulo: datos.titulo,
          fechaInicio: new Date(datos.fechaInicio),
          fechaFin: new Date(datos.fechaFin),
          ponderadaPorIndiviso: datos.ponderadaPorIndiviso,
          opciones: { create: datos.opciones.map((texto) => ({ cotoId, texto })) },
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select,
      }),
    () => (clave ? tx.votacion.findUnique({ where: { claveIdempotencia: clave }, select }) : Promise.resolve(null)),
  );
  return { creado: res.creado, dato: aDto(res.dato) };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  q: { estado?: string | undefined; limite: number; cursor?: string | undefined },
) {
  const filas = await tx.votacion.findMany({
    where: { cotoId, ...(q.estado ? { estado: q.estado } : {}) },
    orderBy: [{ fechaInicio: 'desc' }, { id: 'asc' }],
    take: q.limite + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select,
  });
  const siguiente = filas.length > q.limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), ...(siguiente ? { siguiente } : {}) };
}

async function visible(tx: Prisma.TransactionClient, id: string) {
  const v = await tx.votacion.findUnique({
    where: { id },
    select: { estado: true, fechaInicio: true, fechaFin: true },
  });
  if (!v) throw new AppError(404, 'votacion_no_encontrada', 'Votación no encontrada');
  return v;
}

/** Borrador → `programada` (abre sola en `fechaInicio`) o `activa` si ya empezó. */
export async function abrir(tx: Prisma.TransactionClient, id: string, ahora = new Date()) {
  const v = await visible(tx, id);
  if (v.estado !== 'borrador') throw new AppError(409, 'estado_invalido', 'Solo se abre una votación en borrador');
  if (v.fechaFin <= ahora) throw new AppError(422, 'votacion_vencida', 'La fecha de cierre ya pasó');
  const fila = await actualizarConRls(() =>
    tx.votacion.update({
      where: { id },
      data: { estado: v.fechaInicio > ahora ? 'programada' : 'activa' },
      select,
    }),
  );
  return aDto(fila);
}

export async function cerrar(tx: Prisma.TransactionClient, id: string) {
  const v = await visible(tx, id);
  if (v.estado !== 'activa' && v.estado !== 'programada') {
    throw new AppError(409, 'estado_invalido', 'Solo se cierra una votación programada o activa');
  }
  const fila = await actualizarConRls(() => tx.votacion.update({ where: { id }, data: { estado: 'cerrada' }, select }));
  return aDto(fila);
}

/** `app.votar` decide: propietario de la unidad, votación activa, un voto por unidad (UA409). */
export async function votar(tx: Prisma.TransactionClient, id: string, datos: z.infer<typeof EmitirVoto>) {
  const [r] = await tx.$queryRaw<{ id: string }[]>`
    SELECT app.votar(${id}::uuid, ${datos.opcionId}::uuid, ${datos.unidadId}::uuid) AS id`;
  if (!r) throw new AppError(422, 'voto_no_registrado', 'No se pudo registrar el voto');
  return { votoId: r.id };
}

/** Solo staff y solo agregados (`app.resultados_votacion`, DEFINER). */
export async function resultados(tx: Prisma.TransactionClient, id: string): Promise<z.infer<typeof ResultadosDto>> {
  const filas = await tx.$queryRaw<
    {
      opcion_id: string;
      opcion: string;
      votos: number;
      peso: { toString(): string };
      unidades_votantes: number;
      unidades_totales: number;
      indiviso_votante: { toString(): string };
    }[]
  >`SELECT * FROM app.resultados_votacion(${id}::uuid)`;
  const primera = filas[0];
  if (!primera) throw new AppError(404, 'votacion_no_encontrada', 'Votación no encontrada');
  return {
    votacionId: id,
    opciones: filas.map((f) => ({ opcionId: f.opcion_id, opcion: f.opcion, votos: f.votos, peso: f.peso.toString() })),
    unidadesVotantes: primera.unidades_votantes,
    unidadesTotales: primera.unidades_totales,
    indivisoVotante: primera.indiviso_votante.toString(),
  };
}
