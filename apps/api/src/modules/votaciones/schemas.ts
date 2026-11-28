import { z } from '@hono/zod-openapi';

export const EstadoVotacion = z.enum(['borrador', 'programada', 'activa', 'cerrada', 'cancelada']);

export const CotoParam = z.object({ cotoId: z.uuid() });
export const VotacionParam = z.object({ id: z.uuid() });

export const CrearVotacion = z
  .object({
    titulo: z.string().trim().min(1).max(200),
    fechaInicio: z.iso.datetime({ offset: true }),
    fechaFin: z.iso.datetime({ offset: true }),
    ponderadaPorIndiviso: z.boolean().default(false),
    opciones: z.array(z.string().trim().min(1).max(300)).min(2).max(20),
  })
  .strict()
  .refine((d) => new Date(d.fechaFin) > new Date(d.fechaInicio), {
    message: 'La fecha de cierre debe ser posterior al inicio',
    path: ['fechaFin'],
  })
  .refine((d) => new Set(d.opciones.map((o) => o.toLowerCase())).size === d.opciones.length, {
    message: 'Las opciones no pueden repetirse',
    path: ['opciones'],
  })
  .openapi('CrearVotacion');

export const VotacionDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    titulo: z.string(),
    ponderadaPorIndiviso: z.boolean(),
    fechaInicio: z.string(),
    fechaFin: z.string(),
    estado: EstadoVotacion,
    opciones: z.array(z.object({ id: z.uuid(), texto: z.string() })),
    createdAt: z.string(),
  })
  .openapi('Votacion');

export const ListarVotacionesQuery = z.object({
  estado: EstadoVotacion.optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const EmitirVoto = z.object({ opcionId: z.uuid(), unidadId: z.uuid() }).strict().openapi('EmitirVoto');

export const ResultadosDto = z
  .object({
    votacionId: z.uuid(),
    opciones: z.array(
      z.object({
        opcionId: z.uuid(),
        opcion: z.string(),
        votos: z.number().int(),
        peso: z.string().openapi({ description: 'Suma de pesos (indiviso si la votación es ponderada)' }),
      }),
    ),
    unidadesVotantes: z.number().int(),
    unidadesTotales: z.number().int(),
    indivisoVotante: z.string().openapi({ description: 'Quórum por indiviso (0..1) de las unidades que votaron' }),
  })
  .openapi('ResultadosVotacion');
