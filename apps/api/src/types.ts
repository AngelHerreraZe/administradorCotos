import type { PrismaClient } from '@admcotos/db';
import type { Logger } from 'pino';
import type { Env } from './env.ts';

/** Dependencias explícitas: las rutas las reciben por parámetro (fácil de probar, sin singletons). */
export interface Deps {
  env: Env;
  prisma: PrismaClient;
  log: Logger;
}

/** Variables de contexto de Hono disponibles en cada petición. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
  };
}
