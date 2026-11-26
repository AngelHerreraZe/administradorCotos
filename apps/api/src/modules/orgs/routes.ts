import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { Coto } from '../cotos/schemas.ts';
import {
  ActualizarOrganizacion,
  CotoResumen,
  CrearCoto,
  CrearSoporte,
  Organizacion,
  OrgParam,
  SoporteAccesoDto,
} from './schemas.ts';
import * as servicio from './service.ts';

const obtener = createRoute({
  method: 'get',
  path: '/orgs/{orgId}',
  tags: ['organizaciones'],
  summary: 'Obtener organización',
  description: 'Permiso en BD: `orgs_lectura`.',
  security: [{ bearer: [] }],
  request: { params: OrgParam },
  responses: {
    200: { description: 'Organización', content: { 'application/json': { schema: Organizacion } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/orgs/{orgId}',
  tags: ['organizaciones'],
  summary: 'Actualizar marca blanca y contacto de la organización',
  description: 'Permiso en BD: `orgs_owner` con MFA. Nunca modifica billing ni tier.',
  security: [{ bearer: [] }],
  request: {
    params: OrgParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarOrganizacion } } },
  },
  responses: {
    200: { description: 'Actualizada', content: { 'application/json': { schema: Organizacion } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const listarCotos = createRoute({
  method: 'get',
  path: '/orgs/{orgId}/cotos',
  tags: ['organizaciones'],
  summary: 'Listar cotos de la organización con KPIs de resumen',
  description: 'Permiso en BD: `orgs_lectura`.',
  security: [{ bearer: [] }],
  request: { params: OrgParam },
  responses: {
    200: {
      description: 'Cotos y métricas',
      content: { 'application/json': { schema: z.object({ datos: z.array(CotoResumen) }) } },
    },
    ...respuestasError(401, 403, 422),
  },
});

const crearCoto = createRoute({
  method: 'post',
  path: '/orgs/{orgId}/cotos',
  tags: ['organizaciones'],
  summary: 'Crear coto dentro de la organización',
  description: 'Permiso en BD: `orgs_admin` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: OrgParam,
    body: { required: true, content: { 'application/json': { schema: CrearCoto } } },
  },
  responses: {
    201: { description: 'Coto creado', content: { 'application/json': { schema: Coto } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const abrirSoporte = createRoute({
  method: 'post',
  path: '/orgs/{orgId}/soporte',
  tags: ['organizaciones'],
  summary: 'Abrir ventana temporal de soporte técnico de solo lectura (≤ 72 h)',
  description: 'Permiso en BD: `orgs_owner` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: OrgParam,
    body: { required: true, content: { 'application/json': { schema: CrearSoporte } } },
  },
  responses: {
    201: { description: 'Ventana de soporte creada', content: { 'application/json': { schema: SoporteAccesoDto } } },
    ...respuestasError(401, 403, 422),
  },
});

export function orgsRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(obtener, async (c) => {
      const { orgId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.obtener(tx, orgId)), 200);
    })
    .openapi(actualizar, async (c) => {
      const { orgId } = c.req.valid('param');
      const datos = c.req.valid('json');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.actualizar(tx, orgId, datos)), 200);
    })
    .openapi(listarCotos, async (c) => {
      const { orgId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.listarCotos(tx, orgId)), 200);
    })
    .openapi(crearCoto, async (c) => {
      const { orgId } = c.req.valid('param');
      const datos = c.req.valid('json');
      const coto = await conTenant(c, deps, undefined, (tx) => servicio.crearCoto(tx, orgId, datos));
      return c.json(coto, 201, { Location: `/api/v1/cotos/${coto.id}` });
    })
    .openapi(abrirSoporte, async (c) => {
      const { orgId } = c.req.valid('param');
      const { usuarioId } = c.get('auth');
      const datos = c.req.valid('json');
      const acceso = await conTenant(c, deps, undefined, (tx) => servicio.abrirSoporte(tx, orgId, usuarioId, datos));
      return c.json(acceso, 201, { Location: `/api/v1/orgs/${orgId}/soporte/${acceso.id}` });
    });
}
