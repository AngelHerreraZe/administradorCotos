import type { PrismaClient } from '@admcotos/db';
import type { AalLevel } from '@admcotos/security';
import type { PayloadCorreo } from '@admcotos/shared';
import type { JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import type { Env } from './env.ts';

export interface AuthContext {
  usuarioId: string;
  authId: string;
  aal: AalLevel;
}

export interface AuthPreRegistroContext {
  authId: string;
  aal: AalLevel;
  email: string;
}

export type EncoladorCorreo = (payload: PayloadCorreo, opts?: { jobId?: string }) => Promise<void>;

export interface LimitadorTasa {
  consumir(clave: string, puntos: number, duracionSegundos: number, prefijo: string): Promise<void>;
}

/** Dependencias explícitas: las rutas las reciben por parámetro (fácil de probar, sin singletons). */
export interface Deps {
  env: Env;
  prisma: PrismaClient;
  log: Logger;
  jwks: JWTVerifyGetKey;
  limitador: LimitadorTasa;
  encolarCorreo: EncoladorCorreo;
}

/** Variables de contexto de Hono disponibles en cada petición. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    auth: AuthContext;
    authPre: AuthPreRegistroContext;
  };
}
