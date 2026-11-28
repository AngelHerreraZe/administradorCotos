import type { Prisma } from '@admcotos/db';
import { crearOrden as crearOrdenConekta, esRechazoDefinitivoConekta, montoACentavos } from '@admcotos/payments';
import { AppError } from '@admcotos/shared';
import { validarLlaveObjeto } from '@admcotos/storage';
import type { z } from '@hono/zod-openapi';
import { conIdempotencia } from '../../lib/prisma.ts';
import type { ConektaDeps, StorageService } from '../../types.ts';
import type {
  CrearPagoManual,
  CrearPagoOnline,
  EstadoPago,
  PagoDto,
  RegistrarComprobante,
  SolicitarUrlComprobante,
} from './schemas.ts';

const selectPago = {
  id: true,
  cotoId: true,
  unidadId: true,
  monto: true,
  metodo: true,
  gateway: true,
  gatewayOrderId: true,
  gatewayChargeId: true,
  gatewayMetadata: true,
  comprobanteUrl: true,
  referenciaBancaria: true,
  claveRastreo: true,
  estado: true,
  motivoRechazo: true,
  notas: true,
  fechaPago: true,
  fechaConfirmacion: true,
  aplicadoEn: true,
} as const;

export interface ContextoRecibo {
  email: string;
  coto: string;
  unidad: string;
  monto: string;
  fecha: string;
}

interface GatewayMetadata {
  checkoutUrl?: string;
  clabeSpei?: string;
  referenciaOxxo?: string;
}

function extraerMeta(raw: unknown): GatewayMetadata {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  return {
    ...(typeof r.checkoutUrl === 'string' ? { checkoutUrl: r.checkoutUrl } : {}),
    ...(typeof r.clabeSpei === 'string' ? { clabeSpei: r.clabeSpei } : {}),
    ...(typeof r.referenciaOxxo === 'string' ? { referenciaOxxo: r.referenciaOxxo } : {}),
  };
}

function aDto(row: Prisma.PagoGetPayload<{ select: typeof selectPago }>): z.infer<typeof PagoDto> {
  return {
    id: row.id,
    cotoId: row.cotoId,
    unidadId: row.unidadId,
    monto: row.monto.toString(),
    metodo: row.metodo,
    gateway: row.gateway,
    gatewayOrderId: row.gatewayOrderId,
    gatewayChargeId: row.gatewayChargeId,
    comprobanteUrl: row.comprobanteUrl,
    referenciaBancaria: row.referenciaBancaria,
    claveRastreo: row.claveRastreo,
    estado: row.estado as z.infer<typeof EstadoPago>,
    motivoRechazo: row.motivoRechazo,
    notas: row.notas,
    fechaPago: row.fechaPago.toISOString(),
    fechaConfirmacion: row.fechaConfirmacion?.toISOString() ?? null,
    aplicadoEn: row.aplicadoEn?.toISOString() ?? null,
  };
}

async function buscarDatosRecibo(
  tx: Prisma.TransactionClient,
  unidadId: string,
  monto: string,
  fechaIso: string,
): Promise<ContextoRecibo | undefined> {
  const [fila] = await tx.$queryRaw<{ email: string; coto: string; unidad: string }[]>`
    SELECT usr.email, c.nombre AS coto, u.numero AS unidad
      FROM unidades u
      JOIN cotos c ON c.id = u.coto_id
      JOIN miembros_coto mc ON mc.unidad_id = u.id AND mc.rol = 'residente_propietario' AND mc.activo
      JOIN usuarios usr ON usr.id = mc.usuario_id AND usr.activo
     WHERE u.id = ${unidadId}::uuid
     ORDER BY mc.created_at
     LIMIT 1
  `;
  if (!fila) return undefined;
  return {
    email: fila.email,
    coto: fila.coto,
    unidad: fila.unidad,
    monto,
    fecha: fechaIso.slice(0, 10),
  };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  filtro: {
    estado?: z.infer<typeof EstadoPago> | undefined;
    unidadId?: string | undefined;
    limite: number;
    cursor?: string | undefined;
  },
): Promise<{ datos: z.infer<typeof PagoDto>[]; siguiente?: string }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (
         ${cotoId}::uuid = ANY (app.cotos_finanzas())
      OR EXISTS (
        SELECT 1 FROM unidades u
         WHERE u.coto_id = ${cotoId}::uuid
           AND u.id = ANY (app.unidades_propias())
           AND (${filtro.unidadId ?? null}::uuid IS NULL OR u.id = ${filtro.unidadId ?? null}::uuid)
      )
    ) AS ok
  `;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar pagos de este coto');
  }

  const filas = await tx.pago.findMany({
    where: {
      cotoId,
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.unidadId ? { unidadId: filtro.unidadId } : {}),
    },
    orderBy: [{ fechaPago: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    take: filtro.limite + 1,
    ...(filtro.cursor ? { cursor: { id: filtro.cursor }, skip: 1 } : {}),
    select: selectPago,
  });
  const siguiente = filas.length > filtro.limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), ...(siguiente ? { siguiente } : {}) };
}

export async function crearManual(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearPagoManual>,
  idempotencyKey?: string,
): Promise<{ creado: boolean; dato: z.infer<typeof PagoDto>; recibo?: ContextoRecibo }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede registrar pagos manuales');
  }

  const clave = idempotencyKey ? `pago-manual:${usuarioId}:${idempotencyKey}` : undefined;
  const ahora = new Date();
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.pago.create({
        data: {
          cotoId,
          unidadId: datos.unidadId,
          monto: datos.monto,
          metodo: datos.metodo,
          gateway: 'manual',
          estado: 'confirmado',
          fechaPago: datos.fechaPago ? new Date(datos.fechaPago) : ahora,
          fechaConfirmacion: ahora,
          ...(datos.referenciaBancaria ? { referenciaBancaria: datos.referenciaBancaria } : {}),
          ...(datos.claveRastreo ? { claveRastreo: datos.claveRastreo } : {}),
          ...(datos.notas ? { notas: datos.notas } : {}),
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select: selectPago,
      }),
    () =>
      clave ? tx.pago.findUnique({ where: { claveIdempotencia: clave }, select: selectPago }) : Promise.resolve(null),
  );

  if (!res.creado) {
    return { creado: false, dato: aDto(res.dato) };
  }

  await tx.$executeRaw`SELECT app.aplicar_pago(${res.dato.id}::uuid)`;
  const aplicado = await tx.pago.findUniqueOrThrow({ where: { id: res.dato.id }, select: selectPago });
  const dto = aDto(aplicado);
  const recibo = await buscarDatosRecibo(tx, dto.unidadId, dto.monto, dto.fechaPago);
  return { creado: true, dato: dto, ...(recibo ? { recibo } : {}) };
}

export async function generarUrlSubidaComprobante(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof SolicitarUrlComprobante>,
  storage: StorageService,
) {
  const [fila] = await tx.$queryRaw<{ org_id: string; es_propietario: boolean }[]>`
    SELECT c.org_id, (${datos.unidadId}::uuid = ANY (app.unidades_propias())) AS es_propietario
      FROM unidades u
      JOIN cotos c ON c.id = u.coto_id
     WHERE u.id = ${datos.unidadId}::uuid AND u.coto_id = ${cotoId}::uuid
     LIMIT 1
  `;
  if (!fila) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada en este coto');
  if (!fila.es_propietario) {
    throw new AppError(403, 'sin_permiso', 'Solo la persona propietaria de la unidad puede subir comprobantes');
  }

  const llave = storage.llaveParaArchivo(fila.org_id, cotoId, 'comprobantes', datos.contentType);
  return storage.urlDeSubida({ llave, contentType: datos.contentType });
}

export async function registrarComprobante(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof RegistrarComprobante>,
  idempotencyKey?: string,
): Promise<{ creado: boolean; dato: z.infer<typeof PagoDto> }> {
  const [fila] = await tx.$queryRaw<{ org_id: string; es_propietario: boolean }[]>`
    SELECT c.org_id, (${datos.unidadId}::uuid = ANY (app.unidades_propias())) AS es_propietario
      FROM unidades u
      JOIN cotos c ON c.id = u.coto_id
     WHERE u.id = ${datos.unidadId}::uuid AND u.coto_id = ${cotoId}::uuid
     LIMIT 1
  `;
  if (!fila) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada en este coto');
  if (!fila.es_propietario) {
    throw new AppError(403, 'sin_permiso', 'Solo la persona propietaria de la unidad puede registrar comprobantes');
  }

  const llave = validarLlaveObjeto(datos.llaveArchivo);
  const prefijoEsperado = `${fila.org_id.toLowerCase()}/${cotoId.toLowerCase()}/comprobantes/`;
  if (!llave.startsWith(prefijoEsperado)) {
    throw new AppError(422, 'llave_invalida', 'El comprobante no corresponde al ámbito de este coto');
  }

  const clave = idempotencyKey ? `pago-comp:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.pago.create({
        data: {
          cotoId,
          unidadId: datos.unidadId,
          monto: datos.monto,
          metodo: 'transferencia_manual',
          gateway: 'manual',
          comprobanteUrl: llave,
          estado: 'en_revision',
          ...(datos.fechaPago ? { fechaPago: new Date(datos.fechaPago) } : {}),
          ...(datos.claveRastreo ? { claveRastreo: datos.claveRastreo } : {}),
          ...(datos.referenciaBancaria ? { referenciaBancaria: datos.referenciaBancaria } : {}),
          ...(datos.notas ? { notas: datos.notas } : {}),
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select: selectPago,
      }),
    () =>
      clave ? tx.pago.findUnique({ where: { claveIdempotencia: clave }, select: selectPago }) : Promise.resolve(null),
  );
  return { creado: res.creado, dato: aDto(res.dato) };
}

export async function confirmar(
  tx: Prisma.TransactionClient,
  pagoId: string,
): Promise<{ dato: z.infer<typeof PagoDto>; recienConfirmado: boolean; recibo?: ContextoRecibo }> {
  const actual = await tx.pago.findUnique({ where: { id: pagoId }, select: selectPago });
  if (!actual) throw new AppError(404, 'pago_no_encontrado', 'Pago no encontrado');

  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${actual.cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede confirmar pagos');
  }

  if (actual.estado === 'confirmado' && actual.aplicadoEn) {
    return { dato: aDto(actual), recienConfirmado: false };
  }
  if (actual.gateway !== 'manual') {
    throw new AppError(409, 'gateway_no_manual', 'Solo se pueden confirmar manualmente pagos con método manual');
  }
  if (actual.estado !== 'pendiente' && actual.estado !== 'en_revision') {
    throw new AppError(409, 'estado_invalido', 'Solo se pueden confirmar pagos pendientes o en revisión');
  }

  await tx.pago.update({
    where: { id: pagoId },
    data: { estado: 'confirmado', fechaConfirmacion: new Date() },
  });
  await tx.$executeRaw`SELECT app.aplicar_pago(${pagoId}::uuid)`;

  const actualizado = await tx.pago.findUniqueOrThrow({ where: { id: pagoId }, select: selectPago });
  const dto = aDto(actualizado);
  const recibo = await buscarDatosRecibo(tx, dto.unidadId, dto.monto, dto.fechaPago);
  return { dato: dto, recienConfirmado: true, ...(recibo ? { recibo } : {}) };
}

export async function rechazar(
  tx: Prisma.TransactionClient,
  pagoId: string,
  motivo: string,
): Promise<z.infer<typeof PagoDto>> {
  await tx.$executeRaw`SELECT app.rechazar_pago(${pagoId}::uuid, ${motivo})`;
  const row = await tx.pago.findUnique({ where: { id: pagoId }, select: selectPago });
  if (!row) throw new AppError(404, 'pago_no_encontrado', 'Pago no encontrado');
  return aDto(row);
}

export async function obtenerUrlDescargaComprobante(
  tx: Prisma.TransactionClient,
  pagoId: string,
  storage: StorageService,
) {
  const [fila] = await tx.$queryRaw<
    { id: string; coto_id: string; unidad_id: string; comprobante_url: string | null }[]
  >`
    SELECT id, coto_id, unidad_id, comprobante_url
      FROM pagos
     WHERE id = ${pagoId}::uuid
       AND (coto_id = ANY (app.cotos_finanzas()) OR unidad_id = ANY (app.unidades_propias()))
     LIMIT 1
  `;
  if (!fila) {
    throw new AppError(404, 'pago_no_encontrado', 'Pago no encontrado o sin acceso');
  }
  if (!fila.comprobante_url) {
    throw new AppError(404, 'sin_comprobante', 'Este pago no tiene comprobante adjunto');
  }
  return storage.urlDeDescarga({
    llave: fila.comprobante_url,
    ttlSegundos: 120,
    nombreDescarga: `comprobante-${pagoId}.bin`,
  });
}

export async function prepararPagoOnline(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearPagoOnline>,
  claveIdempotencia: string,
) {
  const clave = `pago-online:${usuarioId}:${claveIdempotencia}`;
  const existente = await tx.pago.findUnique({ where: { claveIdempotencia: clave }, select: selectPago });
  if (existente?.gatewayOrderId) {
    return {
      tipo: 'listo' as const,
      pago: aDto(existente),
      meta: extraerMeta(existente.gatewayMetadata),
      clave,
    };
  }

  const [ctx] = await tx.$queryRaw<
    {
      es_propietario: boolean;
      coto_nombre: string;
      unidad_numero: string;
      nombre: string;
      email: string;
      telefono: string | null;
    }[]
  >`
    SELECT (${datos.unidadId}::uuid = ANY (app.unidades_propias())) AS es_propietario,
           c.nombre AS coto_nombre,
           u.numero AS unidad_numero,
           concat_ws(' ', usr.nombre, usr.apellido_paterno) AS nombre,
           usr.email,
           usr.telefono
      FROM unidades u
      JOIN cotos c ON c.id = u.coto_id
      JOIN usuarios usr ON usr.id = ${usuarioId}::uuid
     WHERE u.id = ${datos.unidadId}::uuid AND u.coto_id = ${cotoId}::uuid
     LIMIT 1
  `;
  if (!ctx) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada en este coto');
  if (!ctx.es_propietario) {
    throw new AppError(403, 'sin_permiso', 'Solo la persona propietaria de la unidad puede iniciar pagos en línea');
  }

  const metodoBd = datos.metodo === 'spei' ? 'spei' : datos.metodo === 'oxxo' ? 'oxxo' : 'tarjeta';
  const pagoPendiente =
    existente ??
    (
      await conIdempotencia(
        tx,
        clave,
        () =>
          tx.pago.create({
            data: {
              cotoId,
              unidadId: datos.unidadId,
              monto: datos.monto,
              metodo: metodoBd,
              gateway: 'conekta',
              estado: 'pendiente',
              claveIdempotencia: clave,
            },
            select: selectPago,
          }),
        () => tx.pago.findUnique({ where: { claveIdempotencia: clave }, select: selectPago }),
      )
    ).dato;

  if (pagoPendiente.gatewayOrderId) {
    return {
      tipo: 'listo' as const,
      pago: aDto(pagoPendiente),
      meta: extraerMeta(pagoPendiente.gatewayMetadata),
      clave,
    };
  }

  return { tipo: 'nuevo' as const, pagoId: pagoPendiente.id, ctx, clave };
}

export async function crearOrdenYGuardarPagoOnline(params: {
  txWrapper: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  cotoId: string;
  usuarioId: string;
  datos: z.infer<typeof CrearPagoOnline>;
  claveIdempotencia: string;
  conekta: ConektaDeps;
}) {
  const prep = await params.txWrapper((tx) =>
    prepararPagoOnline(tx, params.cotoId, params.usuarioId, params.datos, params.claveIdempotencia),
  );
  if (prep.tipo === 'listo') {
    return {
      creado: false,
      resultado: {
        pago: prep.pago,
        gatewayOrderId: prep.pago.gatewayOrderId ?? '',
        ...prep.meta,
      },
    };
  }

  const montoCentavos = montoACentavos(params.datos.monto);
  let orden: Awaited<ReturnType<typeof crearOrdenConekta>>;
  try {
    orden = await crearOrdenConekta(
      {
        pagoId: prep.pagoId,
        cotoId: params.cotoId,
        unidadId: params.datos.unidadId,
        concepto: params.datos.concepto ?? `Cuota ${prep.ctx.coto_nombre} · ${prep.ctx.unidad_numero}`,
        montoCentavos,
        metodo: params.datos.metodo,
        cliente: {
          nombre: prep.ctx.nombre || 'Residente',
          email: prep.ctx.email,
          ...(prep.ctx.telefono ? { telefono: prep.ctx.telefono } : {}),
        },
        ...(params.datos.tokenTarjeta ? { tokenTarjeta: params.datos.tokenTarjeta } : {}),
        ...(params.datos.successUrl ? { successUrl: params.datos.successUrl } : {}),
        ...(params.datos.failureUrl ? { failureUrl: params.datos.failureUrl } : {}),
        idempotencyKey: prep.clave,
      },
      params.conekta.cliente,
    );
  } catch (err) {
    if (esRechazoDefinitivoConekta(err)) {
      await params.txWrapper(async (tx) => {
        await tx.$executeRaw`SELECT app.rechazar_pago(${prep.pagoId}::uuid, 'Rechazo definitivo de pasarela')`;
      });
    }
    throw err;
  }

  const meta: GatewayMetadata = {
    ...(orden.checkoutUrl ? { checkoutUrl: orden.checkoutUrl } : {}),
    ...(orden.clabeSpei ? { clabeSpei: orden.clabeSpei } : {}),
    ...(orden.referenciaOxxo ? { referenciaOxxo: orden.referenciaOxxo } : {}),
  };
  const metaJson: Record<string, string> = {};
  if (orden.checkoutUrl) metaJson.checkoutUrl = orden.checkoutUrl;
  if (orden.clabeSpei) metaJson.clabeSpei = orden.clabeSpei;
  if (orden.referenciaOxxo) metaJson.referenciaOxxo = orden.referenciaOxxo;

  const actualizado = await params.txWrapper(async (tx) => {
    const actual = await tx.pago.findUniqueOrThrow({ where: { id: prep.pagoId }, select: selectPago });
    if (actual.gatewayOrderId) {
      return actual;
    }
    return tx.pago.update({
      where: { id: prep.pagoId },
      data: {
        gatewayOrderId: orden.gatewayOrderId,
        ...(!actual.gatewayChargeId && orden.gatewayChargeId ? { gatewayChargeId: orden.gatewayChargeId } : {}),
        gatewayMetadata: metaJson,
      },
      select: selectPago,
    });
  });

  return {
    creado: true,
    resultado: {
      pago: aDto(actualizado),
      gatewayOrderId: orden.gatewayOrderId,
      ...meta,
    },
  };
}
