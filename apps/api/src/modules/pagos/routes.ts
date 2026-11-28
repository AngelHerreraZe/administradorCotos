import { AppError } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  CotoParam,
  CrearPagoManual,
  CrearPagoOnline,
  ListarPagosQuery,
  PagoDto,
  PagoOnlineDto,
  PagoParam,
  RechazarPago,
  RegistrarComprobante,
  SolicitarUrlComprobante,
} from './schemas.ts';
import * as servicio from './service.ts';

async function enviarReciboSeguro(
  deps: Pick<Deps, 'encolarCorreo' | 'log'>,
  pagoId: string,
  recibo?: servicio.ContextoRecibo,
) {
  if (!recibo) return;
  try {
    await deps.encolarCorreo(
      {
        plantilla: 'recibo',
        para: recibo.email,
        datos: {
          coto: recibo.coto,
          unidad: recibo.unidad,
          monto: recibo.monto,
          fecha: recibo.fecha,
        },
      },
      { jobId: `recibo-${pagoId}` },
    );
  } catch (err) {
    deps.log.warn({ err, pagoId }, 'no se pudo encolar recibo de pago');
  }
}

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/pagos',
  tags: ['pagos'],
  summary: 'Listar pagos del coto (finanzas o propietario)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: ListarPagosQuery },
  responses: {
    200: {
      description: 'Pagos paginados',
      content: {
        'application/json': { schema: z.object({ datos: z.array(PagoDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const crearManual = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/pagos',
  tags: ['pagos'],
  summary: 'Registrar pago manual confirmado y aplicarlo FIFO a cargos',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearPagoManual } } },
  },
  responses: {
    201: { description: 'Pago registrado y aplicado', content: { 'application/json': { schema: PagoDto } } },
    200: { description: 'Pago ya registrado (idempotente)', content: { 'application/json': { schema: PagoDto } } },
    ...respuestasError(401, 403, 409, 422),
  },
});

const urlComprobante = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/comprobantes/url',
  tags: ['pagos'],
  summary: 'Obtener URL prefirmada para subir comprobante directo a S3/R2',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'application/json': { schema: SolicitarUrlComprobante } } },
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

const registrarComprobante = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/pagos/comprobante',
  tags: ['pagos'],
  summary: 'Registrar comprobante de transferencia en revisión',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: RegistrarComprobante } } },
  },
  responses: {
    201: { description: 'Pago en revisión creado', content: { 'application/json': { schema: PagoDto } } },
    200: { description: 'Pago ya registrado (idempotente)', content: { 'application/json': { schema: PagoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const confirmar = createRoute({
  method: 'post',
  path: '/pagos/{id}/confirmar',
  tags: ['pagos'],
  summary: 'Confirmar pago pendiente o en revisión y aplicarlo a cargos',
  security: [{ bearer: [] }],
  request: { params: PagoParam },
  responses: {
    200: { description: 'Pago confirmado', content: { 'application/json': { schema: PagoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const rechazar = createRoute({
  method: 'post',
  path: '/pagos/{id}/rechazar',
  tags: ['pagos'],
  summary: 'Rechazar pago pendiente o en revisión',
  security: [{ bearer: [] }],
  request: { params: PagoParam, body: { required: true, content: { 'application/json': { schema: RechazarPago } } } },
  responses: {
    200: { description: 'Pago rechazado', content: { 'application/json': { schema: PagoDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const descargarComprobante = createRoute({
  method: 'get',
  path: '/pagos/{id}/comprobante',
  tags: ['pagos'],
  summary: 'Obtener URL firmada temporal (2 min) del comprobante',
  security: [{ bearer: [] }],
  request: { params: PagoParam },
  responses: {
    200: {
      description: 'URL temporal',
      content: { 'application/json': { schema: z.object({ url: z.string(), expiraEnSegundos: z.number().int() }) } },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const crearOnline = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/pagos/online',
  tags: ['pagos'],
  summary: 'Iniciar pago en línea con Conekta (tarjeta, SPEI u OXXO)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: CrearPagoOnline } } },
  },
  responses: {
    201: { description: 'Orden de pago creada', content: { 'application/json': { schema: PagoOnlineDto } } },
    200: {
      description: 'Orden ya existente (idempotente)',
      content: { 'application/json': { schema: PagoOnlineDto } },
    },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function pagosRoutes(deps: Pick<Deps, 'prisma' | 'encolarCorreo' | 'log' | 'storage' | 'conekta'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const query = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listar(tx, cotoId, query)), 200);
    })
    .openapi(crearManual, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.crearManual(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      if (res.creado) {
        await enviarReciboSeguro(deps, res.dato.id, res.recibo);
        return c.json(res.dato, 201, { Location: `/api/v1/cotos/${cotoId}/pagos/${res.dato.id}` });
      }
      return c.json(res.dato, 200);
    })
    .openapi(urlComprobante, async (c) => {
      const storage = deps.storage;
      if (!storage) {
        throw new AppError(503, 'servicio_no_configurado', 'El almacenamiento de archivos no está configurado');
      }
      const { cotoId } = c.req.valid('param');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.generarUrlSubidaComprobante(tx, cotoId, c.req.valid('json'), storage),
      );
      return c.json(res, 200);
    })
    .openapi(registrarComprobante, async (c) => {
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.registrarComprobante(tx, cotoId, usuarioId, c.req.valid('json'), clave),
      );
      return res.creado
        ? c.json(res.dato, 201, { Location: `/api/v1/cotos/${cotoId}/pagos/${res.dato.id}` })
        : c.json(res.dato, 200);
    })
    .openapi(confirmar, async (c) => {
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.confirmar(tx, id));
      if (res.recienConfirmado) {
        await enviarReciboSeguro(deps, res.dato.id, res.recibo);
      }
      return c.json(res.dato, 200);
    })
    .openapi(rechazar, async (c) => {
      const { id } = c.req.valid('param');
      const { motivo } = c.req.valid('json');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.rechazar(tx, id, motivo));
      return c.json(res, 200);
    })
    .openapi(descargarComprobante, async (c) => {
      const storage = deps.storage;
      if (!storage) {
        throw new AppError(503, 'servicio_no_configurado', 'El almacenamiento de archivos no está configurado');
      }
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.obtenerUrlDescargaComprobante(tx, id, storage));
      return c.json(res, 200);
    })
    .openapi(crearOnline, async (c) => {
      if (!deps.conekta) {
        throw new AppError(503, 'servicio_no_configurado', 'La pasarela de pagos en línea no está configurada');
      }
      const { cotoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      if (!clave) {
        throw new AppError(422, 'idempotency_requerida', 'Envía el encabezado Idempotency-Key para pagos en línea');
      }
      const { usuarioId } = c.get('auth');
      const res = await servicio.crearOrdenYGuardarPagoOnline({
        txWrapper: (fn) => conTenant(c, deps, cotoId, fn),
        cotoId,
        usuarioId,
        datos: c.req.valid('json'),
        claveIdempotencia: clave,
        conekta: deps.conekta,
      });
      return res.creado ? c.json(res.resultado, 201) : c.json(res.resultado, 200);
    });
}
