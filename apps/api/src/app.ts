import { OpenAPIHono } from '@hono/zod-openapi';
import { requestId } from 'hono/request-id';
import { autenticacion, autenticacionPreRegistro, crearResolvedorUsuario } from './middleware/auth.ts';
import { manejarError, noEncontrado, validacion } from './middleware/errors.ts';
import { registroPeticiones } from './middleware/logging.ts';
import { limiteTasaPorIp, limiteTasaPorUsuario } from './middleware/rate-limit.ts';
import { seguridadBase, seguridadCors } from './middleware/security.ts';
import { autopayRoutes } from './modules/autopay/routes.ts';
import { billingRoutes } from './modules/billing/routes.ts';
import { cargosRoutes } from './modules/cargos/routes.ts';
import { cfdiRoutes } from './modules/cfdi/routes.ts';
import { comunicadosRoutes } from './modules/comunicados/routes.ts';
import { conceptosRoutes } from './modules/conceptos/routes.ts';
import { cotosRoutes } from './modules/cotos/routes.ts';
import { egresosRoutes } from './modules/egresos/routes.ts';
import { estadoCuentaRoutes } from './modules/estado-cuenta/routes.ts';
import { invitacionesPreRegistroRoutes, invitacionesRoutes } from './modules/invitaciones/routes.ts';
import { meRoutes } from './modules/me/routes.ts';
import { miembrosRoutes } from './modules/miembros/routes.ts';
import { orgsRoutes } from './modules/orgs/routes.ts';
import { pagosRoutes } from './modules/pagos/routes.ts';
import { reportesRoutes } from './modules/reportes/routes.ts';
import { sectoresRoutes } from './modules/sectores/routes.ts';
import { ticketsRoutes } from './modules/tickets/routes.ts';
import { unidadesRoutes } from './modules/unidades/routes.ts';
import { votacionesRoutes } from './modules/votaciones/routes.ts';
import { webhooksRoutes } from './modules/webhooks/routes.ts';
import { healthRoutes } from './routes/health.ts';
import type { AppEnv, Deps } from './types.ts';

/**
 * Construye la app sin abrir puertos: main.ts la sirve y las pruebas la llaman con app.request().
 * Cada módulo de negocio se monta aquí bajo `/api/v1`.
 */
export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validacion });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  app.use(requestId({ headerName: 'X-Request-Id' }));
  app.use(registroPeticiones(deps.log));
  for (const mw of seguridadBase()) app.use(mw);

  // Webhooks públicos: fuera de autenticación y fuera de CORS.
  app.route('/webhooks', webhooksRoutes(deps));

  const corsMw = seguridadCors(deps.env);
  app.use('/health/*', corsMw);
  app.use('/api/*', corsMw);
  app.use('/openapi.json', corsMw);

  // Rutas públicas web
  app.route('/health', healthRoutes(deps));

  const issuer = `${deps.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  const authBase = { jwks: deps.jwks, issuer, audience: deps.env.AUTH_AUDIENCE };
  const porIp = limiteTasaPorIp(deps.limitador);
  const porUsuario = limiteTasaPorUsuario(deps.limitador);

  const preRegistro = new OpenAPIHono<AppEnv>({ defaultHook: validacion });
  preRegistro.use('/invitaciones/aceptar', porIp, autenticacionPreRegistro(authBase), porUsuario);
  preRegistro.route('/', invitacionesPreRegistroRoutes(deps));
  app.route('/api/v1', preRegistro);

  const privado = new OpenAPIHono<AppEnv>({ defaultHook: validacion });
  privado.use(
    '*',
    porIp,
    autenticacion({ ...authBase, resolverUsuario: crearResolvedorUsuario(deps.prisma) }),
    porUsuario,
  );
  privado.route('/', meRoutes(deps));
  privado.route('/', invitacionesRoutes(deps));
  privado.route('/', orgsRoutes(deps));
  privado.route('/', cotosRoutes(deps));
  privado.route('/', sectoresRoutes(deps));
  privado.route('/', unidadesRoutes(deps));
  privado.route('/', miembrosRoutes(deps));
  privado.route('/', conceptosRoutes(deps));
  privado.route('/', cargosRoutes(deps));
  privado.route('/', estadoCuentaRoutes(deps));
  privado.route('/', pagosRoutes(deps));
  privado.route('/', egresosRoutes(deps));
  privado.route('/', reportesRoutes(deps));
  privado.route('/', autopayRoutes(deps));
  privado.route('/', cfdiRoutes(deps));
  privado.route('/', billingRoutes(deps));
  privado.route('/', comunicadosRoutes(deps));
  privado.route('/', ticketsRoutes(deps));
  privado.route('/', votacionesRoutes(deps));
  app.route('/api/v1', privado);

  if (deps.env.API_DOCS) {
    app.doc31('/openapi.json', {
      openapi: '3.1.0',
      info: { title: 'Administrador de Cotos API', version: '1.0.0' },
    });
  }

  app.notFound(noEncontrado);
  app.onError(manejarError(deps.log));
  return app;
}
