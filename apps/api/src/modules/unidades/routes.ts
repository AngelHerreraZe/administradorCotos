import { Readable } from 'node:stream';
import { AppError, Paginacion } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { ActualizarUnidad, CotoParam, CrearUnidad, ResultadoImportacion, Unidad, UnidadParam } from './schemas.ts';
import * as servicio from './service.ts';

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/unidades',
  tags: ['unidades'],
  summary: 'Crear una unidad',
  description: 'Permiso en BD: `cotos_admin` (administración del coto o despacho al corriente, con MFA).',
  security: [{ bearer: [] }],
  request: { params: CotoParam, body: { required: true, content: { 'application/json': { schema: CrearUnidad } } } },
  responses: {
    201: { description: 'Creada', content: { 'application/json': { schema: Unidad } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/unidades',
  tags: ['unidades'],
  summary: 'Listar unidades (paginado por cursor)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: Paginacion },
  responses: {
    200: {
      description: 'Página',
      content: { 'application/json': { schema: z.object({ datos: z.array(Unidad), siguiente: z.uuid().optional() }) } },
    },
    ...respuestasError(401, 403, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/cotos/{cotoId}/unidades/{id}',
  tags: ['unidades'],
  summary: 'Actualizar una unidad',
  description: 'Permiso en BD: `cotos_admin` con MFA.',
  security: [{ bearer: [] }],
  request: {
    params: UnidadParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarUnidad } } },
  },
  responses: {
    200: { description: 'Actualizada', content: { 'application/json': { schema: Unidad } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const importar = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/unidades/importar',
  tags: ['unidades'],
  summary: 'Importar unidades desde CSV (streaming, ≤ 5 000 filas)',
  description: 'Permiso en BD: `cotos_admin` con MFA. Valida todo antes de insertar en una transacción.',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'text/csv': { schema: z.string() } } },
  },
  responses: {
    201: { description: 'Unidades importadas', content: { 'application/json': { schema: ResultadoImportacion } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

export function unidadesRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const unidad = await conTenant(c, deps, cotoId, (tx) => servicio.crear(tx, cotoId, c.req.valid('json')));
      return c.json(unidad, 201, { Location: `/api/v1/cotos/${cotoId}/unidades/${unidad.id}` });
    })
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, limite, cursor)), 200);
    })
    .openapi(actualizar, async (c) => {
      const { cotoId, id } = c.req.valid('param');
      const unidad = await conTenant(c, deps, cotoId, (tx) => servicio.actualizar(tx, cotoId, id, c.req.valid('json')));
      return c.json(unidad, 200);
    })
    .openapi(importar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const contentType = c.req.header('content-type') ?? '';
      if (!contentType.toLowerCase().includes('text/csv') && !contentType.toLowerCase().includes('text/plain')) {
        throw new AppError(422, 'tipo_contenido_invalido', 'Envía el archivo con Content-Type: text/csv');
      }
      const stream = c.req.raw.body
        ? Readable.fromWeb(c.req.raw.body as Parameters<typeof Readable.fromWeb>[0])
        : Readable.from([await c.req.text()]);
      const res = await conTenant(c, deps, cotoId, (tx) => servicio.importarCsv(tx, cotoId, stream));
      return c.json(res, 201);
    });
}
