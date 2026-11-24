import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits para GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

export interface EncryptedPayload {
  cipherText: string; // Base64
  iv: string;         // Base64
  authTag: string;    // Base64
  keyVersion: number;
}

/**
 * Cifra un dato altamente sensible usando AES-256-GCM (Envelope Encryption)
 * @param plainText Texto a proteger (ej. CSD Password, CLABE)
 * @param tenantKey Llave criptográfica de 256 bits (32 bytes Buffer)
 * @param keyVersion Versión de rotación de la llave
 */
export function encryptSensitiveField(
  plainText: string,
  tenantKey: Buffer,
  keyVersion = 1
): EncryptedPayload {
  if (tenantKey.length !== 32) {
    throw new Error('Seguridad crítica: La llave de cifrado debe ser exactamente de 32 bytes (256 bits).');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, tenantKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion,
  };
}

/**
 * Descifra y valida la integridad de un payload cifrado con AES-256-GCM
 */
export function decryptSensitiveField(
  payload: EncryptedPayload,
  tenantKey: Buffer
): string {
  if (tenantKey.length !== 32) {
    throw new Error('Seguridad crítica: La llave de cifrado debe ser exactamente de 32 bytes (256 bits).');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    tenantKey,
    Buffer.from(payload.iv, 'base64'),
    { authTagLength: AUTH_TAG_LENGTH }
  );

  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.cipherText, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
