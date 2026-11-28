import crypto from 'node:crypto';
import { AppError } from '@admcotos/shared';
import {
  Configuration,
  type CustomerResponse,
  CustomersApi,
  type OrderRequest,
  type OrderResponse,
  OrdersApi,
  PaymentMethodsApi,
} from 'conekta';

export type MetodoPagoConekta = 'checkout' | 'tarjeta' | 'spei' | 'oxxo';

export interface ClienteConektaApi {
  customers: Pick<CustomersApi, 'createCustomer'>;
  paymentMethods: Pick<PaymentMethodsApi, 'createCustomerPaymentMethods'>;
  orders: Pick<OrdersApi, 'createOrder' | 'getOrderById'>;
}

export const CONEKTA_API_VERSION_DEFAULT = 'application/vnd.conekta-v2.3.0+json';

export function crearClienteConekta(apiKey: string, apiVersion = CONEKTA_API_VERSION_DEFAULT): ClienteConektaApi {
  const config = new Configuration({
    accessToken: apiKey,
    baseOptions: { headers: { Accept: apiVersion } },
  });
  return {
    customers: new CustomersApi(config),
    paymentMethods: new PaymentMethodsApi(config),
    orders: new OrdersApi(config),
  };
}

/**
 * Distingue un rechazo definitivo de tarjeta/solicitud (402, 422, card_declined,
 * parameter_validation_error, processing_error) de un fallo transitorio de red/5xx/timeout.
 */
export function esRechazoDefinitivoConekta(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    status?: number;
    response?: { status?: number; data?: { type?: string; details?: { code?: string }[] } };
    type?: string;
  };
  const status = e.response?.status ?? e.status;
  if (status === 402 || status === 422) return true;
  if (typeof status === 'number' && status >= 500) return false;

  const tipo = (e.response?.data?.type ?? e.type ?? '').toLowerCase();
  if (tipo.includes('validation') || tipo.includes('processing') || tipo.includes('declined')) {
    return true;
  }
  const codigo = (e.response?.data?.details?.[0]?.code ?? '').toLowerCase();
  return (
    codigo.includes('declined') ||
    codigo.includes('insufficient') ||
    codigo.includes('expired') ||
    codigo.includes('invalid')
  );
}

export interface CrearClienteConektaParams {
  nombre: string;
  email: string;
  telefono?: string;
}

export async function crearCliente(
  params: CrearClienteConektaParams,
  cliente: ClienteConektaApi,
): Promise<{ customerId: string }> {
  const res = await cliente.customers.createCustomer({
    name: params.nombre,
    email: params.email,
    phone: params.telefono ?? '',
  });
  return { customerId: res.data.id };
}

export interface AgregarFuenteParams {
  customerId: string;
  tokenId: string;
}

export async function agregarFuente(
  params: AgregarFuenteParams,
  cliente: ClienteConektaApi,
): Promise<{ sourceId: string; ultimos4?: string; marca?: string; expiracion?: string }> {
  const res = await cliente.paymentMethods.createCustomerPaymentMethods(params.customerId, {
    type: 'card',
    token_id: params.tokenId,
  });
  const data = res.data as unknown as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : '';
  if (!id) {
    throw new AppError(502, 'pasarela_invalida', 'Conekta no devolvió identificador del método de pago');
  }
  const expMes =
    typeof data.exp_month === 'string' || typeof data.exp_month === 'number'
      ? String(data.exp_month).padStart(2, '0')
      : undefined;
  const expAnio =
    typeof data.exp_year === 'string' || typeof data.exp_year === 'number' ? String(data.exp_year) : undefined;
  return {
    sourceId: id,
    ...(typeof data.last4 === 'string' ? { ultimos4: data.last4 } : {}),
    ...(typeof data.brand === 'string' ? { marca: data.brand } : {}),
    ...(expMes && expAnio ? { expiracion: `${expMes}/${expAnio}` } : {}),
  };
}

export interface CrearOrdenParams {
  pagoId: string;
  cotoId: string;
  unidadId: string;
  concepto: string;
  montoCentavos: number;
  metodo: MetodoPagoConekta;
  cliente: {
    customerId?: string;
    nombre: string;
    email: string;
    telefono?: string;
  };
  tokenTarjeta?: string;
  expiresAtEpoch?: number;
  successUrl?: string;
  failureUrl?: string;
  idempotencyKey?: string;
}

export interface ResultadoOrdenConekta {
  gatewayOrderId: string;
  gatewayChargeId?: string;
  livemode: boolean;
  paymentStatus?: string;
  checkoutUrl?: string;
  clabeSpei?: string;
  referenciaOxxo?: string;
}

function extraerResultadoOrden(order: OrderResponse): ResultadoOrdenConekta {
  const charges = order.charges?.data ?? [];
  const primerCargo = charges[0];
  const pm = primerCargo?.payment_method as Record<string, unknown> | undefined;
  return {
    gatewayOrderId: order.id,
    ...(primerCargo?.id ? { gatewayChargeId: primerCargo.id } : {}),
    livemode: Boolean(order.livemode),
    ...(order.payment_status ? { paymentStatus: order.payment_status } : {}),
    ...(order.checkout?.url ? { checkoutUrl: order.checkout.url } : {}),
    ...(typeof pm?.clabe === 'string' ? { clabeSpei: pm.clabe } : {}),
    ...(typeof pm?.reference === 'string' ? { referenciaOxxo: pm.reference } : {}),
  };
}

function construirCustomerInfo(cliente: CrearOrdenParams['cliente']): OrderRequest['customer_info'] {
  if (cliente.customerId) {
    return { customer_id: cliente.customerId };
  }
  return {
    name: cliente.nombre,
    email: cliente.email,
    phone: cliente.telefono ?? '',
  };
}

/** Crea una orden en Conekta enviando monto entero en centavos e Idempotency-Key. */
export async function crearOrden(
  params: CrearOrdenParams,
  clienteApi: ClienteConektaApi,
): Promise<ResultadoOrdenConekta> {
  if (!Number.isInteger(params.montoCentavos) || params.montoCentavos <= 0) {
    throw new AppError(422, 'monto_invalido', 'El monto en centavos debe ser un entero positivo');
  }

  const base: OrderRequest = {
    currency: 'MXN',
    line_items: [{ name: params.concepto.slice(0, 200), unit_price: params.montoCentavos, quantity: 1 }],
    customer_info: construirCustomerInfo(params.cliente),
    metadata: {
      pagoId: params.pagoId,
      cotoId: params.cotoId,
      unidadId: params.unidadId,
    },
  };

  if (params.metodo === 'checkout') {
    base.checkout = {
      type: 'HostedPayment',
      allowed_payment_methods: ['card', 'bank_transfer', 'cash'],
      ...(params.expiresAtEpoch ? { expires_at: params.expiresAtEpoch } : {}),
      ...(params.successUrl ? { success_url: params.successUrl } : {}),
      ...(params.failureUrl ? { failure_url: params.failureUrl } : {}),
    };
  } else if (params.metodo === 'tarjeta') {
    if (!params.tokenTarjeta && !params.cliente.customerId) {
      throw new AppError(422, 'metodo_pago_requerido', 'Se requiere tokenTarjeta para pagar con tarjeta');
    }
    base.charges = [
      {
        payment_method: params.tokenTarjeta ? { type: 'card', token_id: params.tokenTarjeta } : { type: 'default' },
      },
    ];
  } else if (params.metodo === 'spei') {
    base.charges = [
      {
        payment_method: {
          type: 'spei',
          ...(params.expiresAtEpoch ? { expires_at: params.expiresAtEpoch } : {}),
        },
      },
    ];
  } else {
    base.charges = [
      {
        payment_method: {
          type: 'oxxo_cash',
          ...(params.expiresAtEpoch ? { expires_at: params.expiresAtEpoch } : {}),
        },
      },
    ];
  }

  const res = await clienteApi.orders.createOrder(base, undefined, undefined, params.idempotencyKey);
  return extraerResultadoOrden(res.data);
}

export interface CobrarFuenteParams {
  montoCentavos: number;
  concepto: string;
  customerConektaId: string;
  paymentSourceId?: string;
  metadata: Record<string, string | number | boolean>;
  idempotencyKey: string;
}

/** Ejecuta un cobro recurrente contra una fuente tokenizada (Auto-Pay). */
export async function cobrarFuente(
  params: CobrarFuenteParams,
  clienteApi: ClienteConektaApi,
): Promise<ResultadoOrdenConekta> {
  if (!Number.isInteger(params.montoCentavos) || params.montoCentavos <= 0) {
    throw new AppError(422, 'monto_invalido', 'El monto en centavos debe ser un entero positivo');
  }
  const req: OrderRequest = {
    currency: 'MXN',
    processing_mode: 'recurrent',
    line_items: [{ name: params.concepto.slice(0, 200), unit_price: params.montoCentavos, quantity: 1 }],
    customer_info: { customer_id: params.customerConektaId },
    charges: [
      {
        payment_method: params.paymentSourceId
          ? { type: 'card', payment_source_id: params.paymentSourceId }
          : { type: 'default' },
      },
    ],
    metadata: params.metadata,
  };
  const res = await clienteApi.orders.createOrder(req, undefined, undefined, params.idempotencyKey);
  return extraerResultadoOrden(res.data);
}

/** Verifica firma RSA-SHA256 de Conekta en la cabecera `digest` contra el cuerpo crudo exacto. */
export function verificarWebhookConekta(
  cuerpoCrudo: Uint8Array | string,
  digestHeader: string | undefined,
  publicKeyPem: string,
): boolean {
  if (!digestHeader?.trim() || !publicKeyPem.trim()) return false;
  try {
    const firmaBase64 = digestHeader.trim().replace(/^sha256=/i, '');
    if (!firmaBase64) return false;
    const firma = Buffer.from(firmaBase64, 'base64');
    if (firma.length === 0) return false;
    const pemNormalizado = publicKeyPem.includes('\\n') ? publicKeyPem.replaceAll('\\n', '\n') : publicKeyPem;
    const verifier = crypto.createVerify('SHA256');
    verifier.update(cuerpoCrudo);
    verifier.end();
    return verifier.verify(pemNormalizado, firma);
  } catch {
    return false;
  }
}

export type { CustomerResponse, OrderResponse };
