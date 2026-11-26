import { z } from '@hono/zod-openapi';

export const TipoUnidad = z.enum(['casa', 'departamento', 'local', 'bodega', 'oficina', 'terreno']);
export const IndivisoRegex = /^(0\.\d{0,5}[1-9]|1(\.0{1,6})?)$/;
export const SuperficieRegex = /^\d{1,8}(\.\d{1,2})?$/;

export const CotoParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
});

export const UnidadParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

export const Unidad = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    sectorId: z.uuid().nullable(),
    numero: z.string(),
    tipo: TipoUnidad,
    superficieM2: z.string().nullable(),
    indiviso: z.string().nullable().openapi({ description: 'Fracción > 0 y <= 1 como texto decimal' }),
    ocupada: z.boolean(),
    activo: z.boolean(),
  })
  .openapi('Unidad');

export const CrearUnidad = z
  .object({
    numero: z.string().trim().min(1).max(20),
    tipo: TipoUnidad.default('casa'),
    sectorId: z.uuid().optional(),
    superficieM2: z.string().regex(SuperficieRegex).optional(),
    indiviso: z.string().regex(IndivisoRegex).optional(),
    ocupada: z.boolean().default(true),
  })
  .strict()
  .openapi('CrearUnidad');

export const ActualizarUnidad = z
  .object({
    numero: z.string().trim().min(1).max(20).optional(),
    tipo: TipoUnidad.optional(),
    sectorId: z.uuid().nullable().optional(),
    superficieM2: z.string().regex(SuperficieRegex).nullable().optional(),
    indiviso: z.string().regex(IndivisoRegex).nullable().optional(),
    ocupada: z.boolean().optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .openapi('ActualizarUnidad');

export const ResultadoImportacion = z
  .object({
    creadas: z.number().int(),
  })
  .openapi('ResultadoImportacion');
