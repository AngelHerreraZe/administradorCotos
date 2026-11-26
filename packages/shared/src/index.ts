/**
 * Contratos compartidos entre la API, los workers y los frontends (web, móvil, caseta).
 * Solo tipos, esquemas Zod y errores: nada que dependa de Node, de la BD o de secretos.
 */
import { z } from 'zod';

/** RFC 9457 Problem Details: la única forma en que la API devuelve errores. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  /** Código estable para clientes y traducciones, ej. "cargo.no_encontrado". */
  code: string;
  detail?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

/** Error de dominio esperado. La API lo traduce a Problem; nunca filtra stack ni SQL. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly errors: { path: string; message: string }[] | undefined;

  constructor(
    status: number,
    code: string,
    title: string,
    detail?: string,
    errors?: { path: string; message: string }[],
  ) {
    super(title);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }
}

/**
 * Sentry ≥ 11 recolecta por defecto cuerpos HTTP, headers, cookies, query params, variables de
 * stack, datos de consultas y entradas/salidas de IA. Aquí todo apagado (LFPDPPP): solo errores
 * y trazas. Uso: Sentry.init({ dsn, dataCollection: SENTRY_SIN_PII }).
 */
export const SENTRY_SIN_PII = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

export { type Cola, Colas, OPCIONES_JOB_CORREO, type PayloadCorreo } from './colas.ts';
export const Uuid = z.uuid();
export const Periodo = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Usa el formato AAAA-MM');
/** Dinero siempre como texto decimal con 2 decimales máximo: nunca float. */
export const Monto = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Monto inválido');
export const Paginacion = z.object({
  limite: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
