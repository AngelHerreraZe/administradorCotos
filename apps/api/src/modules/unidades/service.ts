import type { Readable } from 'node:stream';
import type { Prisma } from '@admcotos/db';
import { AppError, Uuid } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { parse } from 'csv-parse';
import { actualizarConRls } from '../../lib/prisma.ts';
import {
  type ActualizarUnidad,
  type CrearUnidad,
  IndivisoRegex,
  SuperficieRegex,
  TipoUnidad,
  type Unidad,
} from './schemas.ts';

const MAX_FILAS_CSV = 5_000;

const columnas = {
  id: true,
  cotoId: true,
  sectorId: true,
  numero: true,
  tipo: true,
  superficieM2: true,
  indiviso: true,
  ocupada: true,
  activo: true,
} as const;

export interface FilaCsvValidada {
  fila: number;
  numero: string;
  tipo: string;
  sectorNombre: string | null;
  indiviso: string | null;
  superficieM2: string | null;
  ocupada: boolean;
}

function aDto(u: Prisma.UnidadGetPayload<{ select: typeof columnas }>): z.infer<typeof Unidad> {
  return {
    ...u,
    tipo: u.tipo as z.infer<typeof Unidad>['tipo'],
    superficieM2: u.superficieM2?.toString() ?? null,
    indiviso: u.indiviso?.toString() ?? null,
  };
}

export async function crear(tx: Prisma.TransactionClient, cotoId: string, datos: z.infer<typeof CrearUnidad>) {
  const u = await tx.unidad.create({ data: { cotoId, ...datos }, select: columnas });
  return aDto(u);
}

export async function listar(tx: Prisma.TransactionClient, cotoId: string, limite: number, cursor?: string) {
  if (cursor && !Uuid.safeParse(cursor).success) {
    throw new AppError(422, 'validacion', 'Cursor inválido');
  }
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (
         ${cotoId}::uuid = ANY (app.cotos_staff())
      OR ${cotoId}::uuid = ANY (app.cotos_guardia())
      OR EXISTS (SELECT 1 FROM unidades u WHERE u.coto_id = ${cotoId}::uuid AND u.id = ANY (app.unidades_mias()))
    ) AS ok
  `;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar unidades de este coto');

  const filas = await tx.unidad.findMany({
    where: { cotoId },
    orderBy: [{ numero: 'asc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: columnas,
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), siguiente };
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  id: string,
  datos: z.infer<typeof ActualizarUnidad>,
) {
  const actual = await tx.unidad.findFirst({ where: { id, cotoId }, select: { id: true } });
  if (!actual) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada');
  const u = await actualizarConRls(() => tx.unidad.update({ where: { id }, data: datos, select: columnas }));
  return aDto(u);
}

function parseBoolCsv(raw: string | undefined): boolean | undefined {
  if (!raw) return true;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'si', 'sí'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  return undefined;
}

/**
 * Lee y valida sintácticamente el stream CSV fuera de cualquier transacción de BD
 * para no mantener conexiones ni bloqueos abiertos durante la transferencia HTTP.
 */
export async function parsearCsvUnidades(
  stream: Readable,
): Promise<{ filas: FilaCsvValidada[]; erroresSintaxis: { path: string; message: string }[] }> {
  const erroresSintaxis: { path: string; message: string }[] = [];
  const filas: FilaCsvValidada[] = [];
  const numerosEnCsv = new Set<string>();

  const parser = stream.pipe(
    parse({
      columns: true,
      trim: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
    }),
  );

  let filaNum = 0;
  try {
    for await (const raw of parser as AsyncIterable<Record<string, string | undefined>>) {
      filaNum += 1;
      if (filaNum > MAX_FILAS_CSV) {
        throw new AppError(422, 'demasiadas_filas', `El archivo supera el máximo de ${MAX_FILAS_CSV} filas`);
      }

      const numero = (raw.numero ?? '').trim();
      if (!numero || numero.length > 20) {
        erroresSintaxis.push({ path: `fila:${filaNum}.numero`, message: 'Número requerido (1 a 20 caracteres)' });
      } else {
        const clave = numero.toLowerCase();
        if (numerosEnCsv.has(clave)) {
          erroresSintaxis.push({ path: `fila:${filaNum}.numero`, message: `Número duplicado en el CSV: "${numero}"` });
        }
        numerosEnCsv.add(clave);
      }

      const tipoRaw = (raw.tipo ?? '').trim().toLowerCase() || 'casa';
      const tipoParsed = TipoUnidad.safeParse(tipoRaw);
      if (!tipoParsed.success) {
        erroresSintaxis.push({ path: `fila:${filaNum}.tipo`, message: `Tipo inválido: "${tipoRaw}"` });
      }

      const indivisoRaw = (raw.indiviso ?? '').trim();
      if (indivisoRaw && !IndivisoRegex.test(indivisoRaw)) {
        erroresSintaxis.push({ path: `fila:${filaNum}.indiviso`, message: 'Indiviso debe ser decimal > 0 y <= 1' });
      }

      const supRaw = (raw.superficie_m2 ?? raw.superficieM2 ?? '').trim();
      if (supRaw && !SuperficieRegex.test(supRaw)) {
        erroresSintaxis.push({ path: `fila:${filaNum}.superficieM2`, message: 'Superficie inválida' });
      }

      const ocupada = parseBoolCsv(raw.ocupada);
      if (ocupada === undefined) {
        erroresSintaxis.push({
          path: `fila:${filaNum}.ocupada`,
          message: 'Valor inválido para ocupada (usa true/false)',
        });
      }

      const sectorRaw = (raw.sector ?? '').trim();
      if (tipoParsed.success && ocupada !== undefined && numero) {
        filas.push({
          fila: filaNum,
          numero,
          tipo: tipoParsed.data,
          sectorNombre: sectorRaw || null,
          indiviso: indivisoRaw || null,
          superficieM2: supRaw || null,
          ocupada,
        });
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(422, 'csv_invalido', 'El archivo CSV no tiene un formato válido');
  }

  if (filaNum === 0) {
    throw new AppError(422, 'csv_vacio', 'El archivo CSV no contiene filas de datos');
  }

  return { filas, erroresSintaxis };
}

export async function importar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  parsed: { filas: FilaCsvValidada[]; erroresSintaxis: { path: string; message: string }[] },
): Promise<{ creadas: number }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para importar unidades en este coto');

  const [sectores, existentes] = await Promise.all([
    tx.sector.findMany({ where: { cotoId }, select: { id: true, nombre: true } }),
    tx.unidad.findMany({ where: { cotoId }, select: { numero: true } }),
  ]);
  const sectoresPorNombre = new Map(sectores.map((s) => [s.nombre.trim().toLowerCase(), s.id]));
  const numerosExistentes = new Set(existentes.map((u) => u.numero.trim().toLowerCase()));

  const errores = [...parsed.erroresSintaxis];
  const porInsertar: {
    cotoId: string;
    numero: string;
    tipo: string;
    sectorId: string | null;
    indiviso: string | null;
    superficieM2: string | null;
    ocupada: boolean;
  }[] = [];

  for (const f of parsed.filas) {
    if (numerosExistentes.has(f.numero.toLowerCase())) {
      errores.push({ path: `fila:${f.fila}.numero`, message: `La unidad "${f.numero}" ya existe en el coto` });
    }
    let sectorId: string | null = null;
    if (f.sectorNombre) {
      const encontrado = sectoresPorNombre.get(f.sectorNombre.toLowerCase());
      if (!encontrado) {
        errores.push({ path: `fila:${f.fila}.sector`, message: `Sector inexistente: "${f.sectorNombre}"` });
      } else {
        sectorId = encontrado;
      }
    }
    porInsertar.push({
      cotoId,
      numero: f.numero,
      tipo: f.tipo,
      sectorId,
      indiviso: f.indiviso,
      superficieM2: f.superficieM2,
      ocupada: f.ocupada,
    });
  }

  if (errores.length > 0) {
    throw new AppError(422, 'csv_con_errores', 'El archivo CSV contiene errores de validación', undefined, errores);
  }

  const res = await tx.unidad.createMany({ data: porInsertar });
  return { creadas: res.count };
}
