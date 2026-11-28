import crypto from 'node:crypto';
import { AppError } from '@admcotos/shared';
import Stripe from 'stripe';
import { describe, expect, test } from 'vitest';
import {
  agregarFuente,
  type ClienteConektaApi,
  centavosAMonto,
  cobrarFuente,
  crearCliente,
  crearOrden,
  esRechazoDefinitivoConekta,
  montoACentavos,
  verificarWebhookConekta,
  verificarWebhookStripe,
} from '../src/index.ts';

describe('@admcotos/payments — dinero y pasarelas', () => {
  test('convierte monto decimal a centavos enteros sin flotantes (y viceversa)', () => {
    expect(montoACentavos('1450.50')).toBe(145050);
    expect(montoACentavos('0.01')).toBe(1);
    expect(montoACentavos('19.99')).toBe(1999);
    expect(centavosAMonto(145050)).toBe('1450.50');
    expect(centavosAMonto(5)).toBe('0.05');
    expect(() => montoACentavos('-1.00')).toThrow(AppError);
    expect(() => centavosAMonto(-1)).toThrow(AppError);
  });

  test('verificarWebhookConekta valida firma RSA SHA-256 contra cuerpo crudo exacto', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const rawBody = Buffer.from('{"id":"evt_conekta_1","type":"order.paid","livemode":false}', 'utf8');
    const firma = crypto.sign('sha256', rawBody, privateKey).toString('base64');

    expect(verificarWebhookConekta(rawBody, firma, publicKey)).toBe(true);
    expect(verificarWebhookConekta(rawBody, `sha256=${firma}`, publicKey)).toBe(true);
    expect(verificarWebhookConekta(Buffer.from('{"id":"alterado"}'), firma, publicKey)).toBe(false);
    expect(verificarWebhookConekta(rawBody, 'no-es-firma', publicKey)).toBe(false);
    expect(verificarWebhookConekta(rawBody, undefined, publicKey)).toBe(false);
  });

  test('verificarWebhookStripe valida firma HMAC usando constructEventAsync con cuerpo crudo', async () => {
    const stripe = new Stripe('sk_test_fake');
    const secret = 'whsec_test_secret_123456';
    const payload = JSON.stringify({ id: 'evt_stripe_1', type: 'invoice.paid', livemode: false, data: { object: {} } });
    const headerValido = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });

    const evento = await verificarWebhookStripe(Buffer.from(payload, 'utf8'), headerValido, secret, stripe);
    expect(evento?.id).toBe('evt_stripe_1');
    expect(evento?.type).toBe('invoice.paid');

    expect(await verificarWebhookStripe(payload, headerValido, 'whsec_otro', stripe)).toBeNull();
    expect(await verificarWebhookStripe('{"alterado":true}', headerValido, secret, stripe)).toBeNull();
    expect(await verificarWebhookStripe(payload, undefined, secret, stripe)).toBeNull();
  });

  test('Conekta clientes, fuentes y órdenes reenvían Idempotency-Key y extraen checkout/SPEI/OXXO', async () => {
    const llamadas: { tipo: string; idempotencyKey?: string; payload: unknown }[] = [];
    const api: ClienteConektaApi = {
      customers: {
        async createCustomer(req) {
          llamadas.push({ tipo: 'customer', payload: req });
          return { data: { id: 'cus_1' } } as Awaited<ReturnType<ClienteConektaApi['customers']['createCustomer']>>;
        },
      },
      paymentMethods: {
        async createCustomerPaymentMethods(_id, req) {
          llamadas.push({ tipo: 'pm', payload: req });
          return {
            data: { id: 'src_1', last4: '4523', brand: 'visa', exp_month: '12', exp_year: '2029' },
          } as unknown as Awaited<ReturnType<ClienteConektaApi['paymentMethods']['createCustomerPaymentMethods']>>;
        },
      },
      orders: {
        async createOrder(req, _lang, _child, idempotencyKey) {
          llamadas.push({ tipo: 'order', idempotencyKey, payload: req });
          const pmType = (req.charges?.[0]?.payment_method as { type?: string } | undefined)?.type;
          return {
            data: {
              id: 'ord_1',
              livemode: false,
              payment_status: pmType === 'default' || pmType === 'card' ? 'paid' : 'pending_payment',
              ...(req.checkout ? { checkout: { url: 'https://pay.conekta.com/checkout/ord_1' } } : {}),
              charges: {
                data: [
                  {
                    id: 'chg_1',
                    payment_method:
                      pmType === 'spei'
                        ? { clabe: '646180111812345678' }
                        : pmType === 'oxxo_cash'
                          ? { reference: '980000123456' }
                          : {},
                  },
                ],
              },
            },
          } as unknown as Awaited<ReturnType<ClienteConektaApi['orders']['createOrder']>>;
        },
        async getOrderById() {
          throw new Error('no usado');
        },
      },
    };

    const cus = await crearCliente({ nombre: 'Ana López', email: 'ana@alfa.mx' }, api);
    expect(cus.customerId).toBe('cus_1');

    const pm = await agregarFuente({ customerId: 'cus_1', tokenId: 'tok_test_1' }, api);
    expect(pm).toEqual({ sourceId: 'src_1', ultimos4: '4523', marca: 'visa', expiracion: '12/2029' });

    const checkout = await crearOrden(
      {
        pagoId: 'p1',
        cotoId: 'c1',
        unidadId: 'u1',
        concepto: 'Cuota Nov 2026',
        montoCentavos: 150000,
        metodo: 'checkout',
        cliente: { customerId: 'cus_1', nombre: 'Ana', email: 'ana@alfa.mx' },
        idempotencyKey: 'idem-ord-1',
      },
      api,
    );
    expect(checkout.checkoutUrl).toBe('https://pay.conekta.com/checkout/ord_1');

    const spei = await crearOrden(
      {
        pagoId: 'p2',
        cotoId: 'c1',
        unidadId: 'u1',
        concepto: 'Cuota Nov 2026',
        montoCentavos: 150000,
        metodo: 'spei',
        cliente: { nombre: 'Ana', email: 'ana@alfa.mx' },
        idempotencyKey: 'idem-ord-spei',
      },
      api,
    );
    expect(spei.clabeSpei).toBe('646180111812345678');

    const recurrente = await cobrarFuente(
      {
        montoCentavos: 150000,
        concepto: 'Auto-Pay',
        customerConektaId: 'cus_1',
        paymentSourceId: 'src_1',
        metadata: { autopayId: 'ap1' },
        idempotencyKey: 'autopay:ap1:cg1:1',
      },
      api,
    );
    expect(recurrente.gatewayOrderId).toBe('ord_1');
    expect(llamadas.find((l) => l.idempotencyKey === 'autopay:ap1:cg1:1')).toBeTruthy();

    expect(esRechazoDefinitivoConekta({ response: { status: 402, data: { type: 'processing_error' } } })).toBe(true);
    expect(esRechazoDefinitivoConekta({ response: { status: 503 } })).toBe(false);
    expect(esRechazoDefinitivoConekta(new Error('ETIMEDOUT'))).toBe(false);
  });
});
