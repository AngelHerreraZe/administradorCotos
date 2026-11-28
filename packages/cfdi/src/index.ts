import { AppError } from '@admcotos/shared';
import Facturapi, { type BinaryDownload } from 'facturapi';

const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const CP_REGEX = /^\d{5}$/;
const REGIMEN_REGEX = /^\d{3}$/;

export type MotivoCancelacionSat = '01' | '02' | '03' | '04';

export interface DatosFiscalesEntidad {
  rfc: string;
  nombre: string;
  regimenFiscal: string;
  cpFiscal: string;
}

export interface ConceptoCfdi {
  descripcion: string;
  claveProdServ: string;
  claveUnidad: string;
  cantidad: number;
  valorUnitario: string;
  ivaTasa?: number;
}

export interface ClienteCfdiApi {
  organizations: Pick<Facturapi['organizations'], 'create' | 'updateLegal' | 'getTestApiKey' | 'renewLiveApiKey'>;
  invoices: Pick<Facturapi['invoices'], 'create' | 'list' | 'retrieve' | 'cancel' | 'downloadPdf' | 'downloadXml'>;
}

export function crearClienteCfdi(apiKey: string): ClienteCfdiApi {
  const sdk = new Facturapi(apiKey);
  return {
    organizations: sdk.organizations,
    invoices: sdk.invoices,
  };
}

/** Valida que emisor y receptor tengan datos fiscales SAT completos antes de llamar al PAC. */
export function validarDatosFiscales(params: {
  emisor: DatosFiscalesEntidad;
  receptor: DatosFiscalesEntidad & { usoCfdi?: string };
}): void {
  for (const [etiqueta, entidad] of [
    ['emisor', params.emisor],
    ['receptor', params.receptor],
  ] as const) {
    if (!RFC_REGEX.test(entidad.rfc.trim())) {
      throw new AppError(422, 'datos_fiscales_incompletos', `RFC de ${etiqueta} inválido o faltante`);
    }
    if (!entidad.nombre.trim()) {
      throw new AppError(422, 'datos_fiscales_incompletos', `Razón social de ${etiqueta} faltante`);
    }
    if (!REGIMEN_REGEX.test(entidad.regimenFiscal.trim())) {
      throw new AppError(422, 'datos_fiscales_incompletos', `Régimen fiscal de ${etiqueta} inválido`);
    }
    if (!CP_REGEX.test(entidad.cpFiscal.trim())) {
      throw new AppError(422, 'datos_fiscales_incompletos', `Código postal fiscal de ${etiqueta} inválido`);
    }
  }
}

export async function registrarEmisorPac(
  emisor: DatosFiscalesEntidad,
  cliente: ClienteCfdiApi,
): Promise<{ pacOrgId: string }> {
  const nombre = emisor.nombre.trim();
  if (!nombre) {
    throw new AppError(422, 'datos_fiscales_incompletos', 'Razón social del emisor requerida');
  }
  const org = await cliente.organizations.create({ name: nombre });
  await cliente.organizations.updateLegal(org.id, {
    name: nombre,
    legal_name: nombre,
    tax_system: emisor.regimenFiscal.trim(),
    address: { zip: emisor.cpFiscal.trim() },
  });
  return { pacOrgId: org.id };
}

/** Obtiene la API key secreta (test o live) de una organización Facturapi para firmar/cancelar a su nombre. */
export async function obtenerApiKeyOrgPac(
  pacOrgId: string,
  testMode: boolean,
  clienteMaestro: ClienteCfdiApi,
): Promise<string> {
  const apiKey = testMode
    ? await clienteMaestro.organizations.getTestApiKey(pacOrgId)
    : await clienteMaestro.organizations.renewLiveApiKey(pacOrgId);
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new AppError(502, 'pac_sin_llave', 'El PAC no devolvió una llave de organización válida');
  }
  return apiKey.trim();
}

/** Busca una factura previa vigente por `external_id` en la organización para garantizar idempotencia ante reintentos. */
export async function buscarFacturaPorExternalId(
  externalId: string,
  clienteOrg: ClienteCfdiApi,
): Promise<ResultadoTimbrado | null> {
  const res = await clienteOrg.invoices.list({ external_id: externalId.slice(0, 100), limit: 10 });
  const lista = res.data as unknown as {
    id: string;
    uuid?: string;
    series?: string | null;
    folio_number?: number | string | null;
    total?: number | string;
    subtotal?: number | string;
    status?: string;
  }[];
  const factura = lista.find((f) => f.status !== 'canceled');
  if (!factura) return null;
  return {
    pacInvoiceId: factura.id,
    uuidCfdi: factura.uuid ?? '',
    serie: factura.series ?? null,
    folio: factura.folio_number != null ? String(factura.folio_number) : null,
    subtotal: aMontoDecimal(factura.subtotal ?? factura.total ?? '0'),
    total: aMontoDecimal(factura.total ?? '0'),
    estado: factura.status === 'pending' ? 'pendiente' : 'timbrado',
  };
}

/** Determina si un error del PAC es rechazo de negocio/datos (4xx distinto de 408/429) y no reintentable. */
export function esRechazoDefinitivoPac(err: unknown): boolean {
  if (err instanceof AppError) {
    return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
  }
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  const status =
    typeof e.statusCode === 'number'
      ? e.statusCode
      : typeof e.status === 'number'
        ? e.status
        : typeof e.response?.status === 'number'
          ? e.response.status
          : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface TimbrarCfdiParams {
  emisor: DatosFiscalesEntidad;
  receptor: DatosFiscalesEntidad & { usoCfdi?: string; email?: string };
  conceptos: ConceptoCfdi[];
  formaPago: string;
  metodoPago: 'PUE' | 'PPD';
  idempotencyKey?: string;
}

export interface ResultadoTimbrado {
  pacInvoiceId: string;
  uuidCfdi: string;
  serie: string | null;
  folio: string | null;
  subtotal: string;
  total: string;
  estado: 'timbrado' | 'pendiente';
}

function aMontoDecimal(valor: unknown): string {
  const s = typeof valor === 'number' || typeof valor === 'string' ? String(valor) : '0';
  const [ent, dec = ''] = s.split('.');
  return `${ent || '0'}.${dec.padEnd(2, '0').slice(0, 2)}`;
}

/** Timbra un CFDI 4.0 de Ingreso vía Facturapi. */
export async function timbrar(params: TimbrarCfdiParams, cliente: ClienteCfdiApi): Promise<ResultadoTimbrado> {
  validarDatosFiscales({ emisor: params.emisor, receptor: params.receptor });
  if (params.conceptos.length === 0) {
    throw new AppError(422, 'validacion', 'Se requiere al menos un concepto para timbrar');
  }

  const invoice = await cliente.invoices.create({
    type: 'I',
    customer: {
      legal_name: params.receptor.nombre.trim(),
      tax_id: params.receptor.rfc.trim().toUpperCase(),
      tax_system: params.receptor.regimenFiscal.trim(),
      address: { zip: params.receptor.cpFiscal.trim() },
      ...(params.receptor.email ? { email: params.receptor.email } : {}),
    },
    items: params.conceptos.map((c) => ({
      quantity: c.cantidad,
      product: {
        description: c.descripcion,
        product_key: c.claveProdServ,
        unit_key: c.claveUnidad,
        price: Number(c.valorUnitario),
        tax_included: true,
        taxes: c.ivaTasa !== undefined && c.ivaTasa > 0 ? [{ type: 'IVA', rate: c.ivaTasa }] : [],
      },
    })),
    payment_form: params.formaPago,
    payment_method: params.metodoPago,
    use: params.receptor.usoCfdi ?? 'G03',
    ...(params.idempotencyKey ? { external_id: params.idempotencyKey.slice(0, 100) } : {}),
  });

  const rec = invoice as unknown as {
    id: string;
    uuid?: string;
    series?: string | null;
    folio_number?: number | string | null;
    total?: number | string;
    subtotal?: number | string;
    status?: string;
  };

  return {
    pacInvoiceId: rec.id,
    uuidCfdi: rec.uuid ?? '',
    serie: rec.series ?? null,
    folio: rec.folio_number != null ? String(rec.folio_number) : null,
    subtotal: aMontoDecimal(rec.subtotal ?? rec.total ?? '0'),
    total: aMontoDecimal(rec.total ?? '0'),
    estado: rec.status === 'pending' ? 'pendiente' : 'timbrado',
  };
}

export interface ComplementoPagoParams {
  emisor: DatosFiscalesEntidad;
  receptor: DatosFiscalesEntidad;
  formaPago: string;
  fechaPagoIso?: string;
  documentosRelacionados: {
    uuid: string;
    monto: string;
    saldoAnterior: string;
    parcialidad: number;
  }[];
  idempotencyKey?: string;
}

/** Emite un CFDI 4.0 de tipo Pago (Complemento REP) contra un CFDI PPD previo. */
export async function complementoDePago(
  params: ComplementoPagoParams,
  cliente: ClienteCfdiApi,
): Promise<ResultadoTimbrado> {
  validarDatosFiscales({ emisor: params.emisor, receptor: params.receptor });
  if (params.documentosRelacionados.length === 0) {
    throw new AppError(422, 'validacion', 'Se requiere al menos un documento relacionado para complemento de pago');
  }

  const invoice = await cliente.invoices.create({
    type: 'P',
    customer: {
      legal_name: params.receptor.nombre.trim(),
      tax_id: params.receptor.rfc.trim().toUpperCase(),
      tax_system: params.receptor.regimenFiscal.trim(),
      address: { zip: params.receptor.cpFiscal.trim() },
    },
    complements: [
      {
        type: 'pago',
        data: [
          {
            payment_form: params.formaPago,
            ...(params.fechaPagoIso ? { date: params.fechaPagoIso } : {}),
            related_documents: params.documentosRelacionados.map((d) => ({
              uuid: d.uuid,
              amount: Number(d.monto),
              last_balance: Number(d.saldoAnterior),
              installment: d.parcialidad,
              taxes: [],
              taxability: '01',
            })),
          },
        ],
      },
    ],
    ...(params.idempotencyKey ? { external_id: params.idempotencyKey.slice(0, 100) } : {}),
  });

  const rec = invoice as unknown as {
    id: string;
    uuid?: string;
    series?: string | null;
    folio_number?: number | string | null;
    total?: number | string;
    status?: string;
  };
  return {
    pacInvoiceId: rec.id,
    uuidCfdi: rec.uuid ?? '',
    serie: rec.series ?? null,
    folio: rec.folio_number != null ? String(rec.folio_number) : null,
    subtotal: '0.00',
    total: aMontoDecimal(rec.total ?? '0'),
    estado: rec.status === 'pending' ? 'pendiente' : 'timbrado',
  };
}

/** Cancela un CFDI ante el SAT validando que motivos 01/04 incluyan folio sustituto. */
export async function cancelar(
  params: { pacInvoiceId: string; motivo: MotivoCancelacionSat; sustitucionUuid?: string },
  cliente: ClienteCfdiApi,
): Promise<{ status: string; cancellationStatus: string }> {
  const sustitucion = params.sustitucionUuid?.trim();
  let rawRes: unknown;
  if (params.motivo === '01' || params.motivo === '04') {
    if (!sustitucion) {
      throw new AppError(422, 'sustitucion_requerida', `El motivo ${params.motivo} requiere UUID de sustitución`);
    }
    rawRes = await cliente.invoices.cancel(params.pacInvoiceId, {
      motive: params.motivo,
      substitution: sustitucion,
    });
  } else {
    rawRes = await cliente.invoices.cancel(params.pacInvoiceId, {
      motive: params.motivo,
    });
  }

  const rec = rawRes as { status?: string; cancellation_status?: string };
  return {
    status: rec.status ?? 'canceled',
    cancellationStatus: rec.cancellation_status ?? 'none',
  };
}

/** Consulta el estado actualizado de cancelación ante Facturapi cuando quedó en `pending`. */
export async function consultarEstadoCancelacion(
  pacInvoiceId: string,
  cliente: ClienteCfdiApi,
): Promise<{ status: string; cancellationStatus: string }> {
  const raw = (await cliente.invoices.retrieve(pacInvoiceId)) as unknown as {
    status?: string;
    cancellation_status?: string;
  };
  return {
    status: raw.status ?? 'valid',
    cancellationStatus: raw.cancellation_status ?? 'none',
  };
}

async function binarioABuffer(descarga: BinaryDownload): Promise<Uint8Array> {
  if (descarga instanceof Blob) {
    return new Uint8Array(await descarga.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const partes: Buffer[] = [];
    descarga.on('data', (chunk) => partes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)));
    descarga.on('end', () => resolve(Buffer.concat(partes)));
    descarga.on('error', reject);
  });
}

export async function descargarXmlPdf(
  pacInvoiceId: string,
  cliente: ClienteCfdiApi,
): Promise<{ xml: Uint8Array; pdf: Uint8Array }> {
  const [xmlRaw, pdfRaw] = await Promise.all([
    cliente.invoices.downloadXml(pacInvoiceId),
    cliente.invoices.downloadPdf(pacInvoiceId),
  ]);
  const [xml, pdf] = await Promise.all([binarioABuffer(xmlRaw), binarioABuffer(pdfRaw)]);
  return { xml, pdf };
}
