import crypto from 'node:crypto';

/**
 * Contexto de identidad para PostgreSQL RLS (v2).
 *
 * La BD no confía en roles ni en coto enviados por la app: solo en el
 * usuario y su nivel de autenticación (aal), y solo si viene firmado.
 * `app.uid()` y `app.aal()` validan esta firma con el secreto en
 * `app_private.ctx_secret`. Una inyección SQL no puede hacerse pasar por
 * otro usuario ni elevar su `aal` porque no conoce el secreto.
 *
 * Formato v2 usuario:    "<usuario_uuid>.<aal1|aal2>.<expira_epoch>.<hmac_sha256_hex>"
 * Formato v2 pre-auth:   "auth.<auth_uuid>.<aal1|aal2>.<expira_epoch>.<hmac_sha256_hex>"
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AalLevel = 'aal1' | 'aal2';

export interface SignDbContextOptions {
  aal?: AalLevel;
  ttlSeconds?: number;
}

export function assertUuid(valor: string, campo: string): string {
  const v = valor.toLowerCase();
  if (!UUID_RE.test(v)) throw new Error(`${campo} no es un UUID válido`);
  return v;
}

function firmarPayload(prefijo: string, uuid: string, secret: Buffer, opts: SignDbContextOptions): string {
  if (secret.length < 32) throw new Error('El secreto de contexto debe tener al menos 32 bytes');
  const aal = opts.aal ?? 'aal1';
  if (aal !== 'aal1' && aal !== 'aal2') throw new Error('Nivel aal inválido');
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 300);
  const payload = `${prefijo}${uuid}.${aal}.${exp}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function signDbContext(userId: string, secret: Buffer, opts: SignDbContextOptions = {}): string {
  return firmarPayload('', assertUuid(userId, 'userId'), secret, opts);
}

/** Firma un contexto de pre-registro ligado a un auth_id verificado (sin usuario_id en BD todavía). */
export function signPreAuthContext(authId: string, secret: Buffer, opts: SignDbContextOptions = {}): string {
  return firmarPayload('auth.', assertUuid(authId, 'authId'), secret, opts);
}
