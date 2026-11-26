import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { AppEnv } from '../types.ts';

/** Una línea por petición. Solo la ruta (la query puede traer tokens), nunca cuerpos ni headers. */
export function registroPeticiones(log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inicio = performance.now();
    const reqLog = log.child({ requestId: c.get('requestId') });
    c.set('log', reqLog);
    await next();
    reqLog.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - inicio) },
      'request',
    );
  };
}
