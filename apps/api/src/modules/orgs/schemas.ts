import { z } from '@hono/zod-openapi';

const COLOR_HEX = /^#[0-9A-Fa-f]{6}$/;
const DOMINIO = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const OrgParam = z.object({
  orgId: z.uuid().openapi({ param: { name: 'orgId', in: 'path' } }),
});

export const Organizacion = z
  .object({
    id: z.uuid(),
    nombre: z.string(),
    slug: z.string(),
    rfc: z.string().nullable(),
    razonSocial: z.string().nullable(),
    emailContacto: z.string(),
    telefono: z.string().nullable(),
    customDomain: z.string().nullable(),
    logoUrl: z.string().nullable(),
    colorPrimario: z.string().nullable(),
    colorSecundario: z.string().nullable(),
    faviconUrl: z.string().nullable(),
    tierMayoreo: z.string(),
    estadoSuscripcion: z.string(),
    exigirMfa: z.boolean(),
    avisoPrivacidadUrl: z.string().nullable(),
    avisoVersion: z.number().int(),
    activo: z.boolean(),
  })
  .openapi('Organizacion');

export const ActualizarOrganizacion = z
  .object({
    nombre: z.string().trim().min(1).max(200).optional(),
    razonSocial: z.string().trim().min(1).max(300).nullable().optional(),
    rfc: z.string().trim().min(12).max(13).nullable().optional(),
    emailContacto: z.email().optional(),
    telefono: z.string().trim().min(7).max(20).nullable().optional(),
    customDomain: z.string().trim().toLowerCase().regex(DOMINIO).max(255).nullable().optional(),
    logoUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .optional(),
    colorPrimario: z.string().regex(COLOR_HEX).nullable().optional(),
    colorSecundario: z.string().regex(COLOR_HEX).nullable().optional(),
    faviconUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .optional(),
    avisoPrivacidadUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .optional(),
    avisoVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .openapi('ActualizarOrganizacion');

export const CrearCoto = z
  .object({
    nombre: z.string().trim().min(1).max(200),
    slug: z.string().trim().toLowerCase().min(2).max(100).regex(SLUG),
    zonaHoraria: z.string().trim().min(3).max(50).default('America/Mexico_City'),
    tipo: z.enum(['coto', 'torre', 'fraccionamiento', 'parque_industrial', 'plaza']).default('coto'),
    direccion: z.string().trim().max(500).optional(),
    colonia: z.string().trim().max(200).optional(),
    ciudad: z.string().trim().max(100).optional(),
    estado: z.string().trim().max(100).optional(),
    cp: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    diaCorte: z.number().int().min(1).max(28).default(1),
    diaLimitePago: z.number().int().min(1).max(28).default(10),
  })
  .strict()
  .openapi('CrearCoto');

export const CotoResumen = z
  .object({
    cotoId: z.uuid(),
    coto: z.string(),
    slug: z.string(),
    tipo: z.string(),
    zonaHoraria: z.string(),
    activo: z.boolean(),
    unidades: z.number().int(),
    emitidoMes: z.string(),
    cobradoMes: z.string(),
    pctCobrado: z.string().nullable(),
    adeudoVencido: z.string(),
    unidadesMorosas: z.number().int(),
    pagosPorRevisar: z.number().int(),
    ticketsAbiertos: z.number().int(),
  })
  .openapi('CotoResumen');

export const CrearSoporte = z
  .object({
    ticketRef: z.string().trim().min(1).max(50),
    duracionHoras: z.number().int().min(1).max(72).default(24),
  })
  .strict()
  .openapi('CrearSoporte');

export const SoporteAccesoDto = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    otorgadoPor: z.uuid(),
    ticketRef: z.string(),
    desde: z.string(),
    hasta: z.string(),
  })
  .openapi('SoporteAcceso');
