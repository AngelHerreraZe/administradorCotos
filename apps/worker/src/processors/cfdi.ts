import crypto from 'node:crypto';
import {
  buscarFacturaPorExternalId,
  type ClienteCfdiApi,
  cancelar,
  consultarEstadoCancelacion,
  crearClienteCfdi,
  descargarXmlPdf,
  esRechazoDefinitivoPac,
  obtenerApiKeyOrgPac,
  timbrar,
  validarDatosFiscales,
} from '@admcotos/cfdi';
import type { PrismaClient } from '@admcotos/db';
import { decryptField, encryptField, type Keyring } from '@admcotos/security';
import { Colas, type PayloadCfdi } from '@admcotos/shared';
import { type S3Client, subirObjeto } from '@admcotos/storage';
import { type ConnectionOptions, type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export type SubidorCfdi = (llave: string, bytes: Uint8Array, contentType: string) => Promise<string>;
export type FabricaClienteCfdiOrg = (orgApiKey: string, facturapiOrgId: string) => ClienteCfdiApi;
export type EncoladorVerificacionCfdi = (
  payload: Extract<PayloadCfdi, { accion: 'verificar_cancelacion' }>,
  opts?: { jobId?: string; delayMs?: number },
) => Promise<void>;

const FORMA_PAGO_SAT: Record<string, string> = {
  efectivo: '01',
  cheque: '02',
  spei: '03',
  transferencia_manual: '03',
  autopay_clabe: '03',
  tarjeta: '04',
  autopay_tarjeta: '04',
  oxxo: '01',
};

const POR_COTO_LOCK = new Map<string, Promise<unknown>>();
const LUA_LIBERAR_CANDADO = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

async function conLockLocal<T>(cotoId: string, fn: () => Promise<T>): Promise<T> {
  const previa = POR_COTO_LOCK.get(cotoId) ?? Promise.resolve();
  const tarea = previa.then(fn, fn);
  POR_COTO_LOCK.set(cotoId, tarea);
  try {
    return await tarea;
  } finally {
    if (POR_COTO_LOCK.get(cotoId) === tarea) {
      POR_COTO_LOCK.delete(cotoId);
    }
  }
}

async function conLockPorCoto<T>(cotoId: string, fn: () => Promise<T>, redis?: Redis): Promise<T> {
  if (!redis) {
    return conLockLocal(cotoId, fn);
  }
  const llave = `cfdi:lock:${cotoId}`;
  const token = crypto.randomUUID();
  let adquirido = false;
  for (let i = 0; i < 60; i += 1) {
    const ok = await redis.set(llave, token, 'PX', 30_000, 'NX');
    if (ok === 'OK') {
      adquirido = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!adquirido) {
    throw new Error(`No se pudo adquirir candado CFDI para coto ${cotoId}`);
  }
  try {
    return await conLockLocal(cotoId, fn);
  } finally {
    await redis.eval(LUA_LIBERAR_CANDADO, 1, llave, token).catch(() => 0);
  }
}

async function sincronizarLlaveOrg(params: {
  prisma: PrismaClient;
  cotoId: string;
  orgId: string;
  facturapiOrgId: string;
  keyring: Keyring;
  cfdiMaestro: ClienteCfdiApi;
  testMode: boolean;
}): Promise<Buffer> {
  const apiKey = await obtenerApiKeyOrgPac(params.facturapiOrgId, params.testMode, params.cfdiMaestro);
  const cifrada = encryptField(apiKey, params.orgId, `coto_secretos.facturapi_key:${params.cotoId}`, params.keyring);
  await params.prisma.$executeRaw`
    INSERT INTO coto_secretos (coto_id, facturapi_api_key_enc, updated_at)
    VALUES (${params.cotoId}::uuid, ${cifrada}, now())
    ON CONFLICT (coto_id) DO UPDATE
      SET facturapi_api_key_enc = EXCLUDED.facturapi_api_key_enc, updated_at = now()
  `;
  return cifrada;
}

async function resolverClienteOrg(params: {
  prisma: PrismaClient;
  cotoId: string;
  orgId: string;
  facturapiOrgId: string | null;
  keyring: Keyring;
  crearClientePorOrg: FabricaClienteCfdiOrg;
  cfdiMaestro?: ClienteCfdiApi;
  testMode?: boolean;
}): Promise<ClienteCfdiApi> {
  if (!params.facturapiOrgId) {
    throw new Error(`Coto ${params.cotoId} sin organización configurada en Facturapi`);
  }
  const [secreto] = await params.prisma.$queryRaw<{ facturapi_api_key_enc: Uint8Array | null }[]>`
    SELECT facturapi_api_key_enc FROM coto_secretos WHERE coto_id = ${params.cotoId}::uuid LIMIT 1
  `;
  let rawBuf: Buffer | null = secreto?.facturapi_api_key_enc ? Buffer.from(secreto.facturapi_api_key_enc) : null;
  if (!rawBuf) {
    if (!params.cfdiMaestro) {
      throw new Error(`Coto ${params.cotoId} sin llave Facturapi cifrada en coto_secretos`);
    }
    rawBuf = await sincronizarLlaveOrg({
      prisma: params.prisma,
      cotoId: params.cotoId,
      orgId: params.orgId,
      facturapiOrgId: params.facturapiOrgId,
      keyring: params.keyring,
      cfdiMaestro: params.cfdiMaestro,
      testMode: params.testMode ?? true,
    });
  }
  const apiKey = decryptField(
    rawBuf,
    params.orgId,
    `coto_secretos.facturapi_key:${params.cotoId}`,
    params.keyring,
  ).toString('utf8');
  return params.crearClientePorOrg(apiKey, params.facturapiOrgId);
}

/**
 * Procesa sincronización de llaves, timbrado, cancelación y verificación CFDI usando la organización Facturapi propia de cada coto:
 * 1. Crea fila `pendiente` con `claveIdempotencia` y reserva el timbre en la misma transacción, antes de llamar al PAC.
 * 2. Busca primero por `external_id` vigente en Facturapi si reintenta antes de emitir.
 * 3. Persiste `pacInvoiceId`/`uuidCfdi` apenas responde el PAC. Solo un rechazo 4xx marca `fallido` (y devuelve el timbre);
 *    un fallo transitorio deja la fila `pendiente` para que `encolarTimbrado` la reanude con la misma clave.
 */
export async function procesarJobCfdi(params: {
  prisma: PrismaClient;
  keyring: Keyring;
  cfdiMaestro?: ClienteCfdiApi;
  cfdiTestMode?: boolean;
  crearClientePorOrg?: FabricaClienteCfdiOrg;
  subir: SubidorCfdi;
  encolarVerificacion?: EncoladorVerificacionCfdi;
  log: Logger;
  redis?: Redis;
  payload: PayloadCfdi;
}): Promise<{
  accion: 'llave_sincronizada' | 'timbrado' | 'cancelado' | 'pendiente_cancelacion' | 'omitido';
  facturaId?: string;
  uuidCfdi?: string | null;
}> {
  const fabrica = params.crearClientePorOrg ?? ((apiKey) => crearClienteCfdi(apiKey));

  if (params.payload.accion === 'sincronizar_llave') {
    const { cotoId, facturapiOrgId } = params.payload;
    if (!params.cfdiMaestro) {
      throw new Error('Cliente Facturapi maestro no configurado para sincronizar llave de organización');
    }
    const coto = await params.prisma.coto.findUnique({ where: { id: cotoId }, select: { orgId: true } });
    if (!coto) throw new Error(`Coto ${cotoId} no encontrado`);
    await sincronizarLlaveOrg({
      prisma: params.prisma,
      cotoId,
      orgId: coto.orgId,
      facturapiOrgId,
      keyring: params.keyring,
      cfdiMaestro: params.cfdiMaestro,
      testMode: params.cfdiTestMode ?? true,
    });
    params.log.info({ cotoId }, 'llave Facturapi de organización sincronizada y cifrada');
    return { accion: 'llave_sincronizada' };
  }

  if (params.payload.accion === 'timbrar') {
    const { cotoId, pagoId, receptor, claveIdempotencia } = params.payload;
    return conLockPorCoto(
      cotoId,
      async () => {
        const coto = await params.prisma.coto.findUnique({
          where: { id: cotoId },
          select: {
            orgId: true,
            rfcCoto: true,
            razonSocialCoto: true,
            regimenFiscal: true,
            cpFiscal: true,
            facturapiOrgId: true,
          },
        });
        if (!coto) throw new Error(`Coto ${cotoId} no encontrado`);

        const clienteOrg = await resolverClienteOrg({
          prisma: params.prisma,
          cotoId,
          orgId: coto.orgId,
          facturapiOrgId: coto.facturapiOrgId,
          keyring: params.keyring,
          crearClientePorOrg: fabrica,
          ...(params.cfdiMaestro ? { cfdiMaestro: params.cfdiMaestro } : {}),
          ...(params.cfdiTestMode !== undefined ? { testMode: params.cfdiTestMode } : {}),
        });

        const pago = await params.prisma.pago.findFirst({
          where: { id: pagoId, cotoId },
          select: { id: true, estado: true, metodo: true, monto: true },
        });
        if (pago?.estado !== 'confirmado') {
          throw new Error(`Pago ${pagoId} no confirmado`);
        }

        const emisor = {
          rfc: (coto.rfcCoto ?? '').toUpperCase(),
          nombre: coto.razonSocialCoto ?? '',
          regimenFiscal: coto.regimenFiscal ?? '',
          cpFiscal: coto.cpFiscal ?? '',
        };
        validarDatosFiscales({ emisor, receptor });
        const formaPago = FORMA_PAGO_SAT[pago.metodo] ?? '03';

        // 1. Registrar intención 'pendiente'; nunca reutilizar filas canceladas ni fallidas (B3)
        const porClave = await params.prisma.facturaCfdi.findUnique({ where: { claveIdempotencia } });
        const esTerminal = (est: string | undefined) =>
          est === 'cancelado' || est === 'pendiente_cancelacion' || est === 'fallido';

        let factura =
          porClave && !esTerminal(porClave.estado)
            ? porClave
            : await params.prisma.facturaCfdi.findFirst({
                where: { pagoId, estado: { notIn: ['cancelado', 'pendiente_cancelacion', 'fallido'] } },
              });

        if (factura?.estado === 'timbrado') {
          return { accion: 'omitido', facturaId: factura.id, uuidCfdi: factura.uuidCfdi };
        }

        const claveEfectiva = factura?.claveIdempotencia
          ? factura.claveIdempotencia
          : porClave
            ? `${claveIdempotencia.slice(0, 88)}-${crypto.randomUUID().slice(0, 8)}`
            : claveIdempotencia;

        if (!factura) {
          // B1: el timbre se reserva junto con la fila; después de timbrar ya nada depende de él.
          factura = await params.prisma.$transaction(async (tx) => {
            const [reserva] = await tx.$queryRaw<{ id: string }[]>`
              SELECT app.consumir_timbre(${coto.orgId}::uuid) AS id
            `;
            return tx.facturaCfdi.create({
              data: {
                cotoId,
                pagoId,
                tipoComprobante: 'I',
                emisorRfc: emisor.rfc,
                emisorNombre: emisor.nombre,
                emisorRegimen: emisor.regimenFiscal,
                receptorRfc: receptor.rfc.toUpperCase(),
                receptorNombre: receptor.nombre,
                receptorRegimen: receptor.regimenFiscal,
                receptorCp: receptor.cpFiscal,
                receptorUsoCfdi: receptor.usoCfdi,
                moneda: 'MXN',
                metodoPago: 'PUE',
                formaPago,
                pacUtilizado: 'facturapi',
                subtotal: pago.monto.toString(),
                total: pago.monto.toString(),
                estado: 'pendiente',
                claveIdempotencia: claveEfectiva,
                paqueteTimbreId: reserva?.id ?? null,
              },
            });
          });
        }

        // 2. Recuperar o emitir en PAC (máximo 1 timbrado real por claveEfectiva); rechazo 4xx marca 'fallido'
        let pacInvoiceId = factura.pacInvoiceId;
        let uuidCfdi = factura.uuidCfdi;
        if (!pacInvoiceId) {
          let timbrado: Awaited<ReturnType<typeof timbrar>>;
          try {
            const previo = await buscarFacturaPorExternalId(claveEfectiva, clienteOrg);
            timbrado =
              previo ??
              (await timbrar(
                {
                  emisor,
                  receptor,
                  conceptos: [
                    {
                      descripcion: 'Cuota de mantenimiento condominal',
                      claveProdServ: '80131500',
                      claveUnidad: 'E48',
                      cantidad: 1,
                      valorUnitario: pago.monto.toString(),
                    },
                  ],
                  formaPago,
                  metodoPago: 'PUE',
                  idempotencyKey: claveEfectiva,
                },
                clienteOrg,
              ));
          } catch (err) {
            // M1: solo un rechazo definitivo (el PAC no timbró) cierra la fila; un fallo transitorio la deja
            // `pendiente` y reanudable con la misma clave, así que nunca se emite un segundo CFDI por un timeout.
            if (esRechazoDefinitivoPac(err)) {
              await params.prisma.$executeRaw`SELECT app.marcar_cfdi_fallido(${factura.id}::uuid)`;
              throw new UnrecoverableError(err instanceof Error ? err.message : 'Rechazo fiscal del PAC');
            }
            throw err;
          }

          pacInvoiceId = timbrado.pacInvoiceId;
          uuidCfdi = timbrado.uuidCfdi;

          factura = await params.prisma.facturaCfdi.update({
            where: { id: factura.id },
            data: {
              pacInvoiceId: timbrado.pacInvoiceId,
              uuidCfdi: timbrado.uuidCfdi,
              serie: timbrado.serie,
              folio: timbrado.folio,
              subtotal: timbrado.subtotal,
            },
          });
        }

        // 3. Respaldar XML/PDF en storage privado y marcar 'timbrado'.
        // M2: llaves deterministas por factura; un reintento sobrescribe el mismo objeto en vez de dejar huérfanos.
        let xmlLlave = factura.xmlUrl;
        let pdfLlave = factura.pdfUrl;
        if (!xmlLlave || !pdfLlave) {
          const base = `${coto.orgId.toLowerCase()}/${cotoId.toLowerCase()}/cfdi/${factura.id}`;
          const { xml, pdf } = await descargarXmlPdf(pacInvoiceId, clienteOrg);
          xmlLlave = await params.subir(`${base}.xml`, xml, 'application/xml');
          pdfLlave = await params.subir(`${base}.pdf`, pdf, 'application/pdf');
        }

        await params.prisma.facturaCfdi.update({
          where: { id: factura.id },
          data: { xmlUrl: xmlLlave, pdfUrl: pdfLlave, estado: 'timbrado' },
        });

        params.log.info({ cotoId, pagoId, facturaId: factura.id, uuid: uuidCfdi }, 'CFDI timbrado');
        return { accion: 'timbrado', facturaId: factura.id, uuidCfdi };
      },
      params.redis,
    );
  }

  if (params.payload.accion === 'verificar_cancelacion') {
    const { cotoId, facturaId, intento } = params.payload;
    return conLockPorCoto(
      cotoId,
      async () => {
        const coto = await params.prisma.coto.findUnique({
          where: { id: cotoId },
          select: { orgId: true, facturapiOrgId: true },
        });
        if (!coto) throw new Error(`Coto ${cotoId} no encontrado`);
        const factura = await params.prisma.facturaCfdi.findFirst({ where: { id: facturaId, cotoId } });
        if (factura?.estado !== 'pendiente_cancelacion' || !factura.pacInvoiceId) {
          return { accion: 'omitido', facturaId, uuidCfdi: factura?.uuidCfdi ?? null };
        }
        const clienteOrg = await resolverClienteOrg({
          prisma: params.prisma,
          cotoId,
          orgId: coto.orgId,
          facturapiOrgId: coto.facturapiOrgId,
          keyring: params.keyring,
          crearClientePorOrg: fabrica,
          ...(params.cfdiMaestro ? { cfdiMaestro: params.cfdiMaestro } : {}),
          ...(params.cfdiTestMode !== undefined ? { testMode: params.cfdiTestMode } : {}),
        });
        const est = await consultarEstadoCancelacion(factura.pacInvoiceId, clienteOrg);
        if (est.status === 'canceled' || est.cancellationStatus === 'accepted') {
          await params.prisma.facturaCfdi.update({
            where: { id: factura.id },
            data: { estado: 'cancelado', canceladoEn: new Date() },
          });
          return { accion: 'cancelado', facturaId: factura.id, uuidCfdi: factura.uuidCfdi };
        }
        if (
          est.cancellationStatus === 'rejected' ||
          est.cancellationStatus === 'expired' ||
          (est.status === 'valid' && est.cancellationStatus === 'none')
        ) {
          await params.prisma.facturaCfdi.update({
            where: { id: factura.id },
            data: { estado: 'timbrado', motivoCancelacion: null, sustitucionUuid: null },
          });
          return { accion: 'omitido', facturaId: factura.id, uuidCfdi: factura.uuidCfdi };
        }
        if (intento < 20 && params.encolarVerificacion) {
          const sig = intento + 1;
          await params.encolarVerificacion(
            { accion: 'verificar_cancelacion', cotoId, facturaId, intento: sig },
            { jobId: `cfdi-verif-${factura.id}-${sig}`, delayMs: 3_600_000 },
          );
        }
        return { accion: 'pendiente_cancelacion', facturaId: factura.id, uuidCfdi: factura.uuidCfdi };
      },
      params.redis,
    );
  }

  const { cotoId, facturaId, motivo, sustitucionUuid } = params.payload;
  return conLockPorCoto(
    cotoId,
    async () => {
      const coto = await params.prisma.coto.findUnique({
        where: { id: cotoId },
        select: { orgId: true, facturapiOrgId: true },
      });
      if (!coto) throw new Error(`Coto ${cotoId} no encontrado`);

      const factura = await params.prisma.facturaCfdi.findFirst({ where: { id: facturaId, cotoId } });
      if (!factura) throw new Error(`Factura ${facturaId} no encontrada`);
      if (factura.estado === 'cancelado') {
        return { accion: 'omitido', facturaId: factura.id, uuidCfdi: factura.uuidCfdi };
      }
      if (!factura.pacInvoiceId) {
        throw new Error(`Factura ${facturaId} sin pacInvoiceId`);
      }

      const clienteOrg = await resolverClienteOrg({
        prisma: params.prisma,
        cotoId,
        orgId: coto.orgId,
        facturapiOrgId: coto.facturapiOrgId,
        keyring: params.keyring,
        crearClientePorOrg: fabrica,
        ...(params.cfdiMaestro ? { cfdiMaestro: params.cfdiMaestro } : {}),
        ...(params.cfdiTestMode !== undefined ? { testMode: params.cfdiTestMode } : {}),
      });

      const res = await cancelar(
        {
          pacInvoiceId: factura.pacInvoiceId,
          motivo,
          ...(sustitucionUuid ? { sustitucionUuid } : {}),
        },
        clienteOrg,
      );

      const pendiente = res.cancellationStatus === 'pending' && res.status !== 'canceled';
      const nuevoEstado = pendiente ? 'pendiente_cancelacion' : 'cancelado';

      await params.prisma.facturaCfdi.update({
        where: { id: factura.id },
        data: {
          estado: nuevoEstado,
          motivoCancelacion: motivo,
          ...(sustitucionUuid ? { sustitucionUuid } : {}),
          ...(!pendiente ? { canceladoEn: new Date() } : {}),
        },
      });
      if (pendiente && params.encolarVerificacion) {
        await params.encolarVerificacion(
          { accion: 'verificar_cancelacion', cotoId, facturaId: factura.id, intento: 1 },
          { jobId: `cfdi-verif-${factura.id}-1`, delayMs: 3_600_000 },
        );
      }
      params.log.info({ cotoId, facturaId, motivo, estado: nuevoEstado }, 'CFDI cancelación procesada');
      return { accion: nuevoEstado, facturaId: factura.id, uuidCfdi: factura.uuidCfdi };
    },
    params.redis,
  );
}

export function procesadorCfdi(deps: {
  prisma: PrismaClient;
  keyring: Keyring;
  cfdiMaestro?: ClienteCfdiApi;
  cfdiTestMode?: boolean;
  crearClientePorOrg?: FabricaClienteCfdiOrg;
  s3: S3Client;
  bucket: string;
  subir?: SubidorCfdi;
  encolarVerificacion?: EncoladorVerificacionCfdi;
  redis?: Redis;
  log: Logger;
}) {
  const subir: SubidorCfdi =
    deps.subir ?? ((llave, bytes, contentType) => subirObjeto(deps.s3, deps.bucket, llave, bytes, contentType));

  return async (job: Pick<Job, 'id' | 'data'>) => {
    const payload = Colas.cfdi.parse(job.data);
    return procesarJobCfdi({
      prisma: deps.prisma,
      keyring: deps.keyring,
      ...(deps.cfdiMaestro ? { cfdiMaestro: deps.cfdiMaestro } : {}),
      ...(deps.cfdiTestMode !== undefined ? { cfdiTestMode: deps.cfdiTestMode } : {}),
      ...(deps.crearClientePorOrg ? { crearClientePorOrg: deps.crearClientePorOrg } : {}),
      ...(deps.encolarVerificacion ? { encolarVerificacion: deps.encolarVerificacion } : {}),
      ...(deps.redis ? { redis: deps.redis } : {}),
      subir,
      log: deps.log,
      payload,
    });
  };
}

export function iniciarCfdi(opts: {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  redis?: Redis;
  cfdiMaestro?: ClienteCfdiApi;
  cfdiTestMode?: boolean;
  keyring: Keyring;
  crearClientePorOrg?: FabricaClienteCfdiOrg;
  s3: S3Client;
  bucket: string;
  log: Logger;
}) {
  const queue = new Queue('cfdi', { connection: opts.connection });
  const encolarVerificacion: EncoladorVerificacionCfdi = async (payload, jobOpts) => {
    await queue.add('cfdi', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
      ...(jobOpts?.delayMs ? { delay: jobOpts.delayMs } : {}),
      ...(jobOpts?.jobId ? { jobId: jobOpts.jobId } : {}),
    });
  };
  const worker = new Worker('cfdi', procesadorCfdi({ ...opts, encolarVerificacion }), {
    connection: opts.connection,
    concurrency: 2,
  });
  worker.on('failed', (job, err) => opts.log.error({ err, jobId: job?.id }, 'cfdi: job fallido'));
  return { queue, worker };
}
