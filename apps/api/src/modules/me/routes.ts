import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { ActualizarMe, PerfilMe } from './schemas.ts';
import * as servicio from './service.ts';

const obtener = createRoute({
  method: 'get',
  path: '/me',
  tags: ['identidad'],
  summary: 'Perfil y membresías activas del usuario autenticado',
  security: [{ bearer: [] }],
  responses: {
    200: { description: 'Perfil actual', content: { 'application/json': { schema: PerfilMe } } },
    ...respuestasError(401, 403, 404),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['identidad'],
  summary: 'Actualizar datos propios permitidos (nombre, teléfono, aviso)',
  security: [{ bearer: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: ActualizarMe } } },
  },
  responses: {
    200: { description: 'Perfil actualizado', content: { 'application/json': { schema: PerfilMe } } },
    ...respuestasError(401, 403, 422),
  },
});

export function meRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(obtener, async (c) => {
      const { usuarioId } = c.get('auth');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.obtener(tx, usuarioId)), 200);
    })
    .openapi(actualizar, async (c) => {
      const { usuarioId } = c.get('auth');
      const datos = c.req.valid('json');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.actualizar(tx, usuarioId, datos)), 200);
    });
}
