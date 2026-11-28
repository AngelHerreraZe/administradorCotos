import { AppError, Paginacion } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  ActivarAutopay,
  ActualizarAutopay,
  AgregarMetodoPago,
  AutopayConfigDto,
  AutopayIntentoDto,
  MetodoPagoDto,
  MetodoPagoParam,
  UnidadParam,
} from './schemas.ts';
import * as servicio from './service.ts';

const agregarMetodo = createRoute({
  method: 'post',
  path: '/unidades/{id}/metodos-pago',
  tags: ['autopay'],
  summary: 'Guardar método de pago tokenizado (nunca PAN/CVV)',
  security: [{ bearer: [] }],
  request: {
    params: UnidadParam,
    body: { required: true, content: { 'application/json': { schema: AgregarMetodoPago } } },
  },
  responses: {
    201: { description: 'Método de pago guardado', content: { 'application/json': { schema: MetodoPagoDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const listarMetodos = createRoute({
  method: 'get',
  path: '/unidades/{id}/metodos-pago',
  tags: ['autopay'],
  summary: 'Listar métodos de pago activos de la unidad',
  security: [{ bearer: [] }],
  request: { params: UnidadParam },
  responses: {
    200: {
      description: 'Métodos activos',
      content: { 'application/json': { schema: z.object({ datos: z.array(MetodoPagoDto) }) } },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const eliminarMetodo = createRoute({
  method: 'delete',
  path: '/unidades/{id}/metodos-pago/{metodoId}',
  tags: ['autopay'],
  summary: 'Desactivar método de pago de la unidad',
  security: [{ bearer: [] }],
  request: { params: MetodoPagoParam },
  responses: {
    200: {
      description: 'Desactivado',
      content: { 'application/json': { schema: z.object({ desactivado: z.boolean() }) } },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const activar = createRoute({
  method: 'post',
  path: '/unidades/{id}/autopay',
  tags: ['autopay'],
  summary: 'Activar domiciliación (solo propietario con aceptación explícita de términos)',
  security: [{ bearer: [] }],
  request: {
    params: UnidadParam,
    body: { required: true, content: { 'application/json': { schema: ActivarAutopay } } },
  },
  responses: {
    200: { description: 'Auto-Pay activado', content: { 'application/json': { schema: AutopayConfigDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const actualizar = createRoute({
  method: 'patch',
  path: '/unidades/{id}/autopay',
  tags: ['autopay'],
  summary: 'Pausar o actualizar domiciliación (administración solo puede pausar)',
  security: [{ bearer: [] }],
  request: {
    params: UnidadParam,
    body: { required: true, content: { 'application/json': { schema: ActualizarAutopay } } },
  },
  responses: {
    200: { description: 'Auto-Pay actualizado', content: { 'application/json': { schema: AutopayConfigDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const historial = createRoute({
  method: 'get',
  path: '/unidades/{id}/autopay/historial',
  tags: ['autopay'],
  summary: 'Historial de intentos de cobro automático de la unidad',
  security: [{ bearer: [] }],
  request: { params: UnidadParam, query: Paginacion },
  responses: {
    200: {
      description: 'Intentos paginados',
      content: {
        'application/json': { schema: z.object({ datos: z.array(AutopayIntentoDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

export function autopayRoutes(deps: Pick<Deps, 'prisma' | 'conekta'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(agregarMetodo, async (c) => {
      const conekta = deps.conekta;
      if (!conekta) {
        throw new AppError(503, 'servicio_no_configurado', 'La pasarela de pagos en línea no está configurada');
      }
      const { id } = c.req.valid('param');
      const { usuarioId } = c.get('auth');
      const res = await servicio.agregarMetodoPago({
        txWrapper: (fn) => conTenant(c, deps, undefined, fn),
        unidadId: id,
        usuarioId,
        datos: c.req.valid('json'),
        conekta,
      });
      return c.json(res, 201);
    })
    .openapi(listarMetodos, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.listarMetodos(tx, id)), 200);
    })
    .openapi(eliminarMetodo, async (c) => {
      const { id, metodoId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.desactivarMetodoPago(tx, id, metodoId)), 200);
    })
    .openapi(activar, async (c) => {
      const { id } = c.req.valid('param');
      const { usuarioId } = c.get('auth');
      return c.json(
        await conTenant(c, deps, undefined, (tx) => servicio.activarAutopay(tx, id, usuarioId, c.req.valid('json'))),
        200,
      );
    })
    .openapi(actualizar, async (c) => {
      const { id } = c.req.valid('param');
      const { usuarioId } = c.get('auth');
      return c.json(
        await conTenant(c, deps, undefined, (tx) => servicio.actualizarAutopay(tx, id, usuarioId, c.req.valid('json'))),
        200,
      );
    })
    .openapi(historial, async (c) => {
      const { id } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      return c.json(
        await conTenant(c, deps, undefined, (tx) => servicio.historialAutopay(tx, id, limite, cursor)),
        200,
      );
    });
}
