import { TIPOS_ARCHIVO_PERMITIDOS } from '@admcotos/storage';
import { z } from '@hono/zod-openapi';

export const EstadoTicket = z.enum([
  'abierto',
  'en_proceso',
  'esperando_residente',
  'resuelto',
  'cerrado',
  'cancelado',
]);

export const CotoParam = z.object({ cotoId: z.uuid() });
export const TicketParam = z.object({ id: z.uuid() });

export const CrearTicket = z
  .object({
    titulo: z.string().trim().min(1).max(200),
    descripcion: z.string().trim().min(1).max(5_000),
    categoria: z.string().trim().min(1).max(30).optional(),
    unidadId: z.uuid().optional(),
    adjuntos: z
      .array(z.string().trim().min(10).max(255))
      .max(5)
      .optional()
      .openapi({ description: 'Llaves devueltas por /tickets/adjunto-url' }),
  })
  .strict()
  .openapi('CrearTicket');

export const ActualizarTicket = z
  .object({
    estado: EstadoTicket.optional(),
    categoria: z.string().trim().min(1).max(30).nullable().optional(),
  })
  .strict()
  .refine((d) => d.estado !== undefined || d.categoria !== undefined, { message: 'Nada que actualizar' })
  .openapi('ActualizarTicket');

export const TicketDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    unidadId: z.uuid().nullable(),
    reportadoPor: z.uuid(),
    numero: z.number().int(),
    titulo: z.string(),
    descripcion: z.string(),
    categoria: z.string().nullable(),
    estado: EstadoTicket,
    adjuntos: z.number().int().openapi({ description: 'Cantidad de adjuntos; descárgalos con /tickets/{id}/adjuntos' }),
    slaVenceEn: z.string(),
    slaVencido: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Ticket');

export const ListarTicketsQuery = z.object({
  estado: EstadoTicket.optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const CrearComentario = z
  .object({
    comentario: z.string().trim().min(1).max(5_000),
    esInterno: z.boolean().default(false).openapi({ description: 'Solo staff lo ve (y solo staff puede crearlo)' }),
  })
  .strict()
  .openapi('CrearComentarioTicket');

export const ComentarioDto = z
  .object({
    id: z.uuid(),
    ticketId: z.uuid(),
    usuarioId: z.uuid(),
    comentario: z.string(),
    esInterno: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('ComentarioTicket');

export const SolicitarUrlAdjunto = z
  .object({ contentType: z.enum(TIPOS_ARCHIVO_PERMITIDOS) })
  .openapi('SolicitarUrlAdjuntoTicket');
