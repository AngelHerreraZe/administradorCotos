import { type ClienteCfdiApi, registrarEmisorPac, validarDatosFiscales } from '@admcotos/cfdi';
import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import type { EncoladorCfdi, StorageService } from '../../types.ts';
import type { CancelarFactura, ConfigurarCfdiCoto, FacturaCfdiDto, SolicitarTimbrado } from './schemas.ts';

const selectFactura = {
  id: true,
  cotoId: true,
  pagoId: true,
  pacInvoiceId: true,
  tipoComprobante: true,
  uuidCfdi: true,
  serie: true,
  folio: true,
  emisorRfc: true,
  emisorNombre: true,
  receptorRfc: true,
  receptorNombre: true,
  subtotal: true,
  total: true,
  xmlUrl: true,
  pdfUrl: true,
  estado: true,
  motivoCancelacion: true,
  sustitucionUuid: true,
  canceladoEn: true,
  createdAt: true,
} as const;

function aDto(row: Prisma.FacturaCfdiGetPayload<{ select: typeof selectFactura }>): z.infer<typeof FacturaCfdiDto> {
  return {
    id: row.id,
    cotoId: row.cotoId,
    pagoId: row.pagoId,
    pacInvoiceId: row.pacInvoiceId,
    tipoComprobante: row.tipoComprobante as 'I' | 'P',
    uuidCfdi: row.uuidCfdi,
    serie: row.serie,
    folio: row.folio,
    emisorRfc: row.emisorRfc,
    emisorNombre: row.emisorNombre,
    receptorRfc: row.receptorRfc,
    receptorNombre: row.receptorNombre,
    subtotal: row.subtotal.toString(),
    total: row.total.toString(),
    estado: row.estado as z.infer<typeof FacturaCfdiDto>['estado'],
    motivoCancelacion: row.motivoCancelacion,
    sustitucionUuid: row.sustitucionUuid,
    canceladoEn: row.canceladoEn?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Configura los datos fiscales del coto en Facturapi y encola la sincronización cifrada
 * de la API key de organización en el worker `cfdi`. La API nunca recibe `MASTER_KEKS` ni CSD.
 */
export async function configurarEmisor(params: {
  txWrapper: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  cotoId: string;
  datos: z.infer<typeof ConfigurarCfdiCoto>;
  cfdi: ClienteCfdiApi;
  encolarCfdi: EncoladorCfdi;
}) {
  const actual = await params.txWrapper(async (tx) => {
    const [perm] = await tx.$queryRaw<
      { ok: boolean }[]
    >`SELECT (${params.cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
    if (!perm?.ok) {
      throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede configurar CFDI');
    }
    const coto = await tx.coto.findUnique({
      where: { id: params.cotoId },
      select: { orgId: true, facturapiOrgId: true },
    });
    if (!coto) throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
    return coto;
  });

  let pacOrgId = actual.facturapiOrgId;
  if (pacOrgId) {
    await params.cfdi.organizations.updateLegal(pacOrgId, {
      name: params.datos.razonSocialCoto,
      legal_name: params.datos.razonSocialCoto,
      tax_system: params.datos.regimenFiscal,
      address: { zip: params.datos.cpFiscal },
    });
  } else {
    const creado = await registrarEmisorPac(
      {
        rfc: params.datos.rfcCoto.toUpperCase(),
        nombre: params.datos.razonSocialCoto,
        regimenFiscal: params.datos.regimenFiscal,
        cpFiscal: params.datos.cpFiscal,
      },
      params.cfdi,
    );
    pacOrgId = creado.pacOrgId;
  }

  await params.txWrapper((tx) =>
    tx.coto.update({
      where: { id: params.cotoId },
      data: {
        rfcCoto: params.datos.rfcCoto.toUpperCase(),
        razonSocialCoto: params.datos.razonSocialCoto,
        regimenFiscal: params.datos.regimenFiscal,
        cpFiscal: params.datos.cpFiscal,
        facturapiOrgId: pacOrgId,
      },
    }),
  );

  await params.encolarCfdi(
    { accion: 'sincronizar_llave', cotoId: params.cotoId, facturapiOrgId: pacOrgId },
    { jobId: `cfdi-llave-${params.cotoId}` },
  );

  return { facturapiOrgId: pacOrgId, rfcCoto: params.datos.rfcCoto.toUpperCase() };
}

export async function encolarTimbrado(params: {
  tx: Prisma.TransactionClient;
  cotoId: string;
  usuarioId: string;
  pagoId: string;
  receptor: z.infer<typeof SolicitarTimbrado>;
  encolarCfdi: EncoladorCfdi;
  idempotencyKey?: string | undefined;
}) {
  const [perm] = await params.tx.$queryRaw<
    { ok: boolean }[]
  >`SELECT (${params.cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede timbrar CFDI');
  }

  const coto = await params.tx.coto.findUnique({
    where: { id: params.cotoId },
    select: {
      orgId: true,
      rfcCoto: true,
      razonSocialCoto: true,
      regimenFiscal: true,
      cpFiscal: true,
      facturapiOrgId: true,
    },
  });
  if (!coto) throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  if (!coto.facturapiOrgId) {
    throw new AppError(409, 'cfdi_no_configurado', 'El coto no tiene organización fiscal configurada en el PAC');
  }

  validarDatosFiscales({
    emisor: {
      rfc: coto.rfcCoto ?? '',
      nombre: coto.razonSocialCoto ?? '',
      regimenFiscal: coto.regimenFiscal ?? '',
      cpFiscal: coto.cpFiscal ?? '',
    },
    receptor: {
      rfc: params.receptor.rfc,
      nombre: params.receptor.nombre,
      regimenFiscal: params.receptor.regimenFiscal,
      cpFiscal: params.receptor.cpFiscal,
      usoCfdi: params.receptor.usoCfdi,
    },
  });

  const pago = await params.tx.pago.findFirst({
    where: { id: params.pagoId, cotoId: params.cotoId },
    select: { id: true, estado: true },
  });
  if (!pago) throw new AppError(404, 'pago_no_encontrado', 'Pago no encontrado en este coto');
  if (pago.estado !== 'confirmado') {
    throw new AppError(409, 'pago_no_confirmado', 'Solo se pueden facturar pagos confirmados');
  }

  const existenteActiva = await params.tx.facturaCfdi.findFirst({
    where: { pagoId: params.pagoId, estado: { notIn: ['cancelado', 'fallido'] } },
    select: {
      ...selectFactura,
      claveIdempotencia: true,
      receptorRegimen: true,
      receptorCp: true,
      receptorUsoCfdi: true,
    },
  });
  if (existenteActiva?.estado === 'pendiente' && existenteActiva.claveIdempotencia) {
    // B1: una fila `pendiente` cuyo job se agotó se reanuda con su propia clave y receptor; el worker
    // la retoma con el `pacInvoiceId` guardado (o lo busca por `external_id`) sin volver a timbrar.
    // ponytail: jobId por minuto; si el job original sigue vivo, ambos se serializan por el candado del coto.
    await params.encolarCfdi(
      {
        accion: 'timbrar',
        cotoId: params.cotoId,
        pagoId: params.pagoId,
        receptor: {
          rfc: existenteActiva.receptorRfc,
          nombre: existenteActiva.receptorNombre,
          regimenFiscal: existenteActiva.receptorRegimen ?? '',
          cpFiscal: existenteActiva.receptorCp ?? '',
          usoCfdi: existenteActiva.receptorUsoCfdi ?? '',
        },
        claveIdempotencia: existenteActiva.claveIdempotencia,
      },
      { jobId: `cfdi-reanudar-${existenteActiva.id}-${Math.floor(Date.now() / 60_000)}` },
    );
    return { encolado: true as const, status: 'encolado' as const, pagoId: params.pagoId };
  }
  if (existenteActiva) {
    return { encolado: false as const, factura: aDto(existenteActiva) };
  }

  const [timbres] = await params.tx.$queryRaw<{ disponibles: number }[]>`
    SELECT coalesce(sum(cantidad - usados), 0)::int AS disponibles
      FROM paquetes_timbres
     WHERE org_id = ${coto.orgId}::uuid AND estado = 'activo' AND usados < cantidad
  `;
  if (!timbres || timbres.disponibles < 1) {
    throw new AppError(409, 'sin_timbres_disponibles', 'La organización no cuenta con timbres fiscales disponibles');
  }

  const previas = await params.tx.facturaCfdi.count({
    where: { pagoId: params.pagoId, estado: { in: ['cancelado', 'fallido'] } },
  });
  const sufijo = previas > 0 ? `-r${previas}` : '';
  const claveBase = params.idempotencyKey
    ? `cfdi:${params.usuarioId}:${params.idempotencyKey}`
    : `cfdi-pago:${params.pagoId}`;
  const claveIdempotencia = previas > 0 ? `${claveBase}:r${previas}` : claveBase;

  await params.encolarCfdi(
    {
      accion: 'timbrar',
      cotoId: params.cotoId,
      pagoId: params.pagoId,
      receptor: {
        rfc: params.receptor.rfc.toUpperCase(),
        nombre: params.receptor.nombre,
        regimenFiscal: params.receptor.regimenFiscal,
        cpFiscal: params.receptor.cpFiscal,
        usoCfdi: params.receptor.usoCfdi,
        ...(params.receptor.email ? { email: params.receptor.email } : {}),
      },
      claveIdempotencia,
    },
    { jobId: `cfdi-timbrar-${params.pagoId}${sufijo}` },
  );

  return { encolado: true as const, status: 'encolado' as const, pagoId: params.pagoId };
}

export async function listarFacturas(
  tx: Prisma.TransactionClient,
  cotoId: string,
  limite: number,
  cursor?: string,
): Promise<{ datos: z.infer<typeof FacturaCfdiDto>[]; siguiente?: string }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (
         ${cotoId}::uuid = ANY (app.cotos_finanzas())
      OR EXISTS (SELECT 1 FROM unidades u WHERE u.coto_id = ${cotoId}::uuid AND u.id = ANY (app.unidades_propias()))
    ) AS ok
  `;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar facturas de este coto');
  }

  const filas = await tx.facturaCfdi.findMany({
    where: { cotoId },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: selectFactura,
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), ...(siguiente ? { siguiente } : {}) };
}

export async function urlsDescargaFactura(tx: Prisma.TransactionClient, facturaId: string, storage: StorageService) {
  const [fila] = await tx.$queryRaw<
    {
      id: string;
      uuid_cfdi: string | null;
      xml_url: string | null;
      pdf_url: string | null;
    }[]
  >`
    SELECT f.id, f.uuid_cfdi, f.xml_url, f.pdf_url
      FROM facturas_cfdi f
     WHERE f.id = ${facturaId}::uuid
       AND (
         f.coto_id = ANY (app.cotos_finanzas())
         OR EXISTS (SELECT 1 FROM pagos p WHERE p.id = f.pago_id AND p.unidad_id = ANY (app.unidades_propias()))
       )
     LIMIT 1
  `;
  if (!fila) {
    throw new AppError(404, 'factura_no_encontrada', 'Factura no encontrada o sin acceso');
  }
  const baseNombre = fila.uuid_cfdi ?? fila.id;
  const xml = fila.xml_url
    ? await storage.urlDeDescarga({ llave: fila.xml_url, ttlSegundos: 120, nombreDescarga: `${baseNombre}.xml` })
    : null;
  const pdf = fila.pdf_url
    ? await storage.urlDeDescarga({ llave: fila.pdf_url, ttlSegundos: 120, nombreDescarga: `${baseNombre}.pdf` })
    : null;
  return {
    xmlUrl: xml?.url ?? null,
    pdfUrl: pdf?.url ?? null,
    expiraEnSegundos: 120,
  };
}

export async function encolarCancelacion(params: {
  tx: Prisma.TransactionClient;
  facturaId: string;
  datos: z.infer<typeof CancelarFactura>;
  encolarCfdi: EncoladorCfdi;
}) {
  const factura = await params.tx.facturaCfdi.findUnique({
    where: { id: params.facturaId },
    select: { id: true, cotoId: true, estado: true },
  });
  if (!factura) throw new AppError(404, 'factura_no_encontrada', 'Factura no encontrada');

  const [perm] = await params.tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (${factura.cotoId}::uuid = ANY (app.cotos_admin())) AS ok
  `;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede cancelar facturas');
  }
  if (factura.estado === 'pendiente_cancelacion') {
    await params.encolarCfdi(
      {
        accion: 'verificar_cancelacion',
        cotoId: factura.cotoId,
        facturaId: factura.id,
        intento: 1,
      },
      { jobId: `cfdi-verif-${factura.id}-1` },
    );
    return { status: 'encolado' as const, facturaId: factura.id };
  }
  if (factura.estado !== 'timbrado') {
    throw new AppError(409, 'estado_invalido', 'Solo se pueden cancelar facturas timbradas');
  }

  await params.encolarCfdi(
    {
      accion: 'cancelar',
      cotoId: factura.cotoId,
      facturaId: factura.id,
      motivo: params.datos.motivo,
      ...(params.datos.sustitucionUuid ? { sustitucionUuid: params.datos.sustitucionUuid } : {}),
    },
    { jobId: `cfdi-cancelar-${factura.id}` },
  );

  return { status: 'encolado' as const, facturaId: factura.id };
}
