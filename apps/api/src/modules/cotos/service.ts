import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls } from '../../lib/prisma.ts';
import type { ActualizarCoto, Coto } from './schemas.ts';

export const selectCoto = {
  id: true,
  orgId: true,
  nombre: true,
  slug: true,
  zonaHoraria: true,
  direccion: true,
  colonia: true,
  ciudad: true,
  estado: true,
  cp: true,
  tipo: true,
  regimenLegal: true,
  diaCorte: true,
  diaLimitePago: true,
  tasaMoratoria: true,
  tipoMoratoria: true,
  baseMoratoria: true,
  descuentoProntoPago: true,
  diasGracia: true,
  bloquearAmenidadesMorosos: true,
  mesesMorosidadBloqueo: true,
  rfcCoto: true,
  razonSocialCoto: true,
  regimenFiscal: true,
  cpFiscal: true,
  activo: true,
} as const;

export function aDto(c: Prisma.CotoGetPayload<{ select: typeof selectCoto }>): z.infer<typeof Coto> {
  return {
    ...c,
    baseMoratoria: c.baseMoratoria as 'capital' | 'saldo',
    tasaMoratoria: c.tasaMoratoria.toString(),
    descuentoProntoPago: c.descuentoProntoPago.toString(),
  };
}

export async function obtener(tx: Prisma.TransactionClient, cotoId: string): Promise<z.infer<typeof Coto>> {
  const coto = await tx.coto.findUnique({ where: { id: cotoId }, select: selectCoto });
  if (!coto) throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  return aDto(coto);
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof ActualizarCoto>,
): Promise<z.infer<typeof Coto>> {
  await obtener(tx, cotoId);
  const actualizado = await actualizarConRls(() =>
    tx.coto.update({ where: { id: cotoId }, data: datos, select: selectCoto }),
  );
  return aDto(actualizado);
}
