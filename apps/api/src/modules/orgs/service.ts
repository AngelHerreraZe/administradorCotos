import type { Prisma } from '@admcotos/db';
import { AppError } from '@admcotos/shared';
import type { z } from '@hono/zod-openapi';
import { actualizarConRls } from '../../lib/prisma.ts';
import { aDto as cotoADto, selectCoto } from '../cotos/service.ts';
import type {
  ActualizarOrganizacion,
  CotoResumen,
  CrearCoto,
  CrearSoporte,
  Organizacion,
  SoporteAccesoDto,
} from './schemas.ts';

const selectOrg = {
  id: true,
  nombre: true,
  slug: true,
  rfc: true,
  razonSocial: true,
  emailContacto: true,
  telefono: true,
  customDomain: true,
  logoUrl: true,
  colorPrimario: true,
  colorSecundario: true,
  faviconUrl: true,
  tierMayoreo: true,
  estadoSuscripcion: true,
  exigirMfa: true,
  avisoPrivacidadUrl: true,
  avisoVersion: true,
  activo: true,
} as const;

interface FilaResumenCoto {
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

export async function obtener(tx: Prisma.TransactionClient, orgId: string): Promise<z.infer<typeof Organizacion>> {
  const org = await tx.organizacion.findUnique({ where: { id: orgId }, select: selectOrg });
  if (!org) throw new AppError(404, 'org_no_encontrada', 'Organización no encontrada');
  return org;
}

export async function actualizar(
  tx: Prisma.TransactionClient,
  orgId: string,
  datos: z.infer<typeof ActualizarOrganizacion>,
): Promise<z.infer<typeof Organizacion>> {
  await obtener(tx, orgId);
  return actualizarConRls(() =>
    tx.organizacion.update({
      where: { id: orgId },
      data: datos,
      select: selectOrg,
    }),
  );
}

export async function listarCotos(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<{ datos: z.infer<typeof CotoResumen>[] }> {
  const [perm] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (${orgId}::uuid = ANY (app.orgs_lectura())) AS ok`;
  if (!perm?.ok) throw new AppError(403, 'sin_permiso', 'No tienes permiso para ver los cotos de esta organización');

  const cotos = await tx.coto.findMany({
    where: { orgId, activo: true },
    orderBy: [{ nombre: 'asc' }, { id: 'asc' }],
    select: { id: true, nombre: true, slug: true, tipo: true, zonaHoraria: true, activo: true },
  });
  const resumenes = await tx.$queryRaw<FilaResumenCoto[]>`SELECT * FROM app.resumen_cotos(p_org => ${orgId}::uuid)`;
  const mapa = new Map(resumenes.map((r) => [r.coto_id, r]));

  return {
    datos: cotos.map((c) => {
      const r = mapa.get(c.id);
      return {
        cotoId: c.id,
        coto: c.nombre,
        slug: c.slug,
        tipo: c.tipo,
        zonaHoraria: c.zonaHoraria,
        activo: c.activo,
        unidades: r?.unidades ?? 0,
        emitidoMes: r?.emitido_mes.toString() ?? '0.00',
        cobradoMes: r?.cobrado_mes.toString() ?? '0.00',
        pctCobrado: r?.pct_cobrado?.toString() ?? null,
        adeudoVencido: r?.adeudo_vencido.toString() ?? '0.00',
        unidadesMorosas: r?.unidades_morosas ?? 0,
        pagosPorRevisar: r?.pagos_por_revisar ?? 0,
        ticketsAbiertos: r?.tickets_abiertos ?? 0,
      };
    }),
  };
}

export async function crearCoto(tx: Prisma.TransactionClient, orgId: string, datos: z.infer<typeof CrearCoto>) {
  const coto = await tx.coto.create({
    data: { orgId, ...datos },
    select: selectCoto,
  });
  return cotoADto(coto);
}

export async function abrirSoporte(
  tx: Prisma.TransactionClient,
  orgId: string,
  usuarioId: string,
  datos: z.infer<typeof CrearSoporte>,
): Promise<z.infer<typeof SoporteAccesoDto>> {
  const desde = new Date();
  const hasta = new Date(desde.getTime() + datos.duracionHoras * 3_600_000);
  const s = await tx.soporteAcceso.create({
    data: {
      orgId,
      otorgadoPor: usuarioId,
      ticketRef: datos.ticketRef,
      desde,
      hasta,
    },
    select: { id: true, orgId: true, otorgadoPor: true, ticketRef: true, desde: true, hasta: true },
  });
  return {
    id: s.id,
    orgId: s.orgId,
    otorgadoPor: s.otorgadoPor,
    ticketRef: s.ticketRef,
    desde: s.desde.toISOString(),
    hasta: s.hasta.toISOString(),
  };
}
