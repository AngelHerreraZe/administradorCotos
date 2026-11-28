import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  CotoParam,
  CrearVotacion,
  EmitirVoto,
  ListarVotacionesQuery,
  ResultadosDto,
  VotacionDto,
  VotacionParam,
} from './schemas.ts';
import * as servicio from './service.ts';

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/votaciones',
  tags: ['votaciones'],
  summary: 'Crear votación con opciones (administración)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearVotacion } } },
  },
  responses: {
    201: { description: 'Creada en borrador', content: { 'application/json': { schema: VotacionDto } } },
    200: { description: 'Ya existía (idempotente)', content: { 'application/json': { schema: VotacionDto } } },
    ...respuestasError(401, 403, 422),
  },
});

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/votaciones',
  tags: ['votaciones'],
  summary: 'Votaciones visibles (staff: todas; miembros: no borradores)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarVotacionesQuery },
  responses: {
    200: {
      description: 'Página',
      content: {
        'application/json': { schema: z.object({ datos: z.array(VotacionDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const accion = (verbo: 'abrir' | 'cerrar', summary: string) =>
  createRoute({
    method: 'post',
    path: `/votaciones/{id}/${verbo}`,
    tags: ['votaciones'],
    summary,
    security: [{ bearer: [] }],
    request: { params: VotacionParam },
    responses: {
      200: { description: 'Actualizada', content: { 'application/json': { schema: VotacionDto } } },
      ...respuestasError(401, 403, 404, 409, 422),
    },
  });

const abrir = accion('abrir', 'Abrir (administración): programada hasta la fecha de inicio, o activa');
const cerrar = accion('cerrar', 'Cerrar anticipadamente (administración)');

const votar = createRoute({
  method: 'post',
  path: '/votaciones/{id}/votos',
  tags: ['votaciones'],
  summary: 'Emitir voto (persona propietaria de la unidad; uno por unidad)',
  security: [{ bearer: [] }],
  request: { params: VotacionParam, body: { required: true, content: { 'application/json': { schema: EmitirVoto } } } },
  responses: {
    201: {
      description: 'Voto registrado',
      content: { 'application/json': { schema: z.object({ votoId: z.uuid() }) } },
    },
    ...respuestasError(401, 403, 409, 422),
  },
});

const resultados = createRoute({
  method: 'get',
  path: '/votaciones/{id}/resultados',
  tags: ['votaciones'],
  summary: 'Resultados agregados (staff): votos, peso y quórum por indiviso',
  security: [{ bearer: [] }],
  request: { params: VotacionParam },
  responses: {
    200: { description: 'Resultados', content: { 'application/json': { schema: ResultadosDto } } },
    ...respuestasError(401, 404),
  },
});

export function votacionesRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crear(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado
        ? c.json(res.dato, 201, { Location: `/api/v1/votaciones/${res.dato.id}` })
        : c.json(res.dato, 200);
    })
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, c.req.valid('query'))), 200);
    })
    .openapi(abrir, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.abrir(tx, id)), 200);
    })
    .openapi(cerrar, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.cerrar(tx, id)), 200);
    })
    .openapi(votar, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.votar(tx, id, c.req.valid('json'))), 201);
    })
    .openapi(resultados, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.resultados(tx, id)), 200);
    });
}
