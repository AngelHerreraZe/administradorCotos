import type { Prisma } from '@admcotos/db';
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

/**
 * Ejecuta una creación idempotente usando un SAVEPOINT en la transacción actual.
 * Si `claveIdempotencia` colisiona (P2002) y `buscarExistente` encuentra la fila en el mismo ámbito,
 * devuelve `{ creado: false, dato }` para responder 200 sin duplicar efectos ni correo.
 */
export async function conIdempotencia<T>(
  tx: Prisma.TransactionClient,
  claveIdempotencia: string | undefined,
  insertar: () => Promise<T>,
  buscarExistente: () => Promise<T | null>,
): Promise<{ creado: boolean; dato: T }> {
  if (!claveIdempotencia) {
    return { creado: true, dato: await insertar() };
  }

  await tx.$executeRaw`SAVEPOINT sp_idempotencia`;
  try {
    const dato = await insertar();
    await tx.$executeRaw`RELEASE SAVEPOINT sp_idempotencia`;
    return { creado: true, dato };
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_idempotencia`;
    if (esErrorPrisma(err, 'P2002')) {
      const existente = await buscarExistente();
      if (existente) return { creado: false, dato: existente };
    }
    throw err;
  }
}
