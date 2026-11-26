import { OpenAPIHono } from '@hono/zod-openapi';
import { requestId } from 'hono/request-id';
import { autenticacion, autenticacionPreRegistro, crearResolvedorUsuario } from './middleware/auth.ts';
import { manejarError, noEncontrado, validacion } from './middleware/errors.ts';
import { registroPeticiones } from './middleware/logging.ts';
import { limiteTasaGeneral } from './middleware/rate-limit.ts';
import { seguridad } from './middleware/security.ts';
import { cotosRoutes } from './modules/cotos/routes.ts';
import { invitacionesPreRegistroRoutes, invitacionesRoutes } from './modules/invitaciones/routes.ts';
import { meRoutes } from './modules/me/routes.ts';
import { miembrosRoutes } from './modules/miembros/routes.ts';
import { orgsRoutes } from './modules/orgs/routes.ts';
import { sectoresRoutes } from './modules/sectores/routes.ts';
import { unidadesRoutes } from './modules/unidades/routes.ts';
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
  for (const mw of seguridad(deps.env)) app.use(mw);

  // Rutas públicas antes de la autenticación
  app.route('/health', healthRoutes(deps));

  const issuer = `${deps.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  const authBase = { jwks: deps.jwks, issuer, audience: deps.env.AUTH_AUDIENCE };

  const preRegistro = new OpenAPIHono<AppEnv>({ defaultHook: validacion });
  preRegistro.use('/invitaciones/aceptar', autenticacionPreRegistro(authBase), limiteTasaGeneral(deps.limitador));
  preRegistro.route('/', invitacionesPreRegistroRoutes(deps));
  app.route('/api/v1', preRegistro);

  const privado = new OpenAPIHono<AppEnv>({ defaultHook: validacion });
  privado.use(
    '*',
    autenticacion({ ...authBase, resolverUsuario: crearResolvedorUsuario(deps.prisma) }),
    limiteTasaGeneral(deps.limitador),
  );
  privado.route('/', meRoutes(deps));
  privado.route('/', invitacionesRoutes(deps));
  privado.route('/', orgsRoutes(deps));
  privado.route('/', cotosRoutes(deps));
  privado.route('/', sectoresRoutes(deps));
  privado.route('/', unidadesRoutes(deps));
  privado.route('/', miembrosRoutes(deps));
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
