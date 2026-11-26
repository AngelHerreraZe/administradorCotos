import { z } from '@hono/zod-openapi';

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');

const DESCRIPCIONES: Record<number, string> = {
  401: 'No autenticado o sesión inválida',
  403: 'Sin permiso para esta operación',
  404: 'No encontrado o no visible',
  409: 'Conflicto de estado o registro duplicado',
  422: 'Error de validación o regla de negocio',
  429: 'Límite de peticiones excedido',
};

type CodigoError = 401 | 403 | 404 | 409 | 422 | 429;

export function respuestasError(...codigos: CodigoError[]) {
  const out: Partial<
    Record<
      CodigoError,
      { description: string; content: { 'application/problem+json': { schema: typeof ProblemSchema } } }
    >
  > = {};
  for (const codigo of codigos) {
    out[codigo] = {
      description: DESCRIPCIONES[codigo] ?? 'Error',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    };
  }
  return out;
}
