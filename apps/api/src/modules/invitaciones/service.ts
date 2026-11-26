import crypto from 'node:crypto';
import type { Prisma } from '@admcotos/db';
import { AppError, type PayloadCorreo, Uuid } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls, conIdempotencia } from '../../lib/prisma.ts';
import type { AceptarInvitacion, CrearInvitacion, InvitacionDto } from './schemas.ts';

const selectInv = {
  id: true,
  orgId: true,
  cotoId: true,
  unidadId: true,
  email: true,
  rol: true,
  expiraEn: true,
  aceptadaEn: true,
  revocadaEn: true,
  createdAt: true,
} as const;

function aDto(inv: Prisma.InvitacionMiembroGetPayload<{ select: typeof selectInv }>): z.infer<typeof InvitacionDto> {
  return {
    id: inv.id,
    orgId: inv.orgId,
    cotoId: inv.cotoId,
    unidadId: inv.unidadId,
    email: inv.email,
    rol: inv.rol,
    expiraEn: inv.expiraEn.toISOString(),
    aceptadaEn: inv.aceptadaEn?.toISOString() ?? null,
    revocadaEn: inv.revocadaEn?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function crear(
  tx: Prisma.TransactionClient,
  params: {
    cotoId: string;
    usuarioId: string;
    datos: z.infer<typeof CrearInvitacion>;
    appPublicUrl: string;
    idempotencyKey?: string;
  },
): Promise<{ creado: boolean; dto: z.infer<typeof InvitacionDto>; correo?: PayloadCorreo; jobId?: string }> {
  const { cotoId, usuarioId, datos, appPublicUrl, idempotencyKey } = params;
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para invitar miembros en este coto');

  const coto = await tx.coto.findUnique({
    where: { id: cotoId },
    select: { id: true, orgId: true, nombre: true, activo: true },
  });
  if (!coto?.activo) {
    throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const claveIdempotencia = idempotencyKey ? `api:${usuarioId}:${idempotencyKey}` : undefined;
  // Descontamos 60 s cuando son 7 días para absorber diferencias menores de reloj frente a DEFAULT now() en BD.
  const msVigencia = datos.diasVigencia * 86_400_000 - (datos.diasVigencia === 7 ? 60_000 : 0);
  const expiraEn = new Date(Date.now() + msVigencia);

  const res = await conIdempotencia(
    tx,
    claveIdempotencia,
    () =>
      tx.invitacionMiembro.create({
        data: {
          orgId: coto.orgId,
          cotoId: coto.id,
          unidadId: datos.unidadId ?? null,
          email: datos.email,
          rol: datos.rol,
          tokenHash,
          ...(claveIdempotencia ? { claveIdempotencia } : {}),
          expiraEn,
          creadaPor: usuarioId,
        },
        select: selectInv,
      }),
    () =>
      tx.invitacionMiembro.findFirst({
        where: { claveIdempotencia, cotoId: coto.id },
        select: selectInv,
      }),
  );

  if (!res.creado) {
    return { creado: false, dto: aDto(res.dato) };
  }

  const baseUrl = appPublicUrl.replace(/\/$/, '');
  return {
    creado: true,
    dto: aDto(res.dato),
    jobId: `inv:${res.dato.id}`,
    correo: {
      plantilla: 'invitacion',
      para: datos.email,
      datos: {
        coto: coto.nombre,
        rol: datos.rol,
        url: `${baseUrl}/invitaciones/aceptar#token=${token}`,
        expira: `${datos.diasVigencia} ${datos.diasVigencia === 1 ? 'día' : 'días'}`,
      },
    },
  };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  limite: number,
  cursor?: string,
): Promise<{ datos: z.infer<typeof InvitacionDto>[]; siguiente?: string }> {
  if (cursor && !Uuid.safeParse(cursor).success) {
    throw new AppError(422, 'validacion', 'Cursor inválido');
  }
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para ver las invitaciones de este coto');

  const filas = await tx.invitacionMiembro.findMany({
    where: { cotoId },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: selectInv,
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), siguiente };
}

export async function revocar(tx: Prisma.TransactionClient, id: string): Promise<z.infer<typeof InvitacionDto>> {
  const actual = await tx.invitacionMiembro.findUnique({ where: { id }, select: selectInv });
  if (!actual) throw new AppError(404, 'invitacion_no_encontrada', 'Invitación no encontrada');
  if (actual.aceptadaEn) {
    throw new AppError(409, 'invitacion_ya_aceptada', 'La invitación ya fue aceptada');
  }
  if (actual.revocadaEn) return aDto(actual);

  const actualizada = await actualizarConRls(() =>
    tx.invitacionMiembro.update({ where: { id }, data: { revocadaEn: new Date() }, select: selectInv }),
  );
  return aDto(actualizada);
}

export async function aceptar(
  tx: Prisma.TransactionClient,
  params: {
    authId: string;
    email: string;
    datos: z.infer<typeof AceptarInvitacion>;
  },
): Promise<{ usuarioId: string }> {
  const tokenHash = hashToken(params.datos.token);
  const [fila] = await tx.$queryRaw<{ usuario_id: string }[]>`
    SELECT app.aceptar_invitacion(
      ${tokenHash},
      ${params.authId}::uuid,
      ${params.email}::citext,
      ${params.datos.nombre ?? ''},
      ${params.datos.apellidoPaterno ?? ''}
    ) AS usuario_id
  `;
  if (!fila?.usuario_id) {
    throw new AppError(500, 'interno', 'No se pudo completar la invitación');
  }
  return { usuarioId: fila.usuario_id };
}
