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
export function verifyEvolutionWebhook(incomingApiKey: string | null, expectedApiKey: string): boolean {
  if (!incomingApiKey || !expectedApiKey) return false;
  // Comparar hashes de igual longitud: timingSafeEqual lanza si difieren (500 en vez de 401).
  const h = (s: string) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(incomingApiKey), h(expectedApiKey));
}

/**
 * Extrae el cotoId (UUID estricto) del instanceName "coto_<uuid>".
 * El llamador debe confirmar en BD que esa instancia pertenece a ese coto.
 */
export function extractCotoIdFromInstance(instanceName: string): string | null {
  const match = /^coto_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(instanceName);
  return match?.[1]?.toLowerCase() ?? null;
}
