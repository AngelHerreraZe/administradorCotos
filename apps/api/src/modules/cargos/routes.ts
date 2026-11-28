import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  CargoDto,
  CargoParam,
  CondonarCargo,
  CotoParam,
  CrearCargo,
  GenerarCargos,
  ListarCargosQuery,
} from './schemas.ts';
import * as servicio from './service.ts';

const generar = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/cargos/generar',
  tags: ['finanzas'],
  summary: 'Generar cargos masivos por periodo (idempotente)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, body: { required: true, content: { 'application/json': { schema: GenerarCargos } } } },
  responses: {
    200: {
      description: 'Cargos generados',
      content: { 'application/json': { schema: z.object({ creados: z.number().int() }) } },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/cargos',
  tags: ['finanzas'],
  summary: 'Crear cargo individual (multa, extraordinario)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearCargo } } },
  },
  responses: {
    201: { description: 'Cargo creado', content: { 'application/json': { schema: CargoDto } } },
    200: { description: 'Cargo ya existente (idempotente)', content: { 'application/json': { schema: CargoDto } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/cargos',
  tags: ['finanzas'],
  summary: 'Listar cargos del coto (finanzas o propietario)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarCargosQuery },
  responses: {
    200: {
      description: 'Cargos paginados',
      content: {
        'application/json': { schema: z.object({ datos: z.array(CargoDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const condonar = createRoute({
  method: 'post',
  path: '/cargos/{id}/condonar',
  tags: ['finanzas'],
  summary: 'Condonar saldo pendiente de un cargo dejando rastro en auditoría',
  security: [{ bearer: [] }],
  request: { params: CargoParam, body: { required: true, content: { 'application/json': { schema: CondonarCargo } } } },
  responses: {
    200: { description: 'Cargo condonado', content: { 'application/json': { schema: CargoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function cargosRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(generar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const res = await conTenant(c, deps, cotoId, (tx) => servicio.generar(tx, cotoId, c.req.valid('json')));
      return c.json(res, 200);
    })
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crear(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado
        ? c.json(res.dato, 201, { Location: `/api/v1/cotos/${cotoId}/cargos/${res.dato.id}` })
        : c.json(res.dato, 200);
    })
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const query = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, query)), 200);
    })
    .openapi(condonar, async (c) => {
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.condonar(tx, id, c.req.valid('json')));
      return c.json(res, 200);
    });
}
