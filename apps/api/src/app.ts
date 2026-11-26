import { OpenAPIHono } from '@hono/zod-openapi';
import { requestId } from 'hono/request-id';
import { manejarError, noEncontrado, validacion } from './middleware/errors.ts';
import { registroPeticiones } from './middleware/logging.ts';
import { seguridad } from './middleware/security.ts';
import { healthRoutes } from './routes/health.ts';
import type { AppEnv, Deps } from './types.ts';

/**
 * Construye la app sin abrir puertos: main.ts la sirve y las pruebas la llaman con app.request().
 * Cada módulo de negocio se monta aquí con `app.route('/api/v1/...', moduloRoutes(deps))`.
 */
export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validacion });

  app.use(requestId({ headerName: 'X-Request-Id' }));
  app.use(registroPeticiones(deps.log));
  for (const mw of seguridad(deps.env)) app.use(mw);

  app.route('/health', healthRoutes(deps));

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
