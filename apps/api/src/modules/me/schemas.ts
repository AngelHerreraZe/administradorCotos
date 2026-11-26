import { z } from '@hono/zod-openapi';

export const Membresia = z
  .object({
    cotoId: z.uuid(),
    coto: z.string(),
    orgId: z.uuid(),
    rol: z.string(),
    unidadId: z.uuid().nullable(),
    unidad: z.string().nullable(),
  })
  .openapi('Membresia');

export const OrgMembresia = z
  .object({
    orgId: z.uuid(),
    nombre: z.string(),
    slug: z.string(),
    rol: z.string(),
  })
  .openapi('OrgMembresia');

export const PerfilMe = z
  .object({
    id: z.uuid(),
    nombre: z.string(),
    apellidoPaterno: z.string(),
    apellidoMaterno: z.string().nullable(),
    email: z.email(),
    telefono: z.string().nullable(),
    telefonoVerificado: z.boolean(),
    mfaActivo: z.boolean(),
    aceptoAvisoPrivacidad: z.boolean(),
    fechaAceptacionAviso: z.string().nullable(),
    versionAvisoAceptado: z.number().int().nullable(),
    membresias: z.array(Membresia),
    organizaciones: z.array(OrgMembresia),
  })
  .openapi('PerfilMe');

export const ActualizarMe = z
  .object({
    nombre: z.string().trim().min(1).max(100).optional(),
    apellidoPaterno: z.string().trim().min(1).max(100).optional(),
    apellidoMaterno: z.string().trim().min(1).max(100).nullable().optional(),
    telefono: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{10,15}$/, 'Teléfono inválido (10 a 15 dígitos)')
      .nullable()
      .optional(),
    aceptoAvisoPrivacidad: z.literal(true).optional(),
    versionAvisoAceptado: z.number().int().min(1).optional(),
  })
  .strict()
  .openapi('ActualizarMe');
