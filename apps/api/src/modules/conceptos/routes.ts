import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  ActualizarConcepto,
  Concepto,
  ConceptoParam,
  CotoParam,
  CrearConcepto,
  ListarConceptosQuery,
} from './schemas.ts';
import * as servicio from './service.ts';

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/conceptos',
  tags: ['finanzas'],
  summary: 'Listar conceptos de cobro del coto',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarConceptosQuery },
  responses: {
    200: {
      description: 'Conceptos paginados',
      content: {
        'application/json': { schema: z.object({ datos: z.array(Concepto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/conceptos',
  tags: ['finanzas'],
  summary: 'Crear concepto de cobro',
  security: [{ bearer: [] }],
  request: { params: CotoParam, body: { required: true, content: { 'application/json': { schema: CrearConcepto } } } },
  responses: {
    201: { description: 'Concepto creado', content: { 'application/json': { schema: Concepto } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/cotos/{cotoId}/conceptos/{id}',
  tags: ['finanzas'],
  summary: 'Actualizar concepto de cobro',
  security: [{ bearer: [] }],
  request: {
    params: ConceptoParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarConcepto } } },
  },
  responses: {
    200: { description: 'Concepto actualizado', content: { 'application/json': { schema: Concepto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function conceptosRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const query = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, query)), 200);
    })
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const res = await conTenant(c, deps, cotoId, (tx) => servicio.crear(tx, cotoId, c.req.valid('json')));
      return c.json(res, 201, { Location: `/api/v1/cotos/${cotoId}/conceptos/${res.id}` });
    })
    .openapi(actualizar, async (c) => {
      const { cotoId, id } = c.req.valid('param');
      const res = await conTenant(c, deps, cotoId, (tx) => servicio.actualizar(tx, cotoId, id, c.req.valid('json')));
      return c.json(res, 200);
    });
}
