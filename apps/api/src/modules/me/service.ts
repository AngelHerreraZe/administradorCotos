import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import type { ActualizarMe, PerfilMe } from './schemas.ts';

const selectUsuario = {
  id: true,
  nombre: true,
  apellidoPaterno: true,
  apellidoMaterno: true,
  email: true,
  telefono: true,
  telefonoVerificado: true,
  mfaActivo: true,
  aceptoAvisoPrivacidad: true,
  fechaAceptacionAviso: true,
  versionAvisoAceptado: true,
  notifCorreo: true,
  notifWhatsapp: true,
} as const;

interface FilaMembresia {
  coto_id: string;
  coto: string;
  org_id: string;
  rol: string;
  unidad_id: string | null;
  unidad: string | null;
}

export async function obtener(tx: Prisma.TransactionClient, usuarioId: string): Promise<z.infer<typeof PerfilMe>> {
  const usuario = await tx.usuario.findUnique({ where: { id: usuarioId }, select: selectUsuario });
  if (!usuario) throw new AppError(404, 'usuario_no_encontrado', 'Usuario no encontrado');

  const membresias = await tx.$queryRaw<FilaMembresia[]>`SELECT * FROM app.mis_membresias()`;
  const orgs = await tx.orgMiembro.findMany({
    where: { usuarioId, activo: true },
    orderBy: { createdAt: 'asc' },
    select: {
      orgId: true,
      rol: true,
      organizacion: { select: { nombre: true, slug: true } },
    },
  });

  return {
    ...usuario,
    fechaAceptacionAviso: usuario.fechaAceptacionAviso?.toISOString() ?? null,
    membresias: membresias.map((m) => ({
      cotoId: m.coto_id,
      coto: m.coto,
      orgId: m.org_id,
      rol: m.rol,
      unidadId: m.unidad_id,
      unidad: m.unidad,
    })),
    organizaciones: orgs.map((o) => ({
      orgId: o.orgId,
      nombre: o.organizacion.nombre,
      slug: o.organizacion.slug,
      rol: o.rol,
    })),
  };
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  usuarioId: string,
  datos: z.infer<typeof ActualizarMe>,
): Promise<z.infer<typeof PerfilMe>> {
  const { aceptoAvisoPrivacidad, ...resto } = datos;
  await tx.usuario.update({
    where: { id: usuarioId },
    data: {
      ...resto,
      ...(aceptoAvisoPrivacidad ? { aceptoAvisoPrivacidad: true, fechaAceptacionAviso: new Date() } : {}),
    },
    select: { id: true },
  });
  return obtener(tx, usuarioId);
}
