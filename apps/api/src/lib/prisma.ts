import { AppError } from '@admcotos/shared';

export function esErrorPrisma(err: unknown, codigo: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === codigo;
}

/**
 * Ejecuta una escritura tras confirmar visibilidad de la fila.
 * Si RLS bloquea el UPDATE (P2025), devuelve 403 sin revelar reglas internas.
 */
export async function actualizarConRls<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (esErrorPrisma(err, 'P2025')) {
      throw new AppError(403, 'sin_permiso', 'No tienes permiso para modificar este registro');
    }
    throw err;
  }
}
