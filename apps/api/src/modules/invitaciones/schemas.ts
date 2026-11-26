import { z } from '@hono/zod-openapi';

export const RolCotoInvitable = z.enum([
  'coto_admin',
  'coto_tesorero',
  'coto_comite',
  'residente_propietario',
  'residente_inquilino',
  'guardia',
  'proveedor',
]);

export const CotoParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
});

export const InvitacionParam = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

export const InvitacionDto = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    cotoId: z.uuid().nullable(),
    unidadId: z.uuid().nullable(),
    email: z.string(),
    rol: z.string(),
    expiraEn: z.string(),
    aceptadaEn: z.string().nullable(),
    revocadaEn: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('InvitacionMiembro');

export const CrearInvitacion = z
  .object({
    email: z.email(),
    rol: RolCotoInvitable,
    unidadId: z.uuid().optional(),
    diasVigencia: z.number().int().min(1).max(7).default(7),
  })
  .strict()
  .refine((v) => !['residente_propietario', 'residente_inquilino'].includes(v.rol) || Boolean(v.unidadId), {
    message: 'Los roles de residente requieren unidadId',
    path: ['unidadId'],
  })
  .openapi('CrearInvitacion');

export const AceptarInvitacion = z
  .object({
    token: z.string().trim().min(16).max(200),
    nombre: z.string().trim().min(1).max(100).optional(),
    apellidoPaterno: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .openapi('AceptarInvitacion');

export const InvitacionAceptada = z
  .object({
    usuarioId: z.uuid(),
  })
  .openapi('InvitacionAceptada');
