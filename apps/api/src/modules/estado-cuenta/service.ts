import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import PDFDocument from 'pdfkit';
import type { EstadoCuentaDto } from './schemas.ts';

interface FilaUnidad {
  id: string;
  coto_id: string;
  numero: string;
  saldo_a_favor: { toString(): string };
  coto_nombre: string;
}

interface FilaEstadoCuenta {
  cargo_id: string;
  concepto: string;
  periodo: string;
  vence: Date | string;
  saldo: { toString(): string };
  vencido: boolean;
  total_pendiente: { toString(): string } | null;
}

function formatearFecha(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export async function obtener(
  tx: Prisma.TransactionClient,
  unidadId: string,
): Promise<z.infer<typeof EstadoCuentaDto>> {
  const [unidad] = await tx.$queryRaw<FilaUnidad[]>`
    SELECT u.id, u.coto_id, u.numero, u.saldo_a_favor, c.nombre AS coto_nombre
      FROM unidades u
      JOIN cotos c ON c.id = u.coto_id
     WHERE u.id = ${unidadId}::uuid
     LIMIT 1
  `;
  if (!unidad) {
    throw new AppError(404, 'unidad_no_encontrada', 'Unidad no encontrada');
  }

  // Comité, inquilinos y guardias nunca acceden al estado de cuenta (LFPDPPP).
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (${unidad.coto_id}::uuid = ANY (app.cotos_finanzas()) OR ${unidadId}::uuid = ANY (app.unidades_propias())) AS ok
  `;
  if (!perm?.ok) {
    throw new AppError(403, 'sin_permiso', 'No tienes permiso para consultar este estado de cuenta');
  }

  const filas = await tx.$queryRaw<FilaEstadoCuenta[]>`
    SELECT cargo_id, concepto, periodo, vence, saldo, vencido, total_pendiente
      FROM app.estado_cuenta(${unidadId}::uuid)
  `;

  return {
    unidadId: unidad.id,
    unidad: unidad.numero,
    cotoId: unidad.coto_id,
    coto: unidad.coto_nombre,
    saldoAFavor: unidad.saldo_a_favor.toString(),
    totalPendiente: filas[0]?.total_pendiente?.toString() ?? '0.00',
    cargos: filas.map((f) => ({
      cargoId: f.cargo_id,
      concepto: f.concepto,
      periodo: f.periodo,
      vence: formatearFecha(f.vence),
      saldo: f.saldo.toString(),
      vencido: f.vencido,
    })),
  };
}

const MAX_FILAS_PDF = 38;

/** Genera un PDF compacto de máximo 2 páginas en memoria sin recursos externos. */
export async function renderizarPdf(estado: z.infer<typeof EstadoCuentaDto>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 44, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const emitidaEn = new Date().toISOString().slice(0, 10);
    doc.fontSize(16).text(`Estado de cuenta · ${estado.coto}`);
    doc.moveDown(0.4);
    doc.fontSize(10).text(`Unidad: ${estado.unidad}   |   Fecha de emisión: ${emitidaEn}`);
    doc.text(`Total pendiente: $${estado.totalPendiente} MXN   |   Saldo a favor: $${estado.saldoAFavor} MXN`);
    doc.moveDown(0.8);

    if (estado.cargos.length === 0) {
      doc.fontSize(11).text('Tu unidad se encuentra al corriente, sin cargos pendientes.');
      doc.end();
      return;
    }

    doc.fontSize(10).text('Periodo   | Vencimiento | Estado    | Saldo      | Concepto');
    doc
      .moveTo(44, doc.y + 2)
      .lineTo(568, doc.y + 2)
      .stroke();
    doc.moveDown(0.4);

    let paginas = 1;
    const visibles = estado.cargos.slice(0, MAX_FILAS_PDF);
    for (const cargo of visibles) {
      if (doc.y > 700 && paginas < 2) {
        doc.addPage();
        paginas += 1;
        doc.fontSize(10).text('Periodo   | Vencimiento | Estado    | Saldo      | Concepto');
        doc.moveDown(0.3);
      }
      const etiquetaEstado = cargo.vencido ? 'Vencido  ' : 'Vigente  ';
      const saldoCol = `$${cargo.saldo}`.padEnd(10, ' ');
      doc
        .fontSize(9.5)
        .text(`${cargo.periodo}   | ${cargo.vence}  | ${etiquetaEstado} | ${saldoCol} | ${cargo.concepto}`);
    }

    const omitidos = estado.cargos.length - visibles.length;
    if (omitidos > 0) {
      doc.moveDown(0.6);
      doc.fontSize(9).text(`... y ${omitidos} cargo(s) adicionales incluidos en el total pendiente.`);
    }

    doc.end();
  });
}
