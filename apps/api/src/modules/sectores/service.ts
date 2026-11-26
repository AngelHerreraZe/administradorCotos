import type { Prisma } from '@admcotos/db';
import { AppError, Uuid } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls } from '../../lib/prisma.ts';
import type { ActualizarSector, CrearSector, Sector } from './schemas.ts';

const selectSector = { id: true, cotoId: true, nombre: true, tipo: true, orden: true, activo: true } as const;

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  limite: number,
  cursor?: string,
): Promise<{ datos: z.infer<typeof Sector>[]; siguiente?: string }> {
  if (cursor && !Uuid.safeParse(cursor).success) {
    throw new AppError(422, 'validacion', 'Cursor inválido');
  }
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_miembro())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para ver este coto');

  const filas = await tx.sector.findMany({
    where: { cotoId },
    orderBy: [{ orden: 'asc' }, { nombre: 'asc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: selectSector,
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas, siguiente };
}

export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof CrearSector>,
): Promise<z.infer<typeof Sector>> {
  return tx.sector.create({ data: { cotoId, ...datos }, select: selectSector });
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  id: string,
  datos: z.infer<typeof ActualizarSector>,
): Promise<z.infer<typeof Sector>> {
  const actual = await tx.sector.findFirst({ where: { id, cotoId }, select: { id: true } });
  if (!actual) throw new AppError(404, 'sector_no_encontrado', 'Sector no encontrado');
  return actualizarConRls(() => tx.sector.update({ where: { id }, data: datos, select: selectSector }));
}
