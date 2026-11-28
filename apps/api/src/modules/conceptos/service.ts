import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls } from '../../lib/prisma.ts';
import type { ActualizarConcepto, Concepto, CrearConcepto } from './schemas.ts';

const selectConcepto = {
  id: true,
  cotoId: true,
  nombre: true,
  tipo: true,
  montoDefault: true,
  usaIndiviso: true,
  esRecurrente: true,
  activo: true,
} as const;

function aDto(row: Prisma.ConceptoCargoGetPayload<{ select: typeof selectConcepto }>): z.infer<typeof Concepto> {
  return {
    ...row,
    tipo: row.tipo as z.infer<typeof Concepto>['tipo'],
    montoDefault: row.montoDefault?.toString() ?? null,
  };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  filtro: { activo?: 'true' | 'false' | undefined; limite: number; cursor?: string | undefined },
): Promise<{ datos: z.infer<typeof Concepto>[]; siguiente?: string }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_miembro())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar conceptos de este coto');

  const filas = await tx.conceptoCargo.findMany({
    where: {
      cotoId,
      ...(filtro.activo !== undefined ? { activo: filtro.activo === 'true' } : {}),
    },
    orderBy: [{ nombre: 'asc' }, { id: 'asc' }],
    take: filtro.limite + 1,
    ...(filtro.cursor ? { cursor: { id: filtro.cursor }, skip: 1 } : {}),
    select: selectConcepto,
  });
  const siguiente = filas.length > filtro.limite ? filas.pop()?.id : undefined;
  return {
    datos: filas.map(aDto),
    ...(siguiente ? { siguiente } : {}),
  };
}

export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof CrearConcepto>,
): Promise<z.infer<typeof Concepto>> {
  const row = await tx.conceptoCargo.create({
    data: {
      cotoId,
      nombre: datos.nombre,
      tipo: datos.tipo,
      ...(datos.montoDefault !== undefined ? { montoDefault: datos.montoDefault } : {}),
      usaIndiviso: datos.usaIndiviso,
      esRecurrente: datos.esRecurrente,
    },
    select: selectConcepto,
  });
  return aDto(row);
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  id: string,
  datos: z.infer<typeof ActualizarConcepto>,
): Promise<z.infer<typeof Concepto>> {
  const actual = await tx.conceptoCargo.findFirst({ where: { id, cotoId }, select: { id: true } });
  if (!actual) throw new AppError(404, 'concepto_no_encontrado', 'Concepto no encontrado');

  const data: Prisma.ConceptoCargoUpdateInput = {};
  if (datos.nombre !== undefined) data.nombre = datos.nombre;
  if (datos.tipo !== undefined) data.tipo = datos.tipo;
  if (datos.montoDefault !== undefined) data.montoDefault = datos.montoDefault;
  if (datos.usaIndiviso !== undefined) data.usaIndiviso = datos.usaIndiviso;
  if (datos.esRecurrente !== undefined) data.esRecurrente = datos.esRecurrente;
  if (datos.activo !== undefined) data.activo = datos.activo;

  const row = await actualizarConRls(() => tx.conceptoCargo.update({ where: { id }, data, select: selectConcepto }));
  return aDto(row);
}
