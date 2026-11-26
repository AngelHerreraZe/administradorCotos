import { Paginacion } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { extraerIdempotencyKey } from '../../lib/prisma.ts';
import { conTenant, conTenantPreRegistro } from '../../lib/tenant.ts';
import { limiteTasaEstricto } from '../../middleware/rate-limit.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  AceptarInvitacion,
  CotoParam,
  CrearInvitacion,
  InvitacionAceptada,
  InvitacionDto,
  InvitacionParam,
} from './schemas.ts';
import * as servicio from './service.ts';

const IdempotencyHeader = z.object({
  'idempotency-key': z.uuid().optional(),
});

const aceptarRoute = createRoute({
  method: 'post',
  path: '/invitaciones/aceptar',
  tags: ['invitaciones'],
  summary: 'Aceptar invitación y activar membresía tras validar el correo en el JWT',
  security: [{ bearer: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: AceptarInvitacion } } },
  },
  responses: {
    200: { description: 'Invitación aceptada', content: { 'application/json': { schema: InvitacionAceptada } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const crearRoute = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/invitaciones',
  tags: ['invitaciones'],
  summary: 'Crear invitación de miembro para un coto y encolar correo',
  description: 'Permiso en BD: `cotos_admin` con MFA. Límite: 60/hora por usuario. Soporta `Idempotency-Key`.',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearInvitacion } } },
  },
  responses: {
    200: {
      description: 'Invitación ya existente (idempotente)',
      content: { 'application/json': { schema: InvitacionDto } },
    },
    201: { description: 'Invitación creada', content: { 'application/json': { schema: InvitacionDto } } },
    ...respuestasError(401, 403, 404, 422, 429),
  },
});

const listarRoute = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/invitaciones',
  tags: ['invitaciones'],
  summary: 'Listar invitaciones de un coto (paginado por cursor)',
  description: 'Permiso en BD: `cotos_admin` con MFA.',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: Paginacion },
  responses: {
    200: {
      description: 'Página de invitaciones',
      content: {
        'application/json': { schema: z.object({ datos: z.array(InvitacionDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const revocarRoute = createRoute({
  method: 'post',
  path: '/invitaciones/{id}/revocar',
  tags: ['invitaciones'],
  summary: 'Revocar una invitación pendiente',
  description: 'Permiso en BD: `cotos_admin` (o `orgs_owner` si es de organización), con MFA.',
  security: [{ bearer: [] }],
  request: { params: InvitacionParam },
  responses: {
    200: { description: 'Invitación revocada', content: { 'application/json': { schema: InvitacionDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function invitacionesPreRegistroRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>().openapi(aceptarRoute, async (c) => {
    const { authId, email } = c.get('authPre');
    const datos = c.req.valid('json');
    const res = await conTenantPreRegistro(c, deps, (tx) => servicio.aceptar(tx, { authId, email, datos }));
    return c.json(res, 200);
  });
}

export function invitacionesRoutes(deps: Pick<Deps, 'prisma' | 'env' | 'limitador' | 'encolarCorreo'>) {
  const app = new OpenAPIHono<AppEnv>();
  app.use('/cotos/:cotoId/invitaciones', async (c, next) => {
    if (c.req.method === 'POST') {
      return limiteTasaEstricto(deps.limitador, { prefijo: 'rl:inv', puntos: 60, duracionSegundos: 3600 })(c, next);
    }
    await next();
  });

  return app
    .openapi(crearRoute, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { usuarioId } = c.get('auth');
      const idempotencyKey = extraerIdempotencyKey(c.req.header('Idempotency-Key'));
      const datos = c.req.valid('json');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crear(tx, { cotoId, usuarioId, datos, appPublicUrl: deps.env.APP_PUBLIC_URL, idempotencyKey }),
      );
      if (!res.creado) {
        return c.json(res.dto, 200);
      }
      if (res.correo) {
        await deps.encolarCorreo(res.correo, { jobId: res.jobId });
      }
      return c.json(res.dto, 201, { Location: `/api/v1/invitaciones/${res.dto.id}` });
    })
    .openapi(listarRoute, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, limite, cursor)), 200);
    })
    .openapi(revocarRoute, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.revocar(tx, id)), 200);
    });
}
