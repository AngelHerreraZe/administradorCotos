import crypto from 'node:crypto';

export interface AuditEntryData {
  orgId: string;
  cotoId?: string | null;
  usuarioId?: string | null; // NULL = sistema / worker
  accion: string;
  recursoTipo: string;
  recursoId?: string | null;
  timestamp: string; // ISO 8601, el mismo que se guarda en audit_log.created_at
  datosAntes?: unknown;
  datosDespues?: unknown;
  metadata?: unknown;
}

/** JSON con llaves ordenadas: JSONB reordena llaves, así el hash sobrevive al viaje a la BD. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Hash encadenado (HMAC-SHA256) de un registro de auditoría. Alterar un
 * registro rompe todos los posteriores de la misma organización.
 * La llave vive solo en el worker de auditoría, nunca en la BD ni en la API.
 */
export function calculateAuditHash(entry: AuditEntryData, hashAnterior: string, hmacSecret: string): string {
  const serialized = JSON.stringify(
    canonical({
      hashAnterior,
      orgId: entry.orgId,
      cotoId: entry.cotoId ?? null,
      usuarioId: entry.usuarioId ?? null,
      accion: entry.accion,
      recursoTipo: entry.recursoTipo,
      recursoId: entry.recursoId ?? null,
      timestamp: entry.timestamp,
      datosAntes: entry.datosAntes ?? null,
      datosDespues: entry.datosDespues ?? null,
      metadata: entry.metadata ?? null,
    }),
  );
  return crypto.createHmac('sha256', hmacSecret).update(serialized).digest('hex');
}

export function verifyAuditLink(
  entry: AuditEntryData,
  hashAnterior: string,
  hashEsperado: string,
  hmacSecret: string,
): boolean {
  const a = Buffer.from(calculateAuditHash(entry, hashAnterior, hmacSecret), 'hex');
  const b = Buffer.from(hashEsperado, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
