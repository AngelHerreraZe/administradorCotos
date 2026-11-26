import crypto from 'node:crypto';

/**
 * Cifrado de campos sensibles (CSD del SAT, CLABE, INE): AES-256-GCM.
 *
 * - Llave por organización derivada con HKDF de la llave maestra: un
 *   texto cifrado de un despacho no se descifra con el contexto de otro.
 * - AAD = "<orgId>|<contexto>" (ej. "coto_secretos.csd_key:<cotoId>"): copiar
 *   un blob a otra fila o tenant hace fallar el descifrado.
 * - Blob versionado: [0x01][versión llave u16][iv 12][tag 16][cifrado].
 *   Rotar = agregar versión nueva en MASTER_KEKS y re-cifrar en segundo plano
 *   (keyVersionOf indica qué filas faltan).
 *
 * ponytail: llave maestra desde env; con KMS/HSM se descifra al arrancar y el
 * formato no cambia.
 */
export interface Keyring {
  current: number;
  keys: Map<number, Buffer>;
}

const FORMAT = 1;
const HEADER = 3;
const IV = 12;
const TAG = 16;

/** MASTER_KEKS="1:<base64 32 bytes>,2:<base64 32 bytes>" — la versión más alta cifra. */
export function keyringFromEnv(value = process.env.MASTER_KEKS ?? ''): Keyring {
  const keys = new Map<number, Buffer>();
  for (const part of value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const sep = part.indexOf(':');
    const version = Number(part.slice(0, sep));
    const key = Buffer.from(part.slice(sep + 1), 'base64');
    if (!Number.isInteger(version) || version < 1 || version > 0xffff) throw new Error('MASTER_KEKS: versión inválida');
    if (key.length !== 32) throw new Error(`MASTER_KEKS: la llave v${version} debe ser de 32 bytes`);
    keys.set(version, key);
  }
  if (keys.size === 0) throw new Error('MASTER_KEKS vacío: no hay llave maestra');
  return { current: Math.max(...keys.keys()), keys };
}

function orgKey(master: Buffer, orgId: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(orgId, 'utf8'), 'admcotos/campo/v1', 32));
}

const aad = (orgId: string, context: string) => Buffer.from(`${orgId}|${context}`, 'utf8');

export function encryptField(data: Buffer | string, orgId: string, context: string, ring: Keyring): Buffer {
  const master = ring.keys.get(ring.current);
  if (!master) throw new Error(`Llave maestra v${ring.current} no disponible`);
  const iv = crypto.randomBytes(IV);
  const cipher = crypto.createCipheriv('aes-256-gcm', orgKey(master, orgId), iv, { authTagLength: TAG });
  cipher.setAAD(aad(orgId, context));
  const body = Buffer.concat([
    cipher.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
    cipher.final(),
  ]);
  const header = Buffer.alloc(HEADER);
  header.writeUInt8(FORMAT, 0);
  header.writeUInt16BE(ring.current, 1);
  return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
}

export function decryptField(blob: Buffer, orgId: string, context: string, ring: Keyring): Buffer {
  if (blob.length < HEADER + IV + TAG || blob[0] !== FORMAT) throw new Error('Formato de cifrado desconocido');
  const version = blob.readUInt16BE(1);
  const master = ring.keys.get(version);
  if (!master) throw new Error(`Llave maestra v${version} no disponible`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', orgKey(master, orgId), blob.subarray(HEADER, HEADER + IV), {
    authTagLength: TAG,
  });
  decipher.setAAD(aad(orgId, context));
  decipher.setAuthTag(blob.subarray(HEADER + IV, HEADER + IV + TAG));
  return Buffer.concat([decipher.update(blob.subarray(HEADER + IV + TAG)), decipher.final()]);
}

export const keyVersionOf = (blob: Buffer): number => blob.readUInt16BE(1);
