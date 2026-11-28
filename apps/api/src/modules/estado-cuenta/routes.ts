import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { EstadoCuentaDto, UnidadParam } from './schemas.ts';
import * as servicio from './service.ts';

const obtener = createRoute({
  method: 'get',
  path: '/unidades/{id}/estado-cuenta',
  tags: ['finanzas'],
  summary: 'Obtener estado de cuenta de una unidad (finanzas o propietario)',
  security: [{ bearer: [] }],
  request: { params: UnidadParam },
  responses: {
    200: { description: 'Estado de cuenta', content: { 'application/json': { schema: EstadoCuentaDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const obtenerPdf = createRoute({
  method: 'get',
  path: '/unidades/{id}/estado-cuenta.pdf',
  tags: ['finanzas'],
  summary: 'Descargar estado de cuenta en PDF (máx. 2 páginas)',
  security: [{ bearer: [] }],
  request: { params: UnidadParam },
  responses: {
    200: { description: 'PDF binario', content: { 'application/pdf': { schema: z.string() } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

export function estadoCuentaRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(obtener, async (c) => {
      const { id } = c.req.valid('param');
      const res = await conTenant(c, deps, undefined, (tx) => servicio.obtener(tx, id));
      return c.json(res, 200);
    })
    .openapi(obtenerPdf, async (c) => {
      const { id } = c.req.valid('param');
      const estado = await conTenant(c, deps, undefined, (tx) => servicio.obtener(tx, id));
      const pdf = await servicio.renderizarPdf(estado);
      const numeroSeguro = estado.unidad.replace(/[^a-zA-Z0-9_-]/g, '_');
      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="estado-cuenta-${numeroSeguro}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
    });
}
