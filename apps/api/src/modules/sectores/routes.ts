import { Paginacion } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { ActualizarSector, CotoParam, CrearSector, Sector, SectorParam } from './schemas.ts';
import * as servicio from './service.ts';

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/sectores',
  tags: ['sectores'],
  summary: 'Listar sectores del coto (paginado por cursor)',
  description: 'Permiso en BD: `cotos_miembro`.',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: Paginacion },
  responses: {
    200: {
      description: 'Página de sectores',
      content: { 'application/json': { schema: z.object({ datos: z.array(Sector), siguiente: z.uuid().optional() }) } },
    },
    ...respuestasError(401, 403, 422),
  },
});

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/sectores',
  tags: ['sectores'],
  summary: 'Crear un sector',
  description: 'Permiso en BD: `cotos_admin` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'application/json': { schema: CrearSector } } },
  },
  responses: {
    201: { description: 'Creado', content: { 'application/json': { schema: Sector } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/cotos/{cotoId}/sectores/{id}',
  tags: ['sectores'],
  summary: 'Actualizar un sector',
  description: 'Permiso en BD: `cotos_admin` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: SectorParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarSector } } },
  },
  responses: {
    200: { description: 'Actualizado', content: { 'application/json': { schema: Sector } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function sectoresRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, limite, cursor)), 200);
    })
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const sector = await conTenant(c, deps, cotoId, (tx) => servicio.crear(tx, cotoId, c.req.valid('json')));
      return c.json(sector, 201, { Location: `/api/v1/cotos/${cotoId}/sectores/${sector.id}` });
    })
    .openapi(actualizar, async (c) => {
      const { cotoId, id } = c.req.valid('param');
      const sector = await conTenant(c, deps, cotoId, (tx) => servicio.actualizar(tx, cotoId, id, c.req.valid('json')));
      return c.json(sector, 200);
    });
}
