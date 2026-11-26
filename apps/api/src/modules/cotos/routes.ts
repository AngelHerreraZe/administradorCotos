import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { ActualizarCoto, Coto, CotoParam } from './schemas.ts';
import * as servicio from './service.ts';

const obtener = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}',
  tags: ['cotos'],
  summary: 'Obtener detalle de un coto',
  description: 'Permiso en BD: `cotos_miembro`.',
  security: [{ bearer: [] }],
  request: { params: CotoParam },
  responses: {
    200: { description: 'Coto', content: { 'application/json': { schema: Coto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/cotos/{cotoId}',
  tags: ['cotos'],
  summary: 'Actualizar configuración del coto',
  description: 'Permiso en BD: `cotos_admin` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarCoto } } },
  },
  responses: {
    200: { description: 'Actualizado', content: { 'application/json': { schema: Coto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

export function cotosRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(obtener, async (c) => {
      const { cotoId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.obtener(tx, cotoId)), 200);
    })
    .openapi(actualizar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const datos = c.req.valid('json');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.actualizar(tx, cotoId, datos)), 200);
    });
}
