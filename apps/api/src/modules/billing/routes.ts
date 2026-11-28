import { AppError } from '@admcotos/shared';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { respuestasError } from '../../lib/openapi.ts';
import { conTenant } from '../../lib/tenant.ts';
import type { AppEnv, Deps } from '../../types.ts';
import { EstadoBillingDto, OrgParam, PortalBillingDto } from './schemas.ts';
import * as servicio from './service.ts';

const estado = createRoute({
  method: 'get',
  path: '/orgs/{id}/billing',
  tags: ['billing'],
  summary: 'Consultar suscripción B2B, créditos y timbres disponibles',
  security: [{ bearer: [] }],
  request: { params: OrgParam },
  responses: {
    200: { description: 'Estado de facturación', content: { 'application/json': { schema: EstadoBillingDto } } },
    ...respuestasError(401, 403, 404, 422),
  },
});

const portal = createRoute({
  method: 'post',
  path: '/orgs/{id}/billing/portal',
  tags: ['billing'],
  summary: 'Abrir sesión del portal de facturación Stripe (org_owner)',
  security: [{ bearer: [] }],
  request: { params: OrgParam },
  responses: {
    200: { description: 'URL de sesión temporal', content: { 'application/json': { schema: PortalBillingDto } } },
    ...respuestasError(401, 403, 404, 409, 422),
  },
});

export function billingRoutes(deps: Pick<Deps, 'prisma' | 'env' | 'stripe'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(estado, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(await conTenant(c, deps, undefined, (tx) => servicio.obtenerEstadoBilling(tx, id)), 200);
    })
    .openapi(portal, async (c) => {
      const stripe = deps.stripe;
      if (!stripe) {
        throw new AppError(503, 'servicio_no_configurado', 'El servicio de cobro Stripe no está configurado');
      }
      const { id } = c.req.valid('param');
      const returnUrl = deps.env.STRIPE_PORTAL_RETURN_URL ?? `${deps.env.APP_PUBLIC_URL.replace(/\/$/, '')}/billing`;
      const res = await servicio.generarUrlPortalBilling({
        txWrapper: (fn) => conTenant(c, deps, undefined, fn),
        orgId: id,
        returnUrl,
        stripe,
      });
      return c.json(res, 200);
    });
}
