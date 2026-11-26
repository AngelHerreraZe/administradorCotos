import { z } from '@hono/zod-openapi';

export const RolCoto = z.enum([
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

export const MiembroParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

export const MiembroCotoDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    unidadId: z.uuid().nullable(),
    unidadNumero: z.string().nullable(),
    usuarioId: z.uuid(),
    nombre: z.string(),
    apellidoPaterno: z.string(),
    apellidoMaterno: z.string().nullable(),
    email: z.string(),
    telefono: z.string().nullable(),
    rol: RolCoto,
    activo: z.boolean(),
  })
  .openapi('MiembroCoto');

export const ActualizarMiembro = z
  .object({
    rol: RolCoto.optional(),
    unidadId: z.uuid().nullable().optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .openapi('ActualizarMiembro');
