import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { ComunicadoDto, ComunicadoParam, CotoParam, CrearComunicado, ListarComunicadosQuery } from './schemas.ts';
import * as servicio from './service.ts';

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/comunicados',
  tags: ['comunicacion'],
  summary: 'Crear borrador de comunicado (administración)',
  description: 'Cuerpo en Markdown sin HTML. Segmentos: todos, propietarios, sector, unidades, morosos.',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearComunicado } } },
  },
  responses: {
    201: { description: 'Borrador creado', content: { 'application/json': { schema: ComunicadoDto } } },
    200: { description: 'Ya existía (idempotente)', content: { 'application/json': { schema: ComunicadoDto } } },
    ...respuestasError(401, 403, 422),
  },
});

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/comunicados',
  tags: ['comunicacion'],
  summary: 'Comunicados visibles (staff: todos; residentes: los que les llegaron)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarComunicadosQuery },
  responses: {
    200: {
      description: 'Página',
      content: {
        'application/json': { schema: z.object({ datos: z.array(ComunicadoDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const publicar = createRoute({
  method: 'post',
  path: '/comunicados/{id}/publicar',
  tags: ['comunicacion'],
  summary: 'Publicar y notificar (administración); repetir no duplica envíos',
  description:
    'Los destinatarios se fijan en BD al publicar. El segmento "morosos" se envía a cada persona en privado y nunca se lista.',
  security: [{ bearer: [] }],
  request: { params: ComunicadoParam },
  responses: {
    200: {
      description: 'Publicado; notificación encolada',
      content: { 'application/json': { schema: z.object({ destinatarios: z.number().int() }) } },
    },
    ...respuestasError(401, 403, 404, 409),
  },
});

const leido = createRoute({
  method: 'post',
  path: '/comunicados/{id}/leido',
  tags: ['comunicacion'],
  summary: 'Marcar como leído (solo destinatarios)',
  security: [{ bearer: [] }],
  request: { params: ComunicadoParam },
  responses: { 204: { description: 'Marcado' }, ...respuestasError(401, 404) },
});

export function comunicadosRoutes(deps: Pick<Deps, 'prisma' | 'log' | 'encolarNotificaciones'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crear(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado
        ? c.json(res.dato, 201, { Location: `/api/v1/cotos/${cotoId}/comunicados/${res.dato.id}` })
        : c.json(res.dato, 200);
    })
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      const { usuarioId } = c.get('auth');
      return c.json(
        await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, usuarioId, limite, cursor)),
        200,
      );
    })
    .openapi(publicar, async (c) => {
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.publicar(tx, id));
      // Se encola DESPUÉS del commit: el worker solo ve destinatarios ya confirmados.
      // jobId fijo: mientras el fan-out siga vivo, otra publicación no lo duplica; el fan-out es idempotente.
      if (deps.encolarNotificaciones) {
        await deps.encolarNotificaciones({ accion: 'comunicado', comunicadoId: id }, { jobId: `notif-${id}` });
      } else {
        c.get('log').warn({ comunicadoId: id }, 'cola notificaciones no configurada');
      }
      return c.json(res, 200);
    })
    .openapi(leido, async (c) => {
      const { id } = c.req.valid('param');
      const { usuarioId } = c.get('auth');
      await conTenant(c, deps, undefined, (tx) => servicio.marcarLeido(tx, id, usuarioId));
      return c.body(null, 204);
    });
}
