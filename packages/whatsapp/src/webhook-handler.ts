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
      documentMessage?: { title?: string; caption?: string; mimetype: string; url: string };
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

export interface MensajeEntrante {
  instancia: string;
  telefono: string;
  mensajeId: string;
  texto?: string;
  media?: { tipo: 'imagen' | 'documento'; mimetype: string };
}

/**
 * Reduce un evento `messages.upsert` al mínimo que procesa el bot. Ignora mensajes propios,
 * grupos, estados y tipos sin texto ni imagen/documento (devuelve null).
 */
export function extraerMensajeEntrante(ev: EvolutionWebhookEvent): MensajeEntrante | null {
  if (!/^messages[._]upsert$/i.test(ev.event ?? '') || ev.data?.key?.fromMe) return null;
  const tel = /^(\d{10,15})@s\.whatsapp\.net$/.exec(ev.data.key.remoteJid ?? '')?.[1];
  const mensajeId = ev.data.key.id;
  if (!tel || !mensajeId || mensajeId.length > 100) return null;
  const m = ev.data.message ?? {};
  const texto = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.documentMessage?.caption;
  const media = m.imageMessage
    ? { tipo: 'imagen' as const, mimetype: m.imageMessage.mimetype }
    : m.documentMessage
      ? { tipo: 'documento' as const, mimetype: m.documentMessage.mimetype }
      : undefined;
  if (!texto && !media) return null;
  return {
    instancia: ev.instance,
    telefono: tel,
    mensajeId,
    ...(texto ? { texto: texto.slice(0, 4_000) } : {}),
    ...(media ? { media: { tipo: media.tipo, mimetype: String(media.mimetype ?? '').slice(0, 100) } } : {}),
  };
}
