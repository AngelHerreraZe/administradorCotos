import { AppError, Paginacion } from '@admcotos/shared';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { IdempotencyHeader, respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import {
  CancelarFactura,
  ConfigurarCfdiCoto,
  CotoParam,
  FacturaCfdiDto,
  FacturaParam,
  SolicitarTimbrado,
  TimbrarParam,
} from './schemas.ts';
import * as servicio from './service.ts';

const configurar = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/cfdi/configurar',
  tags: ['cfdi'],
  summary:
    'Registrar o actualizar emisor del coto en Facturapi y guardar su llave cifrada (CSD se carga directo en PAC)',
  security: [{ bearer: [] }],
  request: {
    params: CotoParam,
    body: { required: true, content: { 'application/json': { schema: ConfigurarCfdiCoto } } },
  },
  responses: {
    200: {
      description: 'Emisor configurado',
      content: { 'application/json': { schema: z.object({ facturapiOrgId: z.string(), rfcCoto: z.string() }) } },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const timbrarPago = createRoute({
  method: 'post',
  path: '/cotos/{cotoId}/facturacion/timbrar/{pagoId}',
  tags: ['cfdi'],
  summary: 'Validar datos fiscales, verificar timbres y encolar timbrado CFDI 4.0',
  security: [{ bearer: [] }],
  request: {
    params: TimbrarParam,
    headers: IdempotencyHeader,
    body: { required: true, content: { 'application/json': { schema: SolicitarTimbrado } } },
  },
  responses: {
    202: {
      description: 'Timbrado encolado',
      content: { 'application/json': { schema: z.object({ status: z.literal('encolado'), pagoId: z.uuid() }) } },
    },
    200: {
      description: 'Pago ya con timbrado activo o en curso',
      content: { 'application/json': { schema: FacturaCfdiDto } },
    },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

const listar = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/facturacion',
  tags: ['cfdi'],
  summary: 'Listar facturas CFDI emitidas del coto',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: Paginacion },
  responses: {
    200: {
      description: 'Facturas paginadas',
      content: {
        'application/json': { schema: z.object({ datos: z.array(FacturaCfdiDto), siguiente: z.uuid().optional() }) },
      },
    },
    ...respuestasError(401, 403, 422),
  },
});

const descargar = createRoute({
  method: 'get',
  path: '/facturas/{id}/descarga',
  tags: ['cfdi'],
  summary: 'Obtener URLs temporales de descarga de XML y PDF timbrados',
  security: [{ bearer: [] }],
  request: { params: FacturaParam },
  responses: {
    200: {
      description: 'URLs temporales (2 min)',
      content: {
        'application/json': {
          schema: z.object({
            xmlUrl: z.string().nullable(),
            pdfUrl: z.string().nullable(),
            expiraEnSegundos: z.number().int(),
          }),
        },
      },
    },
    ...respuestasError(401, 403, 404, 422),
  },
});

const cancelar = createRoute({
  method: 'post',
  path: '/facturas/{id}/cancelar',
  tags: ['cfdi'],
  summary: 'Encolar cancelación de CFDI ante el SAT',
  security: [{ bearer: [] }],
  request: {
    params: FacturaParam,
    body: { required: true, content: { 'application/json': { schema: CancelarFactura } } },
  },
  responses: {
    202: {
      description: 'Cancelación encolada',
      content: { 'application/json': { schema: z.object({ status: z.literal('encolado'), facturaId: z.uuid() }) } },
    },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function cfdiRoutes(deps: Pick<Deps, 'prisma' | 'cfdi' | 'encolarCfdi' | 'storage'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(configurar, async (c) => {
      const { cfdi, encolarCfdi } = deps;
      if (!cfdi || !encolarCfdi) {
        throw new AppError(503, 'servicio_no_configurado', 'El servicio PAC de timbrado o su cola no está configurada');
      }
      const { cotoId } = c.req.valid('param');
      const res = await servicio.configurarEmisor({
        txWrapper: (fn) => conTenant(c, deps, cotoId, fn),
        cotoId,
        datos: c.req.valid('json'),
        cfdi,
        encolarCfdi,
      });
      return c.json(res, 200);
    })
    .openapi(timbrarPago, async (c) => {
      const encolarCfdi = deps.encolarCfdi;
      if (!encolarCfdi) throw new AppError(503, 'servicio_no_configurado', 'La cola de timbrado no está configurada');
      const { cotoId, pagoId } = c.req.valid('param');
      const clave = c.req.valid('header')['idempotency-key']?.toLowerCase();
      const { usuarioId } = c.get('auth');
      const res = await conTenant(c, deps, cotoId, (tx) =>
        servicio.encolarTimbrado({
          tx,
          cotoId,
          usuarioId,
          pagoId,
          receptor: c.req.valid('json'),
          encolarCfdi,
          idempotencyKey: clave,
        }),
      );
      return res.encolado ? c.json({ status: res.status, pagoId: res.pagoId }, 202) : c.json(res.factura, 200);
    })
    .openapi(listar, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { limite, cursor } = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.listarFacturas(tx, cotoId, limite, cursor)), 200);
    })
    .openapi(descargar, async (c) => {
      const storage = deps.storage;
      if (!storage) throw new AppError(503, 'servicio_no_configurado', 'El almacenamiento no está configurado');
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.urlsDescargaFactura(tx, id, storage)), 200);
    })
    .openapi(cancelar, async (c) => {
      const encolarCfdi = deps.encolarCfdi;
      if (!encolarCfdi) throw new AppError(503, 'servicio_no_configurado', 'La cola de timbrado no está configurada');
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) =>
        servicio.encolarCancelacion({ tx, facturaId: id, datos: c.req.valid('json'), encolarCfdi }),
      );
      return c.json(res, 202);
    });
}
