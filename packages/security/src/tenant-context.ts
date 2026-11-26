import crypto from 'node:crypto';

/**
 * Contexto de identidad para PostgreSQL RLS.
 *
 * La BD no confía en roles ni en coto enviados por la app: solo en el
 * usuario, y solo si viene firmado. `app.uid()` valida esta firma con el
 * mismo secreto (tabla app_private.ctx_secret). Una inyección SQL no puede
 * hacerse pasar por otro usuario porque no conoce el secreto.
 *
 * Formato: "<usuario_uuid>.<expira_epoch>.<hmac_sha256_hex>"
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertUuid(valor: string, campo: string): string {
  const v = valor.toLowerCase();
  if (!UUID_RE.test(v)) throw new Error(`${campo} no es un UUID válido`);
  return v;
}

export function signDbContext(userId: string, secret: Buffer, ttlSeconds = 300): string {
  if (secret.length < 32) throw new Error('El secreto de contexto debe tener al menos 32 bytes');
  const id = assertUuid(userId, 'userId');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const mac = crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex');
  return `${id}.${exp}.${mac}`;
}
