import { z } from '@hono/zod-openapi';

// Markdown SIN HTML: el cliente lo renderiza con sanitización (modern-web-guidance `sanitize-untrusted-html`);
// la BD repite la regla con `comunicados_sin_html_ck`.
const HTML = /<[A-Za-z/!?]/;
const textoSinHtml = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !HTML.test(s), 'Usa Markdown sin etiquetas HTML');

export const CotoParam = z.object({ cotoId: z.uuid() });
export const ComunicadoParam = z.object({ id: z.uuid() });

export const DirigidoA = z.enum(['todos', 'propietarios', 'sector', 'unidades', 'morosos']);

export const CrearComunicado = z
  .object({
    titulo: textoSinHtml(200),
    cuerpo: textoSinHtml(20_000),
    prioridad: z.enum(['normal', 'urgente']).default('normal'),
    dirigidoA: DirigidoA.default('todos'),
    sectorId: z.uuid().optional(),
    unidadesIds: z.array(z.uuid()).min(1).max(1000).optional(),
  })
  .strict()
  .refine((d) => d.dirigidoA !== 'sector' || d.sectorId, { message: 'Indica el sector', path: ['sectorId'] })
  .refine((d) => d.dirigidoA !== 'unidades' || d.unidadesIds, { message: 'Indica las unidades', path: ['unidadesIds'] })
  .openapi('CrearComunicado');

export const ComunicadoDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    titulo: z.string(),
    cuerpo: z.string().openapi({ description: 'Markdown sin HTML; renderízalo sanitizado' }),
    prioridad: z.enum(['normal', 'urgente']),
    dirigidoA: DirigidoA,
    publicado: z.boolean(),
    publicadoEn: z.string().nullable(),
    leidoEn: z.string().nullable().openapi({ description: 'Cuándo lo leyó la persona que consulta' }),
    createdAt: z.string(),
  })
  .openapi('Comunicado');

export const ListarComunicadosQuery = z.object({
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});
