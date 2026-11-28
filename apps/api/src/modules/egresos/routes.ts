import { AppError } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  ActualizarEgreso,
  CotoParam,
  CrearEgreso,
  EgresoCotoParam,
  EgresoDto,
  EgresoParam,
  ListarEgresosQuery,
  RechazarEgreso,
  SolicitarUrlComprobanteEgreso,
} from './schemas.ts';
import * as servicio from './service.ts';

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/egresos',
  tags: ['finanzas'],
  summary: 'Listar egresos del coto (staff)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarEgresosQuery },
  responses: {
    200: {
      description: 'Egresos paginados',
      content: {
        'application/json': { schema: z.object({ datos: z.array(EgresoDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const crear = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/egresos',
  tags: ['finanzas'],
  summary: 'Solicitar un egreso (tesorería)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearEgreso } } },
  },
  responses: {
    201: { description: 'Egreso creado en estado pendiente', content: { 'application/json': { schema: EgresoDto } } },
    200: { description: 'Egreso ya registrado (idempotente)', content: { 'application/json': { schema: EgresoDto } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/cotos/{cotoId}/egresos/{id}',
  tags: ['finanzas'],
  summary: 'Actualizar datos o marcar pagado un egreso aprobado',
  security: [{ bearer: [] }],
  request: {
    params: EgresoCotoParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarEgreso } } },
  },
  responses: {
    200: { description: 'Egreso actualizado', content: { 'application/json': { schema: EgresoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const aprobar = createRoute({
  method: 'post',
  path: '/egresos/{id}/aprobar',
  tags: ['finanzas'],
  summary: 'Aprobar egreso (tesorería; quien solicita no puede aprobar)',
  security: [{ bearer: [] }],
  request: { params: EgresoParam },
  responses: {
    200: { description: 'Egreso aprobado', content: { 'application/json': { schema: EgresoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const rechazar = createRoute({
  method: 'post',
  path: '/egresos/{id}/rechazar',
  tags: ['finanzas'],
  summary: 'Rechazar egreso pendiente',
  security: [{ bearer: [] }],
  request: {
    params: EgresoParam,
    body: { required: true, content: { 'application/json': { schema: RechazarEgreso } } },
  },
  responses: {
    200: { description: 'Egreso rechazado', content: { 'application/json': { schema: EgresoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const urlComprobante = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/egresos/comprobante-url',
  tags: ['finanzas'],
  summary: 'Obtener URL prefirmada para subir comprobante/factura de un egreso a S3/R2',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'application/json': { schema: SolicitarUrlComprobanteEgreso } } },
  },
  responses: {
    200: {
      description: 'Formulario prefirmado (5 min)',
      content: {
        'application/json': {
          schema: z.object({
            url: z.string(),
            fields: z.record(z.string(), z.string()),
            llave: z.string(),
            expiraEnSegundos: z.number().int(),
          }),
        },
      },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

export function egresosRoutes(deps: Pick<Deps, 'prisma' | 'storage'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const query = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, query)), 200);
    })
    .openapi(crear, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crear(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado
        ? c.json(res.dato, 201, { Location: `/api/v1/cotos/${cotoId}/egresos/${res.dato.id}` })
        : c.json(res.dato, 200);
    })
    .openapi(actualizar, async (c) => {
      const { cotoId, id } = c.req.valid('param');
      const res = await conTenant(c, deps, cotoId, (tx) => servicio.actualizar(tx, cotoId, id, c.req.valid('json')));
      return c.json(res, 200);
    })
    .openapi(aprobar, async (c) => {
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.aprobar(tx, id));
      return c.json(res, 200);
    })
    .openapi(rechazar, async (c) => {
      const { id } = c.req.valid('param');
      const { motivo } = c.req.valid('json');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.rechazar(tx, id, motivo));
      return c.json(res, 200);
    })
    .openapi(urlComprobante, async (c) => {
      const storage = deps.storage;
      if (!storage) {
        throw new AppError(503, 'servicio_no_configurado', 'El almacenamiento de archivos no está configurado');
      }
      const { cotoId } = c.req.valid('param');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.generarUrlSubidaComprobanteEgreso(tx, cotoId, c.req.valid('json'), storage),
      );
      return c.json(res, 200);
    });
}
