import type { Prisma } from '@admcotos/db';
import { AppError, Uuid } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls } from '../../lib/prisma.ts';
import type { ActualizarMiembro, MiembroCotoDto } from './schemas.ts';

interface FilaMiembroConContacto {
  id: string;
  cotoId: string;
  unidadId: string | null;
  usuarioId: string;
  rol: string;
  activo: boolean;
  unidad: { numero: string } | null;
  usuario: {
    nombre: string;
    apellidoPaterno: string;
    apellidoMaterno: string | null;
    email?: string;
    telefono?: string | null;
  } | null;
}

function aDto(m: FilaMiembroConContacto): z.infer<typeof MiembroCotoDto> {
  return {
    id: m.id,
    cotoId: m.cotoId,
    unidadId: m.unidadId,
    unidadNumero: m.unidad?.numero ?? null,
    usuarioId: m.usuarioId,
    nombre: m.usuario?.nombre ?? null,
    apellidoPaterno: m.usuario?.apellidoPaterno ?? null,
    apellidoMaterno: m.usuario?.apellidoMaterno ?? null,
    email: m.usuario?.email ?? null,
    telefono: m.usuario?.telefono ?? null,
    rol: m.rol as z.infer<typeof MiembroCotoDto>['rol'],
    activo: m.activo,
  };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  limite: number,
  cursor?: string,
): Promise<{ datos: z.infer<typeof MiembroCotoDto>[]; siguiente?: string }> {
  if (cursor && !Uuid.safeParse(cursor).success) {
    throw new AppError(422, 'validacion', 'Cursor inválido');
  }
  const [perm] = await tx.$queryRaw<{ staff: boolean; contacto: boolean }[]>`
    SELECT (${cotoId}::uuid = ANY (app.cotos_staff())) AS staff,
           (${cotoId}::uuid = ANY (app.cotos_finanzas())) AS contacto
  `;
  if (!perm?.staff) throw new AppError(403, 'sin_permiso', 'No tienes permiso para ver el directorio de este coto');

  const filas = await tx.miembroCoto.findMany({
    where: { cotoId, activo: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      cotoId: true,
      unidadId: true,
      usuarioId: true,
      rol: true,
      activo: true,
      unidad: { select: { numero: true } },
      usuario: {
        select: {
          nombre: true,
          apellidoPaterno: true,
          apellidoMaterno: true,
          ...(perm.contacto ? { email: true, telefono: true } : {}),
        },
      },
    },
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), siguiente };
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  id: string,
  datos: z.infer<typeof ActualizarMiembro>,
): Promise<z.infer<typeof MiembroCotoDto>> {
  const actual = await tx.miembroCoto.findFirst({
    where: { id, cotoId },
    select: { id: true, rol: true, unidadId: true },
  });
  if (!actual) throw new AppError(404, 'miembro_no_encontrado', 'Miembro no encontrado');

  const rolFinal = datos.rol ?? actual.rol;
  const unidadFinal = datos.unidadId !== undefined ? datos.unidadId : actual.unidadId;
  if ((rolFinal === 'residente_propietario' || rolFinal === 'residente_inquilino') && !unidadFinal) {
    throw new AppError(422, 'unidad_requerida', 'Los roles de residente requieren una unidad asignada');
  }

  // No unimos `usuario` aquí: si se desactiva (activo=false), RLS oculta `usuarios` y fallaría la relación requerida.
  const actualizado = await actualizarConRls(() =>
    tx.miembroCoto.update({
      where: { id },
      data: datos,
      select: {
        id: true,
        cotoId: true,
        unidadId: true,
        usuarioId: true,
        rol: true,
        activo: true,
        unidad: { select: { numero: true } },
      },
    }),
  );

  const usuario = actualizado.activo
    ? await tx.usuario.findUnique({
        where: { id: actualizado.usuarioId },
        select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, email: true, telefono: true },
      })
    : null;

  return aDto({ ...actualizado, usuario });
}
