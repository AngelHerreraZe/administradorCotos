import crypto from 'node:crypto';
import { verificarWebhookConekta, verificarWebhookStripe } from '@admcotos/payments';
import { type EvolutionWebhookEvent, extraerMensajeEntrante, verifyEvolutionWebhook } from '@admcotos/whatsapp';
import { Hono } from 'hono';
import { problema } from '../../middleware/errors.ts';
import type { AppEnv, Deps } from '../../types.ts';

/**
 * Webhooks públicos (sin JWT y fuera de CORS).
 * Verifican firma sobre el cuerpo crudo, rechazan livemode de otro ambiente,
 * registran idempotencia en webhook_events (INSERT sin SELECT) y responden 200 rápido.
 */
export function webhooksRoutes(
  deps: Pick<
    Deps,
    | 'prisma'
    | 'env'
    | 'log'
    | 'conekta'
    | 'stripe'
    | 'encolarPagosWebhook'
    | 'encolarBilling'
    | 'encolarWhatsappEntrante'
  >,
) {
  const app = new Hono<AppEnv>();

  app.post('/conekta', async (c) => {
    const publicKeyPem = deps.conekta?.webhookPublicKeyPem;
    if (!publicKeyPem) {
      return problema(c, 503, 'servicio_no_configurado', 'Webhook Conekta no configurado');
    }

    const rawBuf = Buffer.from(await c.req.arrayBuffer());
    const digest = c.req.header('digest');
    if (!verificarWebhookConekta(rawBuf, digest, publicKeyPem)) {
      return problema(c, 401, 'firma_invalida', 'Firma de webhook Conekta inválida');
    }

    let payload: { id?: unknown; type?: unknown; livemode?: unknown };
    try {
      payload = JSON.parse(rawBuf.toString('utf8')) as { id?: unknown; type?: unknown; livemode?: unknown };
    } catch {
      return problema(c, 422, 'json_invalido', 'Cuerpo JSON inválido');
    }

    if (typeof payload.id !== 'string' || !payload.id || typeof payload.type !== 'string' || !payload.type) {
      return problema(c, 422, 'evento_invalido', 'Falta id o type en el evento');
    }

    const esperaLive = deps.env.NODE_ENV === 'production';
    if (typeof payload.livemode !== 'boolean' || payload.livemode !== esperaLive) {
      return problema(c, 401, 'ambiente_invalido', 'El evento no corresponde a este ambiente');
    }

    const eventoId = crypto.randomUUID();
    const rawJson = rawBuf.toString('utf8');
    const insertados = await deps.prisma.$executeRaw`
      INSERT INTO webhook_events (id, proveedor, event_id, tipo, payload)
      VALUES (${eventoId}::uuid, 'conekta', ${payload.id}, ${payload.type}, ${rawJson}::jsonb)
      ON CONFLICT (proveedor, event_id) DO NOTHING
    `;

    if (insertados === 1 && deps.encolarPagosWebhook) {
      try {
        await deps.encolarPagosWebhook({ eventoId }, { jobId: `conekta-${payload.id}` });
      } catch (err) {
        deps.log.error({ err, eventoId }, 'no se pudo encolar evento conekta; queda en webhook_events');
      }
    }

    return c.json({ received: true, duplicate: insertados === 0 }, 200);
  });

  app.post('/stripe', async (c) => {
    const stripe = deps.stripe;
    if (!stripe?.webhookSecret) {
      return problema(c, 503, 'servicio_no_configurado', 'Webhook Stripe no configurado');
    }

    const rawBuf = Buffer.from(await c.req.arrayBuffer());
    const signature = c.req.header('stripe-signature');
    const evento = await verificarWebhookStripe(rawBuf, signature, stripe.webhookSecret, stripe.cliente);
    if (!evento) {
      return problema(c, 401, 'firma_invalida', 'Firma de webhook Stripe inválida');
    }

    const esperaLive = deps.env.NODE_ENV === 'production';
    if (evento.livemode !== esperaLive) {
      return problema(c, 401, 'ambiente_invalido', 'El evento no corresponde a este ambiente');
    }

    const eventoId = crypto.randomUUID();
    const rawJson = rawBuf.toString('utf8');
    const insertados = await deps.prisma.$executeRaw`
      INSERT INTO webhook_events (id, proveedor, event_id, tipo, payload)
      VALUES (${eventoId}::uuid, 'stripe', ${evento.id}, ${evento.type}, ${rawJson}::jsonb)
      ON CONFLICT (proveedor, event_id) DO NOTHING
    `;

    if (insertados === 1 && deps.encolarBilling) {
      try {
        await deps.encolarBilling({ accion: 'procesar_webhook', eventoId }, { jobId: `stripe-${evento.id}` });
      } catch (err) {
        deps.log.error({ err, eventoId }, 'no se pudo encolar evento stripe; queda en webhook_events');
      }
    }

    return c.json({ received: true, duplicate: insertados === 0 }, 200);
  });

  /**
   * Evolution API (red privada): `apikey` comparada por hash. En `webhook_events` solo queda la
   * marca de idempotencia, nunca el texto; el mensaje viaja en el job y el bot lo procesa como el residente.
   */
  app.post('/whatsapp', async (c) => {
    const esperada = deps.env.EVOLUTION_WEBHOOK_APIKEY;
    if (!esperada || !deps.encolarWhatsappEntrante) {
      return problema(c, 503, 'servicio_no_configurado', 'Webhook WhatsApp no configurado');
    }
    if (!verifyEvolutionWebhook(c.req.header('apikey') ?? null, esperada)) {
      return problema(c, 401, 'firma_invalida', 'Llave de webhook inválida');
    }

    let evento: EvolutionWebhookEvent;
    try {
      evento = (await c.req.json()) as EvolutionWebhookEvent;
    } catch {
      return problema(c, 422, 'json_invalido', 'Cuerpo JSON inválido');
    }
    const mensaje = typeof evento?.instance === 'string' && evento.data?.key ? extraerMensajeEntrante(evento) : null;
    if (!mensaje || !/^coto_[0-9a-f-]{36}$/.test(mensaje.instancia)) {
      return c.json({ received: true, ignored: true }, 200);
    }

    const insertados = await deps.prisma.$executeRaw`
      INSERT INTO webhook_events (proveedor, event_id, tipo, payload)
      VALUES ('evolution', ${`${mensaje.instancia}:${mensaje.mensajeId}`}, 'messages.upsert',
              ${JSON.stringify({ instancia: mensaje.instancia })}::jsonb)
      ON CONFLICT (proveedor, event_id) DO NOTHING
    `;
    if (insertados === 1) {
      try {
        await deps.encolarWhatsappEntrante(mensaje);
      } catch (err) {
        // ponytail: chat efímero; si la cola falla la persona reenvía (el texto no se persiste)
        deps.log.error({ err }, 'no se pudo encolar mensaje de WhatsApp');
      }
    }
    return c.json({ received: true, duplicate: insertados === 0 }, 200);
  });

  return app;
}
