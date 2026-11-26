import { z } from '@hono/zod-openapi';

export const CotoParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
});

export const SectorParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

export const TipoSector = z.enum(['seccion', 'torre', 'privada', 'edificio', 'calle', 'manzana']);

export const Sector = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    nombre: z.string(),
    tipo: z.string(),
    orden: z.number().int(),
    activo: z.boolean(),
  })
  .openapi('Sector');

export const CrearSector = z
  .object({
    nombre: z.string().trim().min(1).max(100),
    tipo: TipoSector.default('seccion'),
    orden: z.number().int().min(0).max(32_000).default(0),
  })
  .strict()
  .openapi('CrearSector');

export const ActualizarSector = z
  .object({
    nombre: z.string().trim().min(1).max(100).optional(),
    tipo: TipoSector.optional(),
    orden: z.number().int().min(0).max(32_000).optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .openapi('ActualizarSector');
