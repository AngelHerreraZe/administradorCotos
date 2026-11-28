import type { Prisma } from '@admcotos/db';
import { agregarFuente as agregarFuenteConekta, crearCliente as crearClienteConekta } from '@admcotos/payments';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls } from '../../lib/prisma.ts';
import type { ConektaDeps } from '../../types.ts';
import type {
  ActivarAutopay,
  ActualizarAutopay,
  AgregarMetodoPago,
  AutopayConfigDto,
  AutopayIntentoDto,
  EstadoAutopay,
  MetodoPagoDto,
  TipoMetodoPago,
} from './schemas.ts';

const selectMetodo = {
  id: true,
  cotoId: true,
  unidadId: true,
  tipo: true,
  gateway: true,
  label: true,
  ultimos4: true,
  marcaTarjeta: true,
  fechaExpiracion: true,
  esDefault: true,
  activo: true,
} as const;

const selectAutopay = {
  id: true,
  cotoId: true,
  unidadId: true,
  paymentMethodId: true,
  activo: true,
  diaCobro: true,
  maxReintentos: true,
  intentosFallidos: true,
  ultimoCobroExitoso: true,
  proximoCobro: true,
  estado: true,
  terminosVersion: true,
  terminosAceptadosEn: true,
} as const;

const selectIntento = {
  id: true,
  cargoId: true,
  pagoId: true,
  intentoNum: true,
  montoCentavos: true,
  gateway: true,
  estado: true,
  codigoError: true,
  mensajeError: true,
  programadoPara: true,
  ejecutadoEn: true,
} as const;

function aMetodoDto(
  row: Prisma.PaymentMethodGetPayload<{ select: typeof selectMetodo }>,
): z.infer<typeof MetodoPagoDto> {
  return {
    ...row,
    tipo: row.tipo as z.infer<typeof TipoMetodoPago>,
  };
}

function aAutopayDto(
  row: Prisma.AutopayConfigGetPayload<{ select: typeof selectAutopay }>,
): z.infer<typeof AutopayConfigDto> {
  return {
    ...row,
    estado: row.estado as z.infer<typeof EstadoAutopay>,
    ultimoCobroExitoso: row.ultimoCobroExitoso?.toISOString().slice(0, 10) ?? null,
    proximoCobro: row.proximoCobro?.toISOString().slice(0, 10) ?? null,
    terminosAceptadosEn: row.terminosAceptadosEn?.toISOString() ?? null,
  };
}

function aIntentoDto(
  row: Prisma.AutopayIntentoGetPayload<{ select: typeof selectIntento }>,
): z.infer<typeof AutopayIntentoDto> {
  return {
    ...row,
    estado: row.estado as z.infer<typeof AutopayIntentoDto>['estado'],
    programadoPara: row.programadoPara.toISOString(),
    ejecutadoEn: row.ejecutadoEn?.toISOString() ?? null,
  };
}

export function calcularProximoCobro(diaCobro: number, ahora = new Date()): Date {
  const anio = ahora.getUTCFullYear();
  const mes = ahora.getUTCMonth();
  const diaHoy = ahora.getUTCDate();
  if (diaCobro >= diaHoy) {
    return new Date(Date.UTC(anio, mes, diaCobro));
  }
  return new Date(Date.UTC(anio, mes + 1, diaCobro));
}

async function verificarLecturaUnidad(tx: Prisma.TransactionClient, unidadId: string) {
  const [fila] = await tx.$queryRaw<{ coto_id: string; ok: boolean }[]>`
    SELECT u.coto_id,
           (u.coto_id = ANY (app.cotos_finanzas()) OR u.id = ANY (app.unidades_propias())) AS ok
      FROM unidades u
     WHERE u.id = ${unidadId}::uuid
     LIMIT 1
  `;
  if (!fila) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada');
  if (!fila.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar esta unidad');
  return fila.coto_id;
}

export async function listarMetodos(tx: Prisma.TransactionClient, unidadId: string) {
  await verificarLecturaUnidad(tx, unidadId);
  const filas = await tx.paymentMethod.findMany({
    where: { unidadId, activo: true },
    orderBy: [{ esDefault: 'desc' }, { createdAt: 'desc' }],
    select: selectMetodo,
  });
  return { datos: filas.map(aMetodoDto) };
}

export async function agregarMetodoPago(params: {
  txWrapper: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  unidadId: string;
  usuarioId: string;
  datos: z.infer<typeof AgregarMetodoPago>;
  conekta: ConektaDeps;
}) {
  const prep = await params.txWrapper(async (tx) => {
    const [fila] = await tx.$queryRaw<
      {
        coto_id: string;
        es_propietario: boolean;
        nombre: string;
        email: string;
        telefono: string | null;
        gateway_customer_id: string | null;
      }[]
    >`
      SELECT u.coto_id,
             (${params.unidadId}::uuid = ANY (app.unidades_propias())) AS es_propietario,
             concat_ws(' ', usr.nombre, usr.apellido_paterno) AS nombre,
             usr.email,
             usr.telefono,
             (SELECT pm.gateway_customer_id
                FROM payment_methods pm
               WHERE pm.usuario_id = ${params.usuarioId}::uuid AND pm.gateway = 'conekta'
               ORDER BY pm.created_at DESC
               LIMIT 1) AS gateway_customer_id
        FROM unidades u
        JOIN usuarios usr ON usr.id = ${params.usuarioId}::uuid
       WHERE u.id = ${params.unidadId}::uuid
       LIMIT 1
    `;
    if (!fila) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada');
    if (!fila.es_propietario) {
      throw new AppError(403, 'sin_permiso', 'Solo la persona propietaria de la unidad puede guardar métodos de pago');
    }
    return fila;
  });

  let customerId = prep.gateway_customer_id;
  if (!customerId) {
    const cli = await crearClienteConekta(
      {
        nombre: prep.nombre || 'Residente',
        email: prep.email,
        ...(prep.telefono ? { telefono: prep.telefono } : {}),
      },
      params.conekta.cliente,
    );
    customerId = cli.customerId;
  }

  const fuente = await agregarFuenteConekta({ customerId, tokenId: params.datos.tokenId }, params.conekta.cliente);

  const guardado = await params.txWrapper(async (tx) => {
    if (params.datos.esDefault) {
      await tx.paymentMethod.updateMany({
        where: { unidadId: params.unidadId, activo: true, esDefault: true },
        data: { esDefault: false },
      });
    }
    return tx.paymentMethod.create({
      data: {
        cotoId: prep.coto_id,
        unidadId: params.unidadId,
        usuarioId: params.usuarioId,
        tipo: params.datos.tipo,
        gateway: 'conekta',
        gatewayCustomerId: customerId,
        gatewaySourceId: fuente.sourceId,
        esDefault: params.datos.esDefault,
        ...(params.datos.label ? { label: params.datos.label } : {}),
        ...((fuente.ultimos4 ?? params.datos.ultimos4) ? { ultimos4: fuente.ultimos4 ?? params.datos.ultimos4 } : {}),
        ...((fuente.marca ?? params.datos.marcaTarjeta)
          ? { marcaTarjeta: fuente.marca ?? params.datos.marcaTarjeta }
          : {}),
        ...((fuente.expiracion ?? params.datos.fechaExpiracion)
          ? { fechaExpiracion: fuente.expiracion ?? params.datos.fechaExpiracion }
          : {}),
      },
      select: selectMetodo,
    });
  });

  return aMetodoDto(guardado);
}

export async function desactivarMetodoPago(tx: Prisma.TransactionClient, unidadId: string, metodoId: string) {
  const actual = await tx.paymentMethod.findFirst({ where: { id: metodoId, unidadId }, select: { id: true } });
  if (!actual) throw new AppError(404, 'metodo_pago_no_encontrado', 'Método de pago no encontrado');

  await actualizarConRls(() =>
    tx.paymentMethod.update({ where: { id: metodoId }, data: { activo: false, esDefault: false } }),
  );
  await tx.autopayConfig.updateMany({
    where: { unidadId, paymentMethodId: metodoId, activo: true },
    data: { activo: false, estado: 'cancelado_por_usuario' },
  });
  return { desactivado: true };
}

export async function activarAutopay(
  tx: Prisma.TransactionClient,
  unidadId: string,
  usuarioId: string,
  datos: z.infer<typeof ActivarAutopay>,
): Promise<z.infer<typeof AutopayConfigDto>> {
  const [unidad] = await tx.$queryRaw<{ coto_id: string }[]>`
    SELECT coto_id FROM unidades WHERE id = ${unidadId}::uuid LIMIT 1
  `;
  if (!unidad) throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada');

  const proximo = calcularProximoCobro(datos.diaCobro);
  const ahora = new Date();

  const existente = await tx.autopayConfig.findUnique({ where: { unidadId }, select: { id: true } });
  if (existente) {
    const upd = await actualizarConRls(() =>
      tx.autopayConfig.update({
        where: { unidadId },
        data: {
          paymentMethodId: datos.paymentMethodId,
          activo: true,
          estado: 'activo',
          diaCobro: datos.diaCobro,
          intentosFallidos: 0,
          proximoCobro: proximo,
          terminosVersion: datos.terminosVersion,
          terminosAceptadosEn: ahora,
          activadoPor: usuarioId,
        },
        select: selectAutopay,
      }),
    );
    return aAutopayDto(upd);
  }

  const creado = await tx.autopayConfig.create({
    data: {
      cotoId: unidad.coto_id,
      unidadId,
      paymentMethodId: datos.paymentMethodId,
      activo: true,
      estado: 'activo',
      diaCobro: datos.diaCobro,
      proximoCobro: proximo,
      terminosVersion: datos.terminosVersion,
      terminosAceptadosEn: ahora,
      activadoPor: usuarioId,
    },
    select: selectAutopay,
  });
  return aAutopayDto(creado);
}

export async function actualizarAutopay(
  tx: Prisma.TransactionClient,
  unidadId: string,
  usuarioId: string,
  datos: z.infer<typeof ActualizarAutopay>,
): Promise<z.infer<typeof AutopayConfigDto>> {
  const actual = await tx.autopayConfig.findUnique({ where: { unidadId }, select: selectAutopay });
  if (!actual) throw new AppError(404, 'autopay_no_configurado', 'Domiciliación no configurada en esta unidad');

  const data: Prisma.AutopayConfigUncheckedUpdateInput = {};
  if (datos.diaCobro !== undefined) {
    data.diaCobro = datos.diaCobro;
    data.proximoCobro = calcularProximoCobro(datos.diaCobro);
  }
  if (datos.paymentMethodId !== undefined) data.paymentMethodId = datos.paymentMethodId;
  if (datos.terminosVersion !== undefined) {
    data.terminosVersion = datos.terminosVersion;
    data.terminosAceptadosEn = new Date();
  }
  if (datos.estado !== undefined) {
    data.estado = datos.estado;
    data.activo = datos.estado === 'activo';
    if (datos.estado === 'activo') {
      data.activadoPor = usuarioId;
      data.intentosFallidos = 0;
    }
  }

  const upd = await actualizarConRls(() =>
    tx.autopayConfig.update({ where: { unidadId }, data, select: selectAutopay }),
  );
  return aAutopayDto(upd);
}

export async function historialAutopay(
  tx: Prisma.TransactionClient,
  unidadId: string,
  limite: number,
  cursor?: string,
): Promise<{ datos: z.infer<typeof AutopayIntentoDto>[]; siguiente?: string }> {
  await verificarLecturaUnidad(tx, unidadId);
  const config = await tx.autopayConfig.findUnique({ where: { unidadId }, select: { id: true } });
  if (!config) return { datos: [] };

  const filas = await tx.autopayIntento.findMany({
    where: { autopayId: config.id },
    orderBy: [{ programadoPara: 'desc' }, { id: 'asc' }],
    take: limite + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: selectIntento,
  });
  const siguiente = filas.length > limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aIntentoDto), ...(siguiente ? { siguiente } : {}) };
}
