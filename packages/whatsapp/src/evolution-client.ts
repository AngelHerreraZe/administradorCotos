/**
 * Cliente de Integración para Evolution API v2 (Self-Hosted WhatsApp Gateway)
 * Diseñado para entornos multi-inquilino de alta seguridad y anti-baneo.
 */

export interface ProxyConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'socks5';
  username?: string;
  password?: string;
}

export interface CreateInstanceOptions {
  instanceName: string; // Formato recomendado: "coto_{cotoId}"
  token?: string;
  proxy?: ProxyConfig;
  webhookUrl?: string;
}

export class EvolutionApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      apikey: this.apiKey,
      ...options.headers,
    };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Evolution API Error [${res.status}] en ${endpoint}: ${errorText}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Crea una nueva instancia de WhatsApp dedicada con proxy residencial aislado
   */
  async createInstance(opts: CreateInstanceOptions) {
    const payload: Record<string, unknown> = {
      instanceName: opts.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    };

    if (opts.proxy) {
      payload.proxy = {
        host: opts.proxy.host,
        port: opts.proxy.port,
        protocol: opts.proxy.protocol,
        username: opts.proxy.username,
        password: opts.proxy.password,
      };
    }

    if (opts.webhookUrl) {
      payload.webhook = {
        url: opts.webhookUrl,
        enabled: true,
        byEvents: true,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      };
    }

    return this.request(`/instance/create`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Obtiene el código QR para vincular el número del coto
   */
  async getQrCode(instanceName: string) {
    return this.request<{ qrcode: { base64: string; code: string } }>(`/instance/connect/${instanceName}`, {
      method: 'GET',
    });
  }

  /**
   * Simula presencia humana ('composing' / escribiendo...)
   */
  async setPresence(instanceName: string, remoteJid: string, presence: 'composing' | 'recording' | 'available') {
    return this.request(`/chat/sendPresence/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number: remoteJid,
        presence,
        delay: 1200,
      }),
    });
  }

  /**
   * Envía mensaje de texto con validación y mitigación
   */
  async sendTextMessage(instanceName: string, number: string, text: string) {
    return this.request(`/message/sendText/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number,
        text,
        delay: 1500, // delay de entrega
        linkPreview: true,
      }),
    });
  }

  /** Descarga (descifrada) la imagen o documento de un mensaje recibido. */
  async getBase64FromMediaMessage(instanceName: string, messageId: string) {
    return this.request<{ base64: string; mimetype: string }>(`/chat/getBase64FromMediaMessage/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4: false }),
    });
  }

  /**
   * Envía tarjeta de contacto (vCard) para que el residente guarde el número
   */
  async sendContactCard(instanceName: string, number: string, cotoNombre: string, cotoTelefono: string) {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:Administración ${cotoNombre}`,
      `ORG:Condominio ${cotoNombre};`,
      `TEL;type=CELL;type=VOICE;waid=${cotoTelefono}:+${cotoTelefono}`,
      'END:VCARD',
    ].join('\n');

    return this.request(`/message/sendContact/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number,
        contact: [
          {
            fullName: `Administración ${cotoNombre}`,
            wuid: cotoTelefono,
            phoneNumber: cotoTelefono,
            vcard,
          },
        ],
      }),
    });
  }
}
