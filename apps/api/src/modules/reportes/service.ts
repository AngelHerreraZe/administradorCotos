import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import type { FilaBalanceDto, FilaMorosidadDto, ResumenCotoDto } from './schemas.ts';

interface FilaResumenSql {
  coto_id: string;
  coto: string;
  unidades: number;
  emitido_mes: { toString(): string };
  cobrado_mes: { toString(): string };
  pct_cobrado: { toString(): string } | null;
  adeudo_vencido: { toString(): string };
  unidades_morosas: number;
  pagos_por_revisar: number;
  tickets_abiertos: number;
}

interface FilaMorosidadSql {
  unidad_id: string;
  unidad: string;
  adeudo: { toString(): string };
  cargos_vencidos: number;
  vencido_desde: Date | string;
  meses_atraso: number;
}

interface FilaBalanceSql {
  mes: Date | string;
  ingresos: { toString(): string };
  egresos: { toString(): string };
  neto: { toString(): string };
}

function formatearFecha(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export async function resumen(tx: Prisma.TransactionClient, cotoId: string): Promise<z.infer<typeof ResumenCotoDto>> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_staff())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo el staff del coto puede consultar el resumen');
  }

  const [fila] = await tx.$queryRaw<FilaResumenSql[]>`
    SELECT coto_id, coto, unidades, emitido_mes, cobrado_mes, pct_cobrado,
           adeudo_vencido, unidades_morosas, pagos_por_revisar, tickets_abiertos
      FROM app.resumen_cotos(ARRAY[${cotoId}]::uuid[], NULL)
  `;
  if (!fila) {
    throw new AppError(404, 'coto_no_encontrado', 'Coto no encontrado');
  }

  return {
    cotoId: fila.coto_id,
    coto: fila.coto,
    unidades: fila.unidades,
    emitidoMes: fila.emitido_mes.toString(),
    cobradoMes: fila.cobrado_mes.toString(),
    pctCobrado: fila.pct_cobrado?.toString() ?? null,
    adeudoVencido: fila.adeudo_vencido.toString(),
    unidadesMorosas: fila.unidades_morosas,
    pagosPorRevisar: fila.pagos_por_revisar,
    ticketsAbiertos: fila.tickets_abiertos,
  };
}

export async function morosidad(
  tx: Prisma.TransactionClient,
  cotoId: string,
): Promise<{ datos: z.infer<typeof FilaMorosidadDto>[] }> {
  // Nunca a comité ni residentes (LFPDPPP).
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_finanzas())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo administración y tesorería pueden consultar la morosidad por unidad');
  }

  const filas = await tx.$queryRaw<FilaMorosidadSql[]>`
    SELECT unidad_id, unidad, adeudo, cargos_vencidos, vencido_desde, meses_atraso
      FROM app.morosidad(${cotoId}::uuid)
  `;

  return {
    datos: filas.map((f) => ({
      unidadId: f.unidad_id,
      unidad: f.unidad,
      adeudo: f.adeudo.toString(),
      cargosVencidos: f.cargos_vencidos,
      vencidoDesde: formatearFecha(f.vencido_desde),
      mesesAtraso: f.meses_atraso,
    })),
  };
}

export async function balance(
  tx: Prisma.TransactionClient,
  cotoId: string,
  meses: number,
): Promise<{ datos: z.infer<typeof FilaBalanceDto>[] }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${cotoId}::uuid = ANY (app.cotos_staff())) AS ok`;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'Solo el staff del coto puede consultar el balance mensual');
  }

  const filas = await tx.$queryRaw<FilaBalanceSql[]>`
    SELECT mes, ingresos, egresos, neto
      FROM app.balance_mensual(${cotoId}::uuid, ${meses}::int)
  `;

  return {
    datos: filas.map((f) => ({
      mes: formatearFecha(f.mes),
      ingresos: f.ingresos.toString(),
      egresos: f.egresos.toString(),
      neto: f.neto.toString(),
    })),
  };
}
