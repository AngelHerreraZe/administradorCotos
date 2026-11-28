import { AppError } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  ActualizarTicket,
  ComentarioDto,
  CotoParam,
  CrearComentario,
  CrearTicket,
  ListarTicketsQuery,
  SolicitarUrlAdjunto,
  TicketDto,
  TicketParam,
} from './schemas.ts';
import * as servicio from './service.ts';

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/tickets',
  tags: ['tickets'],
  summary: 'Reportar un ticket (cualquier miembro; la unidad debe ser suya)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearTicket } } },
  },
  responses: {
    201: { description: 'Creado', content: { 'application/json': { schema: TicketDto } } },
    200: { description: 'Ya existía (idempotente)', content: { 'application/json': { schema: TicketDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/tickets',
  tags: ['tickets'],
  summary: 'Tickets visibles (staff y caseta: todos; residentes: los suyos y de su unidad)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarTicketsQuery },
  responses: {
    200: {
      description: 'Página',
      content: {
        'application/json': { schema: z.object({ datos: z.array(TicketDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/tickets/{id}',
  tags: ['tickets'],
  summary: 'Cambiar estado o categoría (administración)',
  security: [{ bearer: [] }],
  request: {
    params: TicketParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarTicket } } },
  },
  responses: {
    200: { description: 'Actualizado', content: { 'application/json': { schema: TicketDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const comentar = createRoute({
  method: 'post',
  path: '/tickets/{id}/comentarios',
  tags: ['tickets'],
  summary: 'Comentar un ticket visible (internos solo staff)',
  security: [{ bearer: [] }],
  request: {
    params: TicketParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearComentario } } },
  },
  responses: {
    201: { description: 'Creado', content: { 'application/json': { schema: ComentarioDto } } },
    200: { description: 'Ya existía (idempotente)', content: { 'application/json': { schema: ComentarioDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const comentarios = createRoute({
  method: 'get',
  path: '/tickets/{id}/comentarios',
  tags: ['tickets'],
  summary: 'Comentarios de un ticket visible',
  security: [{ bearer: [] }],
  request: { params: TicketParam },
  responses: {
    200: {
      description: 'Comentarios',
      content: { 'application/json': { schema: z.object({ datos: z.array(ComentarioDto) }) } },
    },
    ...respuestasError(401, 404),
  },
});

const urlAdjunto = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/tickets/adjunto-url',
  tags: ['tickets'],
  summary: 'URL prefirmada para subir un adjunto (imagen o PDF, 10 MB)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'application/json': { schema: SolicitarUrlAdjunto } } },
  },
  responses: {
    200: {
      description: 'URL de subida',
      content: {
        'application/json': {
          schema: z.object({
            url: z.string(),
            fields: z.record(z.string(), z.string()),
            expiraEnSegundos: z.number().int(),
            llave: z.string(),
          }),
        },
      },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const adjuntos = createRoute({
  method: 'get',
  path: '/tickets/{id}/adjuntos',
  tags: ['tickets'],
  summary: 'URLs de descarga (2 min) de los adjuntos de un ticket visible',
  security: [{ bearer: [] }],
  request: { params: TicketParam },
  responses: {
    200: {
      description: 'URLs',
      content: {
        'application/json': { schema: z.object({ datos: z.array(z.string()), expiraEnSegundos: z.number().int() }) },
      },
    },
    ...respuestasError(401, 404),
  },
});

function storageRequerido(deps: Pick<Deps, 'storage'>) {
  if (!deps.storage) {
    throw new AppError(503, 'servicio_no_configurado', 'El almacenamiento de archivos no está configurado');
  }
  return deps.storage;
}

export function ticketsRoutes(deps: Pick<Deps, 'prisma' | 'storage'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crear(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado ? c.json(res.dato, 201, { Location: `/api/v1/tickets/${res.dato.id}` }) : c.json(res.dato, 200);
    })
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, c.req.valid('query'))), 200);
    })
    .openapi(actualizar, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.actualizar(tx, id, c.req.valid('json'))), 200);
    })
    .openapi(comentar, async (c) => {
      const { id } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, undefined, (tx) =>
        servicio.comentar(tx, id, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado ? c.json(res.dato, 201) : c.json(res.dato, 200);
    })
    .openapi(comentarios, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.listarComentarios(tx, id)), 200);
    })
    .openapi(urlAdjunto, async (c) => {
      const storage = storageRequerido(deps);
      const { cotoId } = c.req.valid('param');
      return c.json(
        await conTenant(c, deps, cotoId, (tx) => servicio.urlSubidaAdjunto(tx, cotoId, c.req.valid('json'), storage)),
        200,
      );
    })
    .openapi(adjuntos, async (c) => {
      const storage = storageRequerido(deps);
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.urlsAdjuntos(tx, id, storage)), 200);
    });
}
