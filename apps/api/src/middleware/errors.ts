import { AppError, type Problem } from '@admcotos/shared';
import * as Sentry from '@sentry/node';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import type { ZodError } from 'zod';
import type { AppEnv } from '../types.ts';

export function problema(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  title: string,
  extra: Pick<Problem, 'detail' | 'errors'> = {},
): Response {
  const body: Problem = { type: 'about:blank', title, status, code, requestId: c.get('requestId'), ...extra };
  return c.body(JSON.stringify(body), status, { 'Content-Type': 'application/problem+json' });
}

/**
 * SQLSTATE estándar → respuesta genérica. Las violaciones de RLS/privilegios son 403 y nunca
 * dicen qué tabla o política falló.
 */
const SQLSTATE: Record<string, [ContentfulStatusCode, string, string]> = {
  '42501': [403, 'sin_permiso', 'No tienes permiso para esta operación'],
  '23505': [409, 'duplicado', 'El registro ya existe'],
  '23P01': [409, 'traslape', 'Se empalma con otro registro'],
  '23503': [422, 'referencia_invalida', 'Hace referencia a algo que no existe o no es tuyo'],
  '23514': [422, 'regla_violada', 'Los datos no cumplen las reglas'],
  '22023': [422, 'parametro_invalido', 'Algún dato no es válido'],
  P0002: [404, 'no_encontrado', 'No encontrado'],
  '40001': [409, 'reintentar', 'Conflicto de concurrencia, reintenta'],
  '40P01': [409, 'reintentar', 'Conflicto de concurrencia, reintenta'],
  '55P03': [503, 'ocupado', 'Recurso ocupado, reintenta en unos segundos'],
  '57014': [503, 'tiempo_agotado', 'La operación tardó demasiado'],
};

interface DriverCause {
  originalCode?: string;
  originalMessage?: string;
}

/** Prisma 7 + @prisma/adapter-pg expone el error de Postgres en meta.driverAdapterError.cause. */
function causaPostgres(err: unknown): DriverCause | undefined {
  const meta = (err as { meta?: { driverAdapterError?: { cause?: DriverCause } } }).meta;
  return meta?.driverAdapterError?.cause;
}

export function manejarError(log: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof AppError) {
      return problema(
        c,
        err.status as ContentfulStatusCode,
        err.code,
        err.message,
        err.detail ? { detail: err.detail } : {},
      );
    }
    if (err instanceof HTTPException) return problema(c, err.status, 'http', err.message);

    const pg = causaPostgres(err);
    // Errores de negocio escritos por nosotros en SQL: ERRCODE 'UA' + estado HTTP (UA403, UA404, UA409, UA422).
    // Su mensaje está pensado para el usuario, así que es lo único de la BD que se muestra tal cual.
    const ua = /^UA(4\d\d)$/.exec(pg?.originalCode ?? '');
    if (ua?.[1]) {
      return problema(
        c,
        Number(ua[1]) as ContentfulStatusCode,
        `bd.ua${ua[1]}`,
        pg?.originalMessage ?? 'Operación rechazada',
      );
    }
    const mapeo = pg?.originalCode ? SQLSTATE[pg.originalCode] : undefined;
    if (mapeo) return problema(c, ...mapeo);

    (c.get('log') ?? log).error({ err }, 'error no controlado');
    Sentry.captureException(err);
    return problema(c, 500, 'interno', 'Ocurrió un error interno');
  };
}

export const noEncontrado: NotFoundHandler<AppEnv> = (c) =>
  problema(c, 404, 'ruta_no_encontrada', 'Ruta no encontrada');

/** defaultHook de OpenAPIHono: entradas inválidas → 422 con cada campo señalado. */
export function validacion(result: { success: true } | { success: false; error: ZodError }, c: Context) {
  if (result.success) return undefined;
  return problema(c, 422, 'validacion', 'Revisa los datos enviados', {
    errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}
