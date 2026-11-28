import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { BalanceQuery, CotoParam, FilaBalanceDto, FilaMorosidadDto, ResumenCotoDto } from './schemas.ts';
import * as servicio from './service.ts';

const resumen = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/resumen',
  tags: ['reportes'],
  summary: 'KPIs financieros agregados del coto (staff)',
  security: [{ bearer: [] }],
  request: { params: CotoParam },
  responses: {
    200: { description: 'Resumen del coto', content: { 'application/json': { schema: ResumenCotoDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const morosidad = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/morosidad',
  tags: ['reportes'],
  summary: 'Detalle de morosos por unidad (solo finanzas; bloqueado a comité y residentes)',
  security: [{ bearer: [] }],
  request: { params: CotoParam },
  responses: {
    200: {
      description: 'Morosidad por unidad',
      content: { 'application/json': { schema: z.object({ datos: z.array(FilaMorosidadDto) }) } },
    },
    ...respuestasError(401, 403, 422),
  },
});

const balance = createRoute({
  method: 'get',
  path: '/cotos/{cotoId}/balance',
  tags: ['reportes'],
  summary: 'Balance mensual ingresos vs egresos (staff)',
  security: [{ bearer: [] }],
  request: { params: CotoParam, query: BalanceQuery },
  responses: {
    200: {
      description: 'Serie mensual',
      content: { 'application/json': { schema: z.object({ datos: z.array(FilaBalanceDto) }) } },
    },
    ...respuestasError(401, 403, 422),
  },
});

export function reportesRoutes(deps: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(resumen, async (c) => {
      const { cotoId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.resumen(tx, cotoId)), 200);
    })
    .openapi(morosidad, async (c) => {
      const { cotoId } = c.req.valid('param');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.morosidad(tx, cotoId)), 200);
    })
    .openapi(balance, async (c) => {
      const { cotoId } = c.req.valid('param');
      const { meses } = c.req.valid('query');
      return c.json(await conTenant(c, deps, cotoId, (tx) => servicio.balance(tx, cotoId, meses)), 200);
    });
}
