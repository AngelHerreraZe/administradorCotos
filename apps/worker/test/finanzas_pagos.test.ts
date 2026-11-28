import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ClienteCfdiApi } from '@admcotos/cfdi';
import type { PrismaClient } from '@admcotos/db';
import type { ClienteConektaApi } from '@admcotos/payments';
import { keyringFromEnv } from '@admcotos/security';
import { Job, UnrecoverableError } from 'bullmq';
import { pino } from 'pino';
import type Stripe from 'stripe';
import { describe, expect, test } from 'vitest';
import { cobrarIntentoAutopay, programarCobrosAutopay } from '../src/processors/autopay.ts';
import { procesarWebhookStripe, reportarCensoMensualStripe, revisarMoraDespachos } from '../src/processors/billing.ts';
import { procesarJobCfdi } from '../src/processors/cfdi.ts';
import { ejecutarGenerarMensual, ejecutarMoratoriosDiario } from '../src/processors/finanzas.ts';
import { procesarEventoConekta } from '../src/processors/pagos-webhook.ts';

const log = pino({ level: 'silent' });
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const COTO_ID = '22222222-2222-4222-8222-222222222222';
const COTO_2_ID = '22222222-2222-4222-8222-222222222223';
const UNIDAD_ID = '33333333-3333-4333-8333-333333333333';
const CONCEPTO_ID = '44444444-4444-4444-8444-444444444444';
const CARGO_ID = '55555555-5555-4555-8555-555555555555';
const PAGO_ID = '66666666-6666-4666-8666-666666666666';
const EVENTO_ID = '77777777-7777-4777-8777-777777777777';
const AUTOPAY_ID = '88888888-8888-4888-8888-888888888888';
const INTENTO_ID = '99999999-9999-4999-8999-999999999999';
const FACTURA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAQUETE_TIMBRES_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEYRING = keyringFromEnv(`1:${crypto.randomBytes(32).toString('base64')}`);

function assertBullMqJobIdValido(jobId: string | undefined) {
  expect(jobId).toBeTruthy();
  (Job.prototype as unknown as { validateOptions(d: { data: string }): void }).validateOptions.call(
    { name: 'test', opts: { jobId } },
    { data: '{}' },
  );
}

describe('Worker Fase 2 y 3: finanzas, pagosWebhook, autopay, cfdi y billing', () => {
  test('finanzas (M6): error en un coto no detiene generación ni saldo a favor de otros cotos', async () => {
    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray, p1?: unknown) => {
        const sql = strings.join(' ');
        if (sql.includes('conceptos_cargo cc')) {
          return [
            { coto_id: COTO_ID, periodo: '2026-11', concepto_id: CONCEPTO_ID },
            { coto_id: COTO_2_ID, periodo: '2026-11', concepto_id: CONCEPTO_ID },
          ];
        }
        if (sql.includes('app.generar_cargos')) {
          if (p1 === COTO_ID) throw new Error('Hay unidades activas sin indiviso');
          return [{ creados: 50 }];
        }
        if (sql.includes('saldo_a_favor > 0')) return [{ id: UNIDAD_ID }];
        if (sql.includes('app.aplicar_saldo_a_favor')) return [{ aplicado: { toString: () => '300.00' } }];
        if (sql.includes('tipo_moratoria')) return [{ coto_id: COTO_2_ID, fecha_local: '2026-11-15' }];
        if (sql.includes('app.aplicar_moratorios')) return [{ n: 3 }];
        return [];
      },
    } as unknown as PrismaClient;

    const gen = await ejecutarGenerarMensual(prisma, log);
    expect(gen).toEqual({ cotosProcesados: 2, cargosCreados: 50, saldosAplicados: 1, errores: 1 });

    const mor = await ejecutarMoratoriosDiario(prisma, log);
    expect(mor).toEqual({ cotosProcesados: 1, cargosAfectados: 3, errores: 0 });
  });

  test('pagosWebhook: B4 evento paid sin pago falla y no marca procesadoEn; B5 order.declined avanza Auto-Pay y suspende', async () => {
    let intentoIncrementado = false;
    let procesadoEnSinPago: Date | null = null;
    const prismaSinPago = {
      webhookEvent: {
        findUnique: async () => ({
          id: EVENTO_ID,
          proveedor: 'conekta',
          tipo: 'order.paid',
          procesadoEn: null,
          payload: { type: 'order.paid', data: { object: { id: 'ord_perdida' } } },
        }),
        update: async (args: { data: { intentos?: unknown; procesadoEn?: Date } }) => {
          if (args.data.intentos) intentoIncrementado = true;
          if (args.data.procesadoEn) procesadoEnSinPago = args.data.procesadoEn;
          return {};
        },
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          pago: { findFirst: async () => null, findUnique: async () => null },
          webhookEvent: { update: async () => ({}) },
        }),
    } as unknown as PrismaClient;

    await expect(procesarEventoConekta(prismaSinPago, log, EVENTO_ID)).rejects.toThrow(/Pago no encontrado/);
    expect(intentoIncrementado).toBe(true);
    expect(procesadoEnSinPago).toBeNull();

    // B5 asíncrono: order.declined en intento #3 suspende autopay_config y encola avisos
    let autopayUpdate: unknown;
    const avisos: unknown[] = [];
    const prismaDecline = {
      webhookEvent: {
        findUnique: async () => ({
          id: EVENTO_ID,
          proveedor: 'conekta',
          tipo: 'order.declined',
          procesadoEn: null,
          payload: {
            type: 'order.declined',
            data: {
              object: { id: 'ord_ap_3', failure_code: 'card_declined', failure_message: 'Fondos insuficientes' },
            },
          },
        }),
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          pago: { findFirst: async () => ({ id: PAGO_ID, estado: 'pendiente' }) },
          $executeRaw: async () => 1,
          autopayIntento: {
            findFirst: async () => ({
              id: INTENTO_ID,
              autopay: {
                id: AUTOPAY_ID,
                cotoId: COTO_ID,
                unidadId: UNIDAD_ID,
                intentosFallidos: 2,
                maxReintentos: 3,
                diasEntreReintentos: [3, 7, 14],
              },
              coto: { nombre: 'Miraflores' },
            }),
            updateMany: async () => ({ count: 1 }),
          },
          autopayConfig: {
            update: async (args: { data: unknown }) => {
              autopayUpdate = args.data;
              return {};
            },
          },
          webhookEvent: { update: async () => ({}) },
        }),
      $queryRaw: async () => [{ email: 'prop@coto.mx' }, { email: 'admin@coto.mx' }],
    } as unknown as PrismaClient;

    await procesarEventoConekta(prismaDecline, log, EVENTO_ID, async (c, o) => {
      assertBullMqJobIdValido(o?.jobId);
      avisos.push(c);
    });
    expect(autopayUpdate).toMatchObject({ intentosFallidos: 3, activo: false, estado: 'suspendido_por_fallos' });
    expect(avisos).toHaveLength(2);
  });

  test('autopay (B1, B4, B5): jobId válido en BullMQ, timeout día 1 reintenta día 2 con mismo Idempotency-Key y 3er rechazo 402 suspende', async () => {
    expect(() => assertBullMqJobIdValido('recibo:123')).toThrow(/Custom Id cannot contain/);

    const encolados: { jobId?: string }[] = [];
    const prismaProg = {
      autopayConfig: {
        findMany: async () => [
          { id: AUTOPAY_ID, cotoId: COTO_ID, unidadId: UNIDAD_ID, diaCobro: 5, intentosFallidos: 0 },
        ],
      },
      $queryRaw: async () => [{ total: { toString: () => '1200.00' }, primer_cargo: CARGO_ID }],
      autopayIntento: {
        findUnique: async () => null,
        create: async () => ({ id: INTENTO_ID, estado: 'pendiente' }),
      },
    } as unknown as PrismaClient;

    await programarCobrosAutopay(
      prismaProg,
      async (_p, o) => {
        assertBullMqJobIdValido(o?.jobId);
        if (o?.jobId) encolados.push({ jobId: o.jobId });
      },
      log,
      new Date('2026-11-05T12:00:00Z'),
    );
    expect(encolados[0]?.jobId).toBe(`autopay-${INTENTO_ID}-2026-11-05`);

    // B4: día 1 falla por timeout en Conekta (permanece pendiente) -> día 2 reprograma nuevo jobId y cobra UNA vez con la misma Idempotency-Key
    let cobrosConektaDia = 0;
    const keysConekta: (string | undefined)[] = [];
    let intentoEstado = 'pendiente';
    let pagoCreado: Record<string, unknown> | null = null;
    const prismaB4 = {
      autopayConfig: {
        findMany: async () => [
          { id: AUTOPAY_ID, cotoId: COTO_ID, unidadId: UNIDAD_ID, diaCobro: 5, intentosFallidos: 0 },
        ],
        update: async () => ({}),
      },
      $queryRaw: async () => [{ total: { toString: () => '1200.00' }, primer_cargo: CARGO_ID }],
      autopayIntento: {
        findUnique: async () => ({
          id: INTENTO_ID,
          autopayId: AUTOPAY_ID,
          cotoId: COTO_ID,
          cargoId: CARGO_ID,
          intentoNum: 1,
          montoCentavos: 120000,
          claveIdempotencia: `autopay:${AUTOPAY_ID}:${CARGO_ID}:1`,
          estado: intentoEstado,
          coto: { nombre: 'Miraflores' },
          autopay: {
            unidadId: UNIDAD_ID,
            diaCobro: 5,
            intentosFallidos: 0,
            maxReintentos: 3,
            diasEntreReintentos: [3, 7, 14],
            paymentMethod: { activo: true, tipo: 'card', gatewayCustomerId: 'cus_1', gatewaySourceId: 'src_1' },
          },
        }),
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: async () => 1,
          pago: {
            findUnique: async () => pagoCreado,
            create: async () => {
              pagoCreado = { id: PAGO_ID, estado: 'pendiente', aplicadoEn: null, gatewayOrderId: null };
              return pagoCreado;
            },
            findUniqueOrThrow: async () => pagoCreado,
            update: async (args: { data: Record<string, unknown> }) => {
              pagoCreado = { ...pagoCreado, ...args.data };
              return pagoCreado;
            },
          },
          autopayIntento: {
            update: async (args: { data: { estado?: string } }) => {
              if (args.data.estado) intentoEstado = args.data.estado;
              return {};
            },
          },
          autopayConfig: { update: async () => ({}) },
        }),
    } as unknown as PrismaClient;

    let fallarTimeout = true;
    const conektaFlaky = {
      orders: {
        createOrder: async (_r: unknown, _a: unknown, _b: unknown, key?: string) => {
          keysConekta.push(key);
          if (fallarTimeout) throw new Error('ETIMEDOUT');
          cobrosConektaDia += 1;
          return {
            data: { id: 'ord_retry_ok', livemode: false, payment_status: 'paid', charges: { data: [{ id: 'chg_r' }] } },
          };
        },
      },
    } as unknown as ClienteConektaApi;

    await expect(
      cobrarIntentoAutopay({ prisma: prismaB4, conekta: conektaFlaky, log, intentoId: INTENTO_ID }),
    ).rejects.toThrow(/ETIMEDOUT/);
    expect(intentoEstado).toBe('pendiente');

    const encoladosDia2: string[] = [];
    await programarCobrosAutopay(
      prismaB4,
      async (_p, o) => {
        assertBullMqJobIdValido(o?.jobId);
        if (o?.jobId) encoladosDia2.push(o.jobId);
      },
      log,
      new Date('2026-11-06T12:00:00Z'),
    );
    expect(encoladosDia2).toEqual([`autopay-${INTENTO_ID}-2026-11-06`]);

    fallarTimeout = false;
    const resRetryOk = await cobrarIntentoAutopay({
      prisma: prismaB4,
      conekta: conektaFlaky,
      log,
      intentoId: INTENTO_ID,
    });
    expect(resRetryOk).toEqual({ estado: 'exitoso' });
    expect(cobrosConektaDia).toBe(1);
    expect(keysConekta[0]).toBe(keysConekta[1]);

    // Caso 1: timeout de BD después de cobro exitoso -> relanza error sin marcar 'fallido' ni incrementar intentosFallidos
    let fallosMarcados = 0;
    const prismaDbErrorPostCobro = {
      autopayIntento: {
        findUnique: async () => ({
          id: INTENTO_ID,
          autopayId: AUTOPAY_ID,
          cotoId: COTO_ID,
          cargoId: CARGO_ID,
          intentoNum: 1,
          montoCentavos: 120000,
          claveIdempotencia: `autopay:${AUTOPAY_ID}:${CARGO_ID}:1`,
          estado: 'pendiente',
          coto: { nombre: 'Miraflores' },
          autopay: {
            unidadId: UNIDAD_ID,
            diaCobro: 5,
            intentosFallidos: 0,
            maxReintentos: 3,
            diasEntreReintentos: [3, 7, 14],
            paymentMethod: { activo: true, tipo: 'card', gatewayCustomerId: 'cus_1', gatewaySourceId: 'src_1' },
          },
        }),
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          pago: {
            findUnique: async () => null,
            create: async () => ({ id: PAGO_ID, estado: 'pendiente', aplicadoEn: null }),
            findUniqueOrThrow: async () => {
              throw new Error('ECONNRESET postgres post-cobro');
            },
          },
          autopayIntento: {
            update: async (args: { data: { estado?: string } }) => {
              if (args.data.estado === 'fallido') fallosMarcados += 1;
              return {};
            },
          },
        }),
    } as unknown as PrismaClient;

    const conektaOk = {
      orders: {
        createOrder: async () => ({
          data: { id: 'ord_ok', livemode: false, payment_status: 'paid', charges: { data: [{ id: 'chg_ok' }] } },
        }),
      },
    } as unknown as ClienteConektaApi;

    await expect(
      cobrarIntentoAutopay({ prisma: prismaDbErrorPostCobro, conekta: conektaOk, log, intentoId: INTENTO_ID }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fallosMarcados).toBe(0);

    // Caso 2: 3er rechazo definitivo HTTP 402 suspende y notifica
    let autopaySuspendido: unknown;
    const prisma402 = {
      autopayIntento: {
        findUnique: async () => ({
          id: INTENTO_ID,
          autopayId: AUTOPAY_ID,
          cotoId: COTO_ID,
          cargoId: CARGO_ID,
          intentoNum: 3,
          montoCentavos: 120000,
          claveIdempotencia: `autopay:${AUTOPAY_ID}:${CARGO_ID}:3`,
          estado: 'pendiente',
          coto: { nombre: 'Miraflores' },
          autopay: {
            unidadId: UNIDAD_ID,
            diaCobro: 5,
            intentosFallidos: 2,
            maxReintentos: 3,
            diasEntreReintentos: [3, 7, 14],
            paymentMethod: { activo: true, tipo: 'card', gatewayCustomerId: 'cus_1', gatewaySourceId: 'src_1' },
          },
        }),
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: async () => 1,
          pago: {
            findUnique: async () => null,
            create: async () => ({ id: PAGO_ID, estado: 'pendiente', aplicadoEn: null }),
          },
          autopayIntento: { update: async () => ({}) },
          autopayConfig: {
            update: async (args: { data: unknown }) => {
              autopaySuspendido = args.data;
              return {};
            },
          },
        }),
      $queryRaw: async () => [{ email: 'prop@coto.mx' }, { email: 'admin@coto.mx' }],
    } as unknown as PrismaClient;

    const conekta402 = {
      orders: {
        createOrder: async () => {
          throw Object.assign(new Error('Fondos insuficientes'), {
            response: { status: 402, data: { type: 'processing_error' } },
          });
        },
      },
    } as unknown as ClienteConektaApi;

    const avisos: unknown[] = [];
    const res402 = await cobrarIntentoAutopay({
      prisma: prisma402,
      conekta: conekta402,
      log,
      intentoId: INTENTO_ID,
      encolarCorreo: async (c, o) => {
        assertBullMqJobIdValido(o?.jobId);
        avisos.push(c);
      },
    });
    expect(res402).toEqual({ estado: 'suspendido' });
    expect(autopaySuspendido).toMatchObject({ intentosFallidos: 3, activo: false, estado: 'suspendido_por_fallos' });
    expect(avisos).toHaveLength(2);
  });

  test('cfdi (B1, B3, M1, M2, M3): timbre reservado, rechazo 4xx devuelve timbre, timeout reanudable sin doble CFDI, llaves S3 deterministas', async () => {
    let keyAlmacenada: Buffer | null = null;
    const llavesUsadas: string[] = [];
    let llamadasTimbrar = 0;
    let falloS3 = true;
    let cancelarStatus: 'pending' | 'accepted' = 'pending';
    let forzarRechazoPac = false;
    let timeoutTrasTimbrar = false;
    let timbresUsados = 0;
    const emitidasPac: { id: string; external_id: string; status: string }[] = [];
    const llavesSubidas: string[] = [];

    const filasCfdi: Record<string, unknown>[] = [];
    const activa = () =>
      filasCfdi.find((f) => !['cancelado', 'pendiente_cancelacion', 'fallido'].includes(String(f.estado)));

    const prisma = {
      coto: {
        findUnique: async () => ({
          orgId: ORG_ID,
          rfcCoto: 'COTO850101AAA',
          razonSocialCoto: 'Condominio Miraflores AC',
          regimenFiscal: '603',
          cpFiscal: '44100',
          facturapiOrgId: 'org_pac_coto_1',
        }),
      },
      pago: {
        findFirst: async () => ({
          id: PAGO_ID,
          estado: 'confirmado',
          metodo: 'spei',
          monto: { toString: () => '1500.00' },
        }),
      },
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('facturapi_api_key_enc')) return [{ facturapi_api_key_enc: keyAlmacenada }];
        return [{ n: 5 }];
      },
      $executeRaw: async (strings: TemplateStringsArray, arg1?: unknown, keyBuf?: Buffer) => {
        if (strings.join(' ').includes('app.marcar_cfdi_fallido')) {
          // Simula la función SQL: solo filas pendientes sin pac_invoice_id; devuelve el timbre reservado
          const fila = filasCfdi.find((f) => f.id === arg1 && f.estado === 'pendiente' && !f.pacInvoiceId);
          if (fila) {
            fila.estado = 'fallido';
            if (fila.paqueteTimbreId) timbresUsados -= 1;
          }
          return 1;
        }
        if (Buffer.isBuffer(keyBuf)) keyAlmacenada = keyBuf;
        return 1;
      },
      facturaCfdi: {
        findUnique: async (args: { where: { claveIdempotencia?: string; id?: string } }) =>
          filasCfdi.find(
            (f) =>
              (args.where.claveIdempotencia && f.claveIdempotencia === args.where.claveIdempotencia) ||
              (args.where.id && f.id === args.where.id),
          ) ?? null,
        findFirst: async (args: { where: { id?: string; estado?: { notIn?: string[] } } }) => {
          if (args.where.id) return filasCfdi.find((f) => f.id === args.where.id) ?? null;
          return activa() ?? null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          const nueva = {
            id: filasCfdi.length === 0 ? FACTURA_ID : crypto.randomUUID(),
            xmlUrl: null,
            pdfUrl: null,
            pacInvoiceId: null,
            uuidCfdi: null,
            ...args.data,
          };
          filasCfdi.push(nueva);
          return nueva;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const idx = filasCfdi.findIndex((f) => f.id === args.where.id);
          filasCfdi[idx] = { ...filasCfdi[idx], ...args.data };
          return filasCfdi[idx];
        },
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: async (strings: TemplateStringsArray) => {
            expect(strings.join(' ')).toContain('app.consumir_timbre');
            timbresUsados += 1;
            return [{ id: PAQUETE_TIMBRES_ID }];
          },
          facturaCfdi: { create: prisma.facturaCfdi.create },
        }),
    } as unknown as PrismaClient;

    const cfdiMaestro = {
      organizations: { getTestApiKey: async () => 'sk_test_org_coto_1' },
      invoices: {},
    } as unknown as ClienteCfdiApi;

    // M1: sincronizar_llave cifra la llave Facturapi dentro del worker
    const syncRes = await procesarJobCfdi({
      prisma,
      keyring: KEYRING,
      cfdiMaestro,
      cfdiTestMode: true,
      subir: async (k) => k,
      log,
      payload: { accion: 'sincronizar_llave', cotoId: COTO_ID, facturapiOrgId: 'org_pac_coto_1' },
    });
    expect(syncRes.accion).toBe('llave_sincronizada');
    expect(keyAlmacenada).not.toBeNull();

    const crearClientePorOrg = (orgApiKey: string, pacOrgId: string): ClienteCfdiApi => {
      if (orgApiKey !== 'sk_test_org_coto_1' || pacOrgId !== 'org_pac_coto_1') {
        throw new Error('Organización Facturapi equivocada');
      }
      llavesUsadas.push(orgApiKey);
      return {
        organizations: {},
        invoices: {
          list: async (q: { external_id: string }) => ({
            data: emitidasPac
              .filter((f) => f.external_id === q.external_id)
              .map((f) => ({ ...f, uuid: '11111111-1111-4111-8111-111111111111', total: 1500 })),
          }),
          create: async (datos: { external_id?: string }) => {
            if (forzarRechazoPac) {
              throw Object.assign(new Error('TaxId inválido en SAT'), { statusCode: 400 });
            }
            llamadasTimbrar += 1;
            const inv = { id: `inv_pac_${llamadasTimbrar}`, external_id: String(datos.external_id), status: 'valid' };
            emitidasPac.push(inv);
            if (timeoutTrasTimbrar) {
              // El PAC sí timbró, pero la respuesta se perdió (timeout); las consultas siguientes lo encuentran
              throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
            }
            return {
              id: inv.id,
              uuid: '11111111-1111-4111-8111-111111111111',
              series: 'A',
              folio_number: llamadasTimbrar,
              subtotal: 1500,
              total: 1500,
              status: 'valid',
            };
          },
          retrieve: async () =>
            cancelarStatus === 'accepted'
              ? { status: 'canceled', cancellation_status: 'accepted' }
              : { status: 'valid', cancellation_status: 'pending' },
          cancel: async () => ({ status: 'valid', cancellation_status: 'pending' }),
          downloadXml: async () => Readable.from([Buffer.from('<cfdi:Comprobante/>')]),
          downloadPdf: async () => Readable.from([Buffer.from('%PDF-1.4')]),
        },
      } as unknown as ClienteCfdiApi;
    };

    const payload = {
      accion: 'timbrar' as const,
      cotoId: COTO_ID,
      pagoId: PAGO_ID,
      receptor: {
        rfc: 'GOPJ800101BBB',
        nombre: 'Juan Gómez',
        regimenFiscal: '605',
        cpFiscal: '44110',
        usoCfdi: 'G03',
      },
      claveIdempotencia: `cfdi-pago:${PAGO_ID}`,
    };

    // B3: rechazo 400 del PAC marca fila como 'fallido', lanza UnrecoverableError y devuelve el timbre reservado
    forzarRechazoPac = true;
    await expect(
      procesarJobCfdi({ prisma, keyring: KEYRING, crearClientePorOrg, subir: async (k) => k, log, payload }),
    ).rejects.toThrow(UnrecoverableError);
    expect(filasCfdi[0]?.estado).toBe('fallido');
    expect(timbresUsados).toBe(0);

    // M1: el PAC timbra pero la respuesta se pierde en todos los intentos -> la fila queda 'pendiente' (no 'fallido')
    forzarRechazoPac = false;
    timeoutTrasTimbrar = true;
    const subirConFallo = async (k: string) => {
      if (falloS3) throw new Error('S3 caído temporalmente');
      llavesSubidas.push(k);
      return k;
    };
    for (let i = 0; i < 5; i += 1) {
      await expect(
        procesarJobCfdi({ prisma, keyring: KEYRING, crearClientePorOrg, subir: subirConFallo, log, payload }),
      ).rejects.toThrow(i === 0 ? /ETIMEDOUT/ : /S3 caído/);
    }
    timeoutTrasTimbrar = false;
    // B1: tras agotar los intentos (último falla en S3) la fila sigue 'pendiente', con pacInvoiceId y el timbre reservado
    const pendiente = filasCfdi.find((f) => f.estado === 'pendiente');
    expect(pendiente?.pacInvoiceId).toBe('inv_pac_1');
    expect(pendiente?.paqueteTimbreId).toBe(PAQUETE_TIMBRES_ID);
    expect(llamadasTimbrar).toBe(1);
    expect(timbresUsados).toBe(1);

    // B1: la solicitud posterior (reanudación con la clave de la fila) completa la factura sin volver a timbrar
    falloS3 = false;
    const r2 = await procesarJobCfdi({
      prisma,
      keyring: KEYRING,
      crearClientePorOrg,
      subir: subirConFallo,
      log,
      payload: { ...payload, claveIdempotencia: String(pendiente?.claveIdempotencia) },
    });
    expect(r2.accion).toBe('timbrado');
    expect(llamadasTimbrar).toBe(1);
    expect(timbresUsados).toBe(1);
    // M2: llaves deterministas por factura
    expect(llavesSubidas).toEqual([
      `${ORG_ID}/${COTO_ID}/cfdi/${r2.facturaId}.xml`,
      `${ORG_ID}/${COTO_ID}/cfdi/${r2.facturaId}.pdf`,
    ]);

    // M3: cancelación con pending -> pendiente_cancelacion + encola verificar_cancelacion; SAT acepta -> cancelado
    const verifs: string[] = [];
    const facturaTimbradaId = String(r2.facturaId);
    const cancelRes = await procesarJobCfdi({
      prisma,
      keyring: KEYRING,
      crearClientePorOrg,
      subir: async (k) => k,
      encolarVerificacion: async (_p, o) => {
        assertBullMqJobIdValido(o?.jobId);
        if (o?.jobId) verifs.push(o.jobId);
      },
      log,
      payload: { accion: 'cancelar', cotoId: COTO_ID, facturaId: facturaTimbradaId, motivo: '02' },
    });
    expect(cancelRes.accion).toBe('pendiente_cancelacion');
    expect(verifs).toHaveLength(1);

    cancelarStatus = 'accepted';
    const verifRes = await procesarJobCfdi({
      prisma,
      keyring: KEYRING,
      crearClientePorOrg,
      subir: async (k) => k,
      log,
      payload: { accion: 'verificar_cancelacion', cotoId: COTO_ID, facturaId: facturaTimbradaId, intento: 1 },
    });
    expect(verifRes.accion).toBe('cancelado');

    // B3: volver a timbrar tras cancelación NUNCA revive la factura cancelada; emite una nueva (llamadasTimbrar === 2)
    const rNuevo = await procesarJobCfdi({
      prisma,
      keyring: KEYRING,
      crearClientePorOrg,
      subir: async (k) => k,
      log,
      payload,
    });
    expect(rNuevo.accion).toBe('timbrado');
    expect(rNuevo.facturaId).not.toBe(facturaTimbradaId);
    expect(filasCfdi.find((f) => f.id === facturaTimbradaId)?.estado).toBe('cancelado');
    expect(llamadasTimbrar).toBe(2);
    expect(timbresUsados).toBe(2);
    expect(llavesUsadas.every((k) => k === 'sk_test_org_coto_1')).toBe(true);
  });

  test('billing: censo Stripe, mora día 6 -> solo_lectura / día 16 -> suspendido, e invoice.paid -> activo', async () => {
    const meterCalls: unknown[] = [];
    const estadosActualizados: Record<string, string> = {};
    const org1 = '11111111-1111-4111-8111-111111111111';
    const org2 = '22222222-2222-4222-8222-222222222222';
    const hoy = new Date('2026-11-26T12:00:00Z');
    const hace7Dias = Math.floor((hoy.getTime() - 7 * 86_400_000) / 1000);
    const hace18Dias = Math.floor((hoy.getTime() - 18 * 86_400_000) / 1000);

    const stripeMock = {
      billing: {
        meterEvents: {
          create: async (body: unknown) => {
            meterCalls.push(body);
            return { identifier: 'id_1' };
          },
        },
      },
      invoices: {
        list: async ({ customer }: { customer: string }) => ({
          data: customer === 'cus_mora_6' ? [{ due_date: hace7Dias }] : [{ due_date: hace18Dias }],
        }),
      },
    } as unknown as Stripe;

    let webhookEstado: string | undefined;
    const prisma = {
      $queryRaw: async () => [{ org_id: org1, stripe_customer_id: 'cus_mora_6', unidades_activas: 120 }],
      organizacion: {
        findMany: async () => [
          { id: org1, stripeCustomerId: 'cus_mora_6', estadoSuscripcion: 'activo' },
          { id: org2, stripeCustomerId: 'cus_mora_16', estadoSuscripcion: 'solo_lectura' },
        ],
        update: async (args: { where: { id: string }; data: { estadoSuscripcion: string } }) => {
          estadosActualizados[args.where.id] = args.data.estadoSuscripcion;
          return {};
        },
      },
      webhookEvent: {
        findUnique: async () => ({
          id: EVENTO_ID,
          proveedor: 'stripe',
          tipo: 'invoice.paid',
          procesadoEn: null,
          payload: { type: 'invoice.paid', data: { object: { customer: 'cus_mora_6' } } },
        }),
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          organizacion: {
            updateMany: async (args: { data: { estadoSuscripcion: string } }) => {
              webhookEstado = args.data.estadoSuscripcion;
              return { count: 1 };
            },
          },
          webhookEvent: { update: async () => ({}) },
        }),
    } as unknown as PrismaClient;

    expect(await reportarCensoMensualStripe(prisma, stripeMock, 'unidades_activas', log, hoy)).toEqual({
      reportadas: 1,
    });
    expect(meterCalls).toHaveLength(1);

    expect(await revisarMoraDespachos(prisma, stripeMock, log, hoy)).toEqual({ actualizadas: 2 });
    expect(estadosActualizados[org1]).toBe('solo_lectura');
    expect(estadosActualizados[org2]).toBe('suspendido');

    expect(await procesarWebhookStripe(prisma, log, EVENTO_ID)).toEqual({ estado: 'procesado' });
    expect(webhookEstado).toBe('activo');
  });
});
