import crypto from 'node:crypto';

export interface AuditEntryData {
  orgId: string;
  cotoId?: string | null;
  usuarioId: string;
  usuarioRol: string;
  accion: string;
  recursoTipo: string;
  recursoId?: string | null;
  timestamp: string; // ISO 8601
  datosAntes?: unknown;
  datosDespues?: unknown;
  metadata?: unknown;
}

/**
 * Genera el hash criptográfico inmutable para la cadena de auditoría (Merkle-Chained Log)
 * Si un atacante o admin modifica un registro anterior, toda la cadena posterior queda rota.
 */
export function calculateAuditHash(
  entry: AuditEntryData,
  hashAnterior: string,
  hmacSecret: string
): string {
  const serialized = JSON.stringify({
    hashAnterior,
    orgId: entry.orgId,
    cotoId: entry.cotoId || null,
    usuarioId: entry.usuarioId,
    usuarioRol: entry.usuarioRol,
    accion: entry.accion,
    recursoTipo: entry.recursoTipo,
    recursoId: entry.recursoId || null,
    timestamp: entry.timestamp,
    datosAntes: entry.datosAntes || null,
    datosDespues: entry.datosDespues || null,
    metadata: entry.metadata || null,
  });

  return crypto
    .createHmac('sha256', hmacSecret)
    .update(serialized)
    .digest('hex');
}

/**
 * Valida la integridad de un eslabón en la cadena de auditoría
 */
export function verifyAuditLink(
  entry: AuditEntryData,
  hashAnterior: string,
  hashEsperado: string,
  hmacSecret: string
): boolean {
  const calculated = calculateAuditHash(entry, hashAnterior, hmacSecret);
  return crypto.timingSafeEqual(
    Buffer.from(calculated, 'hex'),
    Buffer.from(hashEsperado, 'hex')
  );
}
