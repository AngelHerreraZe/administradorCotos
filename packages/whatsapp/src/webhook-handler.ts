import crypto from 'node:crypto';

export interface EvolutionWebhookEvent {
  event: string;
  instance: string;
  data: {
    key: {
      remoteJid: string;
      fromMe: boolean;
      id: string;
    };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text: string };
      imageMessage?: { caption?: string; mimetype: string; url: string };
      documentMessage?: { title?: string; mimetype: string; url: string };
    };
    messageType?: string;
    messageTimestamp?: number;
  };
}

/**
 * Valida la autenticidad del webhook entrante desde Evolution API
 */
export function verifyEvolutionWebhook(
  incomingApiKey: string | null,
  expectedApiKey: string
): boolean {
  if (!incomingApiKey) return false;
  return crypto.timingSafeEqual(
    Buffer.from(incomingApiKey),
    Buffer.from(expectedApiKey)
  );
}

/**
 * Extrae el cotoId a partir del instanceName (ej. "coto_8f1a2b3c-...")
 */
export function extractCotoIdFromInstance(instanceName: string): string | null {
  const match = instanceName.match(/^coto_([a-zA-Z0-9_-]+)$/);
  return match ? match[1] ?? null : null;
}
