import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import { validarLlaveObjeto } from '@admcotos/storage';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls, conIdempotencia } from '../../lib/prisma.ts';
import type { StorageService } from '../../types.ts';
import type {
  ActualizarEgreso,
  CrearEgreso,
  EgresoDto,
  EstadoEgreso,
  SolicitarUrlComprobanteEgreso,
} from './schemas.ts';

const selectEgreso = {
  id: true,
  cotoId: true,
  cuentaBancariaId: true,
  proveedorId: true,
  categoria: true,
  concepto: true,
  monto: true,
  fecha: true,
  estado: true,
  solicitadoPor: true,
  aprobadoPor: true,
  aprobadoEn: true,
  rechazadoEn: true,
  motivoRechazo: true,
  tieneFactura: true,
  facturaUuid: true,
  comprobanteUrl: true,
  notas: true,
} as const;

function aDto(row: Prisma.EgresoGetPayload<{ select: typeof selectEgreso }>): z.infer<typeof EgresoDto> {
  return {
    id: row.id,
    cotoId: row.cotoId,
    cuentaBancariaId: row.cuentaBancariaId,
    proveedorId: row.proveedorId,
    categoria: row.categoria,
    concepto: row.concepto,
    monto: row.monto.toString(),
    fecha: row.fecha.toISOString().slice(0, 10),
    estado: row.estado as z.infer<typeof EstadoEgreso>,
    solicitadoPor: row.solicitadoPor,
    aprobadoPor: row.aprobadoPor,
    aprobadoEn: row.aprobadoEn?.toISOString() ?? null,
    rechazadoEn: row.rechazadoEn?.toISOString() ?? null,
    motivoRechazo: row.motivoRechazo,
    tieneFactura: row.tieneFactura,
    facturaUuid: row.facturaUuid,
    comprobanteUrl: row.comprobanteUrl,
    notas: row.notas,
  };
}

export async function generarUrlSubidaComprobanteEgreso(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof SolicitarUrlComprobanteEgreso>,
  storage: StorageService,
) {
  const [fila] = await tx.$queryRaw<{ org_id: string; ok: boolean }[]>`
    SELECT c.org_id, (${cotoId}::uuid = ANY (app.cotos_finanzas())) AS ok
      FROM cotos c
     WHERE c.id = ${cotoId}::uuid
     LIMIT 1
  `;
  if (!fila) throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  if (!fila.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo administración o tesorería puede subir comprobantes de egresos');
  }
  const llave = storage.llaveParaArchivo(fila.org_id, cotoId, 'egresos', datos.contentType);
  return storage.urlDeSubida({ llave, contentType: datos.contentType });
}

async function validarLlaveComprobanteEgreso(
  tx: Prisma.TransactionClient,
  cotoId: string,
  llaveCruda: string,
): Promise<string> {
  const llave = validarLlaveObjeto(llaveCruda);
  const coto = await tx.coto.findUnique({ where: { id: cotoId }, select: { orgId: true } });
  if (!coto) throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  const prefijo = `${coto.orgId.toLowerCase()}/${cotoId.toLowerCase()}/egresos/`;
  if (!llave.startsWith(prefijo)) {
    throw new AppError(
      422,
      'llave_invalida',
      'El comprobante debe ser una llave privada del módulo de egresos de este coto',
    );
  }
  return llave;
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  filtro: {
    estado?: z.infer<typeof EstadoEgreso> | undefined;
    categoria?: string | undefined;
    desde?: string | undefined;
    hasta?: string | undefined;
    limite: number;
    cursor?: string | undefined;
  },
): Promise<{ datos: z.infer<typeof EgresoDto>[]; siguiente?: string }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_staff())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'Solo el staff del coto puede consultar egresos');

  const fechaWhere: { gte?: Date; lte?: Date } = {};
  if (filtro.desde) fechaWhere.gte = new Date(`${filtro.desde}T00:00:00Z`);
  if (filtro.hasta) fechaWhere.lte = new Date(`${filtro.hasta}T00:00:00Z`);

  const filas = await tx.egreso.findMany({
    where: {
      cotoId,
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.categoria ? { categoria: filtro.categoria } : {}),
      ...(filtro.desde || filtro.hasta ? { fecha: fechaWhere } : {}),
    },
    orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    take: filtro.limite + 1,
    ...(filtro.cursor ? { cursor: { id: filtro.cursor }, skip: 1 } : {}),
    select: selectEgreso,
  });
  const siguiente = filas.length > filtro.limite ? filas.pop()?.id : undefined;
  return { datos: filas.map(aDto), ...(siguiente ? { siguiente } : {}) };
}

export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearEgreso>,
  idempotencyKey?: string,
): Promise<{ creado: boolean; dato: z.infer<typeof EgresoDto> }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_tesoreria())) AS ok`;
  if (!perm?.ok)
    throw new AppError(403, 'sin_permiso', 'Solo tesorería o administración con MFA puede solicitar egresos');

  const comprobanteUrl = datos.comprobanteUrl
    ? await validarLlaveComprobanteEgreso(tx, cotoId, datos.comprobanteUrl)
    : undefined;
  const clave = idempotencyKey ? `egreso:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.egreso.create({
        data: {
          cotoId,
          concepto: datos.concepto,
          monto: datos.monto,
          categoria: datos.categoria,
          tieneFactura: datos.tieneFactura,
          ...(datos.fecha ? { fecha: new Date(`${datos.fecha}T00:00:00Z`) } : {}),
          ...(datos.cuentaBancariaId ? { cuentaBancariaId: datos.cuentaBancariaId } : {}),
          ...(datos.proveedorId ? { proveedorId: datos.proveedorId } : {}),
          ...(datos.facturaUuid ? { facturaUuid: datos.facturaUuid } : {}),
          ...(comprobanteUrl ? { comprobanteUrl } : {}),
          ...(datos.notas ? { notas: datos.notas } : {}),
          ...(clave ? { claveIdempotencia: clave } : {}),
        },
        select: selectEgreso,
      }),
    () =>
      clave
        ? tx.egreso.findUnique({ where: { claveIdempotencia: clave }, select: selectEgreso })
        : Promise.resolve(null),
  );
  return { creado: res.creado, dato: aDto(res.dato) };
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  id: string,
  datos: z.infer<typeof ActualizarEgreso>,
): Promise<z.infer<typeof EgresoDto>> {
  const actual = await tx.egreso.findFirst({ where: { id, cotoId }, select: { id: true, estado: true } });
  if (!actual) throw new AppError(404, 'egreso_no_encontrado', 'Egreso no encontrado');

  if (datos.marcarPagado) {
    if (actual.estado !== 'aprobado') {
      throw new AppError(409, 'estado_invalido', 'Solo un egreso aprobado puede marcarse como pagado');
    }
    await tx.$executeRaw`SELECT app.marcar_egreso_pagado(${id}::uuid)`;
    const pagado = await tx.egreso.findUniqueOrThrow({ where: { id }, select: selectEgreso });
    return aDto(pagado);
  }

  if (actual.estado !== 'pendiente') {
    throw new AppError(409, 'estado_invalido', 'Solo se pueden editar egresos pendientes');
  }

  const data: Prisma.EgresoUpdateInput = {};
  if (datos.concepto !== undefined) data.concepto = datos.concepto;
  if (datos.categoria !== undefined) data.categoria = datos.categoria;
  if (datos.cuentaBancariaId !== undefined) {
    data.cuentaBancaria = datos.cuentaBancariaId ? { connect: { id: datos.cuentaBancariaId } } : { disconnect: true };
  }
  if (datos.proveedorId !== undefined) {
    data.proveedor = datos.proveedorId ? { connect: { id: datos.proveedorId } } : { disconnect: true };
  }
  if (datos.tieneFactura !== undefined) data.tieneFactura = datos.tieneFactura;
  if (datos.facturaUuid !== undefined) data.facturaUuid = datos.facturaUuid;
  if (datos.comprobanteUrl !== undefined) {
    data.comprobanteUrl = datos.comprobanteUrl
      ? await validarLlaveComprobanteEgreso(tx, cotoId, datos.comprobanteUrl)
      : null;
  }
  if (datos.notas !== undefined) data.notas = datos.notas;

  const row = await actualizarConRls(() => tx.egreso.update({ where: { id }, data, select: selectEgreso }));
  return aDto(row);
}

export async function aprobar(tx: Prisma.TransactionClient, id: string): Promise<z.infer<typeof EgresoDto>> {
  await tx.$executeRaw`SELECT app.aprobar_egreso(${id}::uuid)`;
  const row = await tx.egreso.findUnique({ where: { id }, select: selectEgreso });
  if (!row) throw new AppError(404, 'egreso_no_encontrado', 'Egreso no encontrado');
  return aDto(row);
}

export async function rechazar(
  tx: Prisma.TransactionClient,
  id: string,
  motivo?: string,
): Promise<z.infer<typeof EgresoDto>> {
  await tx.$executeRaw`SELECT app.rechazar_egreso(${id}::uuid, ${motivo ?? null})`;
  const row = await tx.egreso.findUnique({ where: { id }, select: selectEgreso });
  if (!row) throw new AppError(404, 'egreso_no_encontrado', 'Egreso no encontrado');
  return aDto(row);
}
