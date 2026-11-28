import Stripe from 'stripe';

export function crearClienteStripe(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

/** Verifica firma HMAC de webhook Stripe sobre cuerpo crudo usando constructEventAsync. */
export async function verificarWebhookStripe(
  cuerpoCrudo: string | Uint8Array,
  signatureHeader: string | undefined,
  webhookSecret: string,
  stripe?: Stripe,
): Promise<Stripe.Event | null> {
  if (!signatureHeader?.trim() || !webhookSecret) return null;
  const cliente = stripe ?? new Stripe('sk_webhook_verify_only');
  try {
    return await cliente.webhooks.constructEventAsync(cuerpoCrudo, signatureHeader, webhookSecret);
  } catch {
    return null;
  }
}

export async function crearSesionPortalBilling(
  stripe: Stripe,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const sesion = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: sesion.url };
}

/** Reporta uso mensual (unidades activas) por organización usando Billing Meter Events de Stripe v23. */
export async function registrarUsoUnidadesStripe(
  stripe: Stripe,
  params: {
    eventName: string;
    stripeCustomerId: string;
    unidadesActivas: number;
    timestampEpoch?: number;
    identifier: string;
  },
): Promise<{ identifier: string }> {
  const res = await stripe.billing.meterEvents.create({
    event_name: params.eventName,
    payload: {
      stripe_customer_id: params.stripeCustomerId,
      value: String(params.unidadesActivas),
    },
    identifier: params.identifier,
    ...(params.timestampEpoch ? { timestamp: params.timestampEpoch } : {}),
  });
  return { identifier: res.identifier };
}
