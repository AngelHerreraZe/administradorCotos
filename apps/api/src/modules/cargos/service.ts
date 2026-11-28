import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { conIdempotencia } from '../../lib/prisma.ts';
import type { CargoDto, CondonarCargo, CrearCargo, EstadoCargo, GenerarCargos } from './schemas.ts';

const selectCargo = {
  id: true,
  cotoId: true,
  unidadId: true,
  conceptoId: true,
  periodo: true,
  montoOriginal: true,
  montoMoratoria: true,
  montoDescuento: true,
  saldoPendiente: true,
  estado: true,
  fechaEmision: true,
  fechaVencimiento: true,
  notas: true,
} as const;

function aDto(row: Prisma.CargoGetPayload<{ select: typeof selectCargo }>): z.infer<typeof CargoDto> {
  return {
    id: row.id,
    cotoId: row.cotoId,
    unidadId: row.unidadId,
    conceptoId: row.conceptoId,
    periodo: row.periodo,
    montoOriginal: row.montoOriginal.toString(),
    montoMoratoria: row.montoMoratoria.toString(),
    montoDescuento: row.montoDescuento.toString(),
    saldoPendiente: row.saldoPendiente.toString(),
    estado: row.estado as z.infer<typeof EstadoCargo>,
    fechaEmision: row.fechaEmision.toISOString().slice(0, 10),
    fechaVencimiento: row.fechaVencimiento.toISOString().slice(0, 10),
    notas: row.notas,
  };
}

export async function generar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  datos: z.infer<typeof GenerarCargos>,
): Promise<{ creados: number }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede generar cargos');
  }

  const [res] = await tx.$queryRaw<{ creados: number }[]>`
    SELECT app.generar_cargos(
      ${cotoId}::uuid,
      ${datos.conceptoId}::uuid,
      ${datos.periodo},
      ${datos.monto ?? null}::numeric,
      ${datos.fechaVencimiento ?? null}::date
    ) AS creados
  `;
  return { creados: res?.creados ?? 0 };
}

export async function crear(
  tx: Prisma.TransactionClient,
  cotoId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearCargo>,
  idempotencyKey?: string,
): Promise<{ creado: boolean; dato: z.infer<typeof CargoDto> }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_admin())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo la administración con MFA activo puede crear cargos');
  }

  const clave = idempotencyKey ? `cargo:${usuarioId}:${idempotencyKey}` : undefined;
  const res = await conIdempotencia(
    tx,
    clave,
    () =>
      tx.cargo.create({
        data: {
          cotoId,
          unidadId: datos.unidadId,
          conceptoId: datos.conceptoId,
          periodo: datos.periodo,
          montoOriginal: datos.montoOriginal,
          saldoPendiente: datos.montoOriginal,
          fechaVencimiento: new Date(`${datos.fechaVencimiento}T00:00:00Z`),
          ...(clave ? { claveIdempotencia: clave } : {}),
          ...(datos.notas ? { notas: datos.notas } : {}),
        },
        select: selectCargo,
      }),
    () =>
      clave ? tx.cargo.findUnique({ where: { claveIdempotencia: clave }, select: selectCargo }) : Promise.resolve(null),
  );
  return { creado: res.creado, dato: aDto(res.dato) };
}

export async function listar(
  tx: Prisma.TransactionClient,
  cotoId: string,
  filtro: {
    periodo?: string | undefined;
    estado?: z.infer<typeof EstadoCargo> | undefined;
    unidadId?: string | undefined;
    limite: number;
    cursor?: string | undefined;
  },
): Promise<{ datos: z.infer<typeof CargoDto>[]; siguiente?: string }> {
  // Comité, inquilinos y guardias NUNCA pueden leer cargos ni adeudos por unidad (LFPDPPP).
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
    throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar cargos de este coto');
  }

  const filas = await tx.cargo.findMany({
    where: {
      cotoId,
      ...(filtro.periodo ? { periodo: filtro.periodo } : {}),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.unidadId ? { unidadId: filtro.unidadId } : {}),
    },
    orderBy: [{ fechaVencimiento: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    take: filtro.limite + 1,
    ...(filtro.cursor ? { cursor: { id: filtro.cursor }, skip: 1 } : {}),
    select: selectCargo,
  });
  const siguiente = filas.length > filtro.limite ? filas.pop()?.id : undefined;
  return {
    datos: filas.map(aDto),
    ...(siguiente ? { siguiente } : {}),
  };
}

export async function condonar(
  tx: Prisma.TransactionClient,
  cargoId: string,
  datos: z.infer<typeof CondonarCargo>,
): Promise<z.infer<typeof CargoDto>> {
  await tx.$executeRaw`SELECT app.condonar_cargo(${cargoId}::uuid, ${datos.motivo})`;
  const cargo = await tx.cargo.findUnique({ where: { id: cargoId }, select: selectCargo });
  if (!cargo) throw new AppError(404, 'cargo_no_encontrado', 'Cargo no encontrado');
  return aDto(cargo);
}
