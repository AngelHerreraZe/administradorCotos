import { Paginacion } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { ActualizarMiembro, CotoParam, MiembroCotoDto, MiembroParam } from './schemas.ts';
import * as servicio from './service.ts';

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/miembros',
  tags: ['miembros'],
  summary: 'Listar directorio del coto (miembros_coto ⋈ usuarios)',
  description: 'Permiso en BD: `cotos_staff`.',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: Paginacion },
  responses: {
    200: {
      description: 'Página de miembros',
      content: {
        'application/json': { schema: z.object({ datos: z.array(MiembroCotoDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/cotos/{cotoId}/miembros/{id}',
  tags: ['miembros'],
  summary: 'Actualizar rol, unidad o estado de un miembro',
  description: 'Permiso en BD: `cotos_admin` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: MiembroParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarMiembro } } },
  },
  responses: {
    200: { description: 'Actualizado', content: { 'application/json': { schema: MiembroCotoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function miembrosRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, limite, cursor)), 200);
    })
    .openapi(actualizar, async (c) => {
      const { cotoId, id } = c.req.valid('param');
      const miembro = await conTenant(c, deps, cotoId, (tx) =>
        servicio.actualizar(tx, cotoId, id, c.req.valid('json')),
      );
      return c.json(miembro, 200);
    });
}
