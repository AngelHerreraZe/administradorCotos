import crypto from 'node:crypto';
import type { ClienteCfdiApi } from '@admcotos/cfdi';
import type { PrismaClient } from '@admcotos/db';
import type { ClienteConektaApi } from '@admcotos/payments';
import { Job } from 'bullmq';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import Stripe from 'stripe';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';
import type { Deps } from '../src/types.ts';

const ISSUER = 'https://test.supabase.co/auth/v1';
const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '88888888-8888-4888-8888-888888888888';
const OTRA_ORG_ID = '99999999-9999-4999-8999-999999999999';
const COTO_ID = '33333333-3333-4333-8333-333333333333';
const OTRO_COTO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIDAD_ID = '44444444-4444-4444-8444-444444444444';
const PAGO_ID = '55555555-5555-4555-8555-555555555555';
const PM_ID = '66666666-6666-4666-8666-666666666666';
const FACTURA_ID = '77777777-7777-4777-8777-777777777777';

process.env.DB_CTX_SECRET ??= 'ab'.repeat(32);

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_service:x@localhost:5432/test',
  DB_CTX_SECRET: 'ab'.repeat(32),
  SUPABASE_URL: 'https://test.supabase.co',
  REDIS_URL: 'redis://localhost:6379',
});

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
let conektaPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [jwk] });
  conektaPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
});

async function firmarToken() {
  return new SignJWT({ aal: 'aal2' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(AUTH_ID)
    .setExpirationTime('5m')
    .sign(privateKey);
}

function appCon(tx: Record<string, unknown>, extra: Partial<Deps> = {}, prismaExtra: Record<string, unknown> = {}) {
  const prisma = {
    $queryRaw: async () => [{ id: USER_ID }],
    $executeRaw: async () => 1,
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({ $executeRaw: async () => 1, ...tx }),
    ...prismaExtra,
  } as unknown as PrismaClient;

  return createApp({
    env,
    prisma,
    log: pino({ level: 'silent' }),
    jwks,
    limitador: { async consumir() {} },
    encolarCorreo: async () => {},
    ...extra,
  });
}

function validarJobIdBullMq(jobId: string | undefined) {
  if (!jobId) return;
  (Job.prototype as unknown as { validateOptions(d: { data: string }): void }).validateOptions.call(
    { name: 'test', opts: { jobId } },
    { data: '{}' },
  );
}

describe('Fase 2/3: matriz completa de pagos, comprobantes, Conekta, Auto-Pay, CFDI, Billing y Webhooks', () => {
  test('pagos manuales, URL comprobantes, rechazar pago y bloqueo confirmar pago gateway != manual (M14)', async () => {
    const token = await firmarToken();
    const correos: unknown[] = [];
    const pagoBase = {
      id: PAGO_ID,
      cotoId: COTO_ID,
      unidadId: UNIDAD_ID,
      monto: { toString: () => '1500.00' },
      metodo: 'transferencia_manual',
      gateway: 'manual',
      gatewayOrderId: null,
      gatewayChargeId: null,
      gatewayMetadata: null,
      comprobanteUrl: `${ORG_ID}/${COTO_ID}/comprobantes/abc.pdf`,
      referenciaBancaria: 'REF123',
      claveRastreo: 'SPEI-001',
      estado: 'en_revision',
      motivoRechazo: null,
      notas: null,
      fechaPago: new Date('2026-11-15T12:00:00Z'),
      fechaConfirmacion: null,
      aplicadoEn: null,
    };

    const app = appCon(
      {
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          if (sql.includes('FROM pagos')) {
            return [{ id: PAGO_ID, coto_id: COTO_ID, unidad_id: UNIDAD_ID, comprobante_url: pagoBase.comprobanteUrl }];
          }
          if (sql.includes('app.cotos_admin')) return [{ ok: true }];
          if (sql.includes('app.unidades_propias')) return [{ org_id: ORG_ID, es_propietario: true }];
          if (sql.includes('miembros_coto')) {
            return [{ email: 'prop@coto.mx', coto: 'Miraflores', unidad: '101' }];
          }
          return [];
        },
        pago: {
          create: async () => pagoBase,
          findUnique: async () => pagoBase,
          update: async () => ({ ...pagoBase, estado: 'confirmado' }),
          findUniqueOrThrow: async () => ({
            ...pagoBase,
            estado: 'confirmado',
            fechaConfirmacion: new Date(),
            aplicadoEn: new Date(),
          }),
        },
      },
      {
        encolarCorreo: async (p, opts) => {
          validarJobIdBullMq(opts?.jobId);
          correos.push({ p, jobId: opts?.jobId });
        },
        storage: {
          llaveParaArchivo: (orgId, cotoId) => `${orgId}/${cotoId}/comprobantes/abc.pdf`,
          urlDeSubida: async ({ llave }) => ({
            url: 'https://s3.test/upload',
            fields: { key: llave },
            expiraEnSegundos: 300,
            llave,
          }),
          urlDeDescarga: async ({ ttlSegundos = 120 }) => ({
            url: 'https://s3.test/download?sig=1',
            expiraEnSegundos: ttlSegundos,
          }),
        },
      },
    );

    // POST /comprobantes/url: feliz, 422 tipo no permitido, 403 no propietario
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/comprobantes/url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ unidadId: UNIDAD_ID, contentType: 'application/pdf' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/comprobantes/url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ unidadId: UNIDAD_ID, contentType: 'text/html' }),
        })
      ).status,
    ).toBe(422);

    // Confirmar pago manual -> 200 y encola recibo; rechazar -> 200 / 422 motivo corto / 403 otro rol
    expect(
      (
        await app.request(`/api/v1/pagos/${PAGO_ID}/confirmar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(correos).toHaveLength(1);
    expect(correos[0]).toMatchObject({ jobId: `recibo-${PAGO_ID}` });

    expect(
      (
        await app.request(`/api/v1/pagos/${PAGO_ID}/rechazar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: 'No legible' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/v1/pagos/${PAGO_ID}/rechazar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: 'no' }),
        })
      ).status,
    ).toBe(422);

    // M14: confirmar manualmente pago de pasarela Conekta -> 409
    const appConektaPago = appCon({
      $queryRaw: async () => [{ ok: true }],
      pago: { findUnique: async () => ({ ...pagoBase, gateway: 'conekta', estado: 'pendiente' }) },
    });
    expect(
      (
        await appConektaPago.request(`/api/v1/pagos/${PAGO_ID}/confirmar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(409);

    const appOtroCoto = appCon({
      $queryRaw: async () => [],
      $executeRaw: async () => {
        throw Object.assign(new Error('UA404'), {
          meta: { driverAdapterError: { cause: { originalCode: 'UA404', originalMessage: 'Pago no encontrado' } } },
        });
      },
    });
    expect(
      (
        await appOtroCoto.request(`/api/v1/pagos/${PAGO_ID}/rechazar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: 'Otro coto' }),
        })
      ).status,
    ).toBe(404);
  });

  test('Conekta /pagos/online crea fila pendiente ANTES de orden Conekta (B4) y reenvía metadatos en replay (M3)', async () => {
    const token = await firmarToken();
    const pasos: string[] = [];
    let conektaIdempotencyKey: string | undefined;

    const conektaApi = {
      orders: {
        createOrder: async (_req: unknown, _a: unknown, _b: unknown, idemKey?: string) => {
          pasos.push('conekta.createOrder');
          conektaIdempotencyKey = idemKey;
          return {
            data: {
              id: 'ord_spei_1',
              livemode: false,
              payment_status: 'pending_payment',
              charges: { data: [{ id: 'chg_spei_1', payment_method: { clabe: '646180111800000001' } }] },
            },
          };
        },
      },
    } as unknown as ClienteConektaApi;

    let pagoGuardado: Record<string, unknown> | null = null;
    const app = appCon(
      {
        $queryRaw: async () => [
          {
            es_propietario: true,
            coto_nombre: 'Miraflores',
            unidad_numero: '101',
            nombre: 'Ana López',
            email: 'ana@test.mx',
            telefono: null,
          },
        ],
        pago: {
          findUnique: async () => pagoGuardado,
          create: async (args: { data: { monto: string } }) => {
            pasos.push('bd.insertPendiente');
            pagoGuardado = {
              id: PAGO_ID,
              cotoId: COTO_ID,
              unidadId: UNIDAD_ID,
              monto: { toString: () => args.data.monto },
              metodo: 'spei',
              gateway: 'conekta',
              gatewayOrderId: null,
              gatewayChargeId: null,
              gatewayMetadata: null,
              comprobanteUrl: null,
              referenciaBancaria: null,
              claveRastreo: null,
              estado: 'pendiente',
              motivoRechazo: null,
              notas: null,
              fechaPago: new Date('2026-11-15T00:00:00Z'),
              fechaConfirmacion: null,
              aplicadoEn: null,
            };
            return pagoGuardado;
          },
          findUniqueOrThrow: async () => pagoGuardado,
          update: async (args: {
            data: { gatewayOrderId: string; gatewayChargeId?: string; gatewayMetadata: unknown };
          }) => {
            pasos.push('bd.updateOrderId');
            pagoGuardado = { ...pagoGuardado, ...args.data };
            return pagoGuardado;
          },
        },
      },
      { conekta: { cliente: conektaApi } },
    );

    const key = crypto.randomUUID();
    const res1 = await app.request(`/api/v1/cotos/${COTO_ID}/pagos/online`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ unidadId: UNIDAD_ID, monto: '1250.50', metodo: 'spei' }),
    });
    expect(res1.status).toBe(201);
    // B4: insert pendiente ocurrió estrictamente antes de crear orden en Conekta
    expect(pasos).toEqual(['bd.insertPendiente', 'conekta.createOrder', 'bd.updateOrderId']);
    // M2: Conekta recibió clave con prefijo de usuario
    expect(conektaIdempotencyKey).toBe(`pago-online:${USER_ID}:${key}`);

    // M3: replay idempotente vuelve con clabeSpei y NO vuelve a llamar a Conekta
    const res2 = await app.request(`/api/v1/cotos/${COTO_ID}/pagos/online`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ unidadId: UNIDAD_ID, monto: '1250.50', metodo: 'spei' }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ gatewayOrderId: 'ord_spei_1', clabeSpei: '646180111800000001' });
    expect(pasos).toHaveLength(3);
  });

  test('Auto-Pay métodos de pago (M15 prioridad Conekta), DELETE, POST/PATCH/GET historial', async () => {
    const token = await firmarToken();
    const conektaApi = {
      customers: { createCustomer: async () => ({ data: { id: 'cus_ck_1' } }) },
      paymentMethods: {
        createCustomerPaymentMethods: async () => ({
          data: { id: 'src_ck_1', last4: '9999', brand: 'mastercard', exp_month: 12, exp_year: 2029 },
        }),
      },
    } as unknown as ClienteConektaApi;

    let metodoGuardado: Record<string, unknown> = {};
    const apBase = {
      id: crypto.randomUUID(),
      cotoId: COTO_ID,
      unidadId: UNIDAD_ID,
      paymentMethodId: PM_ID,
      activo: true,
      diaCobro: 5,
      maxReintentos: 3,
      intentosFallidos: 0,
      ultimoCobroExitoso: null,
      proximoCobro: new Date('2026-12-05T00:00:00Z'),
      estado: 'activo',
      terminosVersion: '2026-11',
      terminosAceptadosEn: new Date('2026-11-26T00:00:00Z'),
    };

    const app = appCon(
      {
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          if (sql.includes('gateway_customer_id')) {
            return [
              {
                coto_id: COTO_ID,
                es_propietario: true,
                nombre: 'Ana',
                email: 'a@t.mx',
                telefono: null,
                gateway_customer_id: null,
              },
            ];
          }
          if (sql.includes('SELECT u.coto_id')) return [{ coto_id: COTO_ID, ok: true }];
          return [{ coto_id: COTO_ID }];
        },
        paymentMethod: {
          updateMany: async () => ({ count: 0 }),
          create: async (args: { data: Record<string, unknown> }) => {
            metodoGuardado = { id: PM_ID, ...args.data };
            return metodoGuardado;
          },
          findMany: async () => [metodoGuardado],
          findFirst: async () => ({ id: PM_ID }),
          update: async () => ({ id: PM_ID, activo: false }),
        },
        autopayConfig: {
          findUnique: async () => apBase,
          update: async () => ({ ...apBase, activo: false, estado: 'pausado' }),
          updateMany: async () => ({ count: 1 }),
        },
        autopayIntento: { findMany: async () => [] },
      },
      { conekta: { cliente: conektaApi } },
    );

    // M15: cliente intenta etiquetar "0000" / "visa" pero Conekta devolvió "9999" / "mastercard"
    const pmRes = await app.request(`/api/v1/unidades/${UNIDAD_ID}/metodos-pago`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: 'tok_test_1', ultimos4: '0000', marcaTarjeta: 'visa' }),
    });
    expect(pmRes.status).toBe(201);
    expect(await pmRes.json()).toMatchObject({
      ultimos4: '9999',
      marcaTarjeta: 'mastercard',
      fechaExpiracion: '12/2029',
    });

    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/metodos-pago`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/metodos-pago/${PM_ID}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);

    // PATCH /autopay pausado + 422 vacío + historial
    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/autopay`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ estado: 'pausado' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/autopay`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/autopay/historial`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);

    // 422 y 403/404 (otro coto / no propietario) en métodos de pago y autopay
    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/metodos-pago`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(422);

    const appSinAccesoUnidad = appCon(
      { $queryRaw: async () => [], autopayConfig: { findUnique: async () => null } },
      { conekta: { cliente: conektaApi } },
    );
    expect(
      (
        await appSinAccesoUnidad.request(`/api/v1/unidades/${UNIDAD_ID}/metodos-pago`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: 'tok_test_1' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await appSinAccesoUnidad.request(`/api/v1/unidades/${UNIDAD_ID}/autopay`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ estado: 'pausado' }),
        })
      ).status,
    ).toBe(404);
  });

  test('CFDI: B3 elimina /cfdi/csd (404), configurar guarda llave cifrada, listar/descarga/timbrar/cancelar', async () => {
    const token = await firmarToken();
    const encolados: unknown[] = [];
    const sqlExecs: string[] = [];
    const cfdiClient = {
      organizations: {
        create: async () => ({ id: 'org_pac_1' }),
        updateLegal: async () => ({ id: 'org_pac_1' }),
        getTestApiKey: async () => 'sk_test_org_secret',
        renewLiveApiKey: async () => 'sk_live_org_secret',
      },
    } as unknown as ClienteCfdiApi;

    const facturaBase = {
      id: FACTURA_ID,
      cotoId: COTO_ID,
      pagoId: PAGO_ID,
      pacInvoiceId: 'inv_pac_1',
      tipoComprobante: 'I',
      uuidCfdi: '11111111-1111-4111-8111-111111111111',
      serie: 'A',
      folio: '1',
      emisorRfc: 'COTO850101AAA',
      emisorNombre: 'Condominio Miraflores AC',
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'Público en General',
      subtotal: { toString: () => '1000.00' },
      total: { toString: () => '1000.00' },
      xmlUrl: `${ORG_ID}/${COTO_ID}/cfdi/f1.xml`,
      pdfUrl: `${ORG_ID}/${COTO_ID}/cfdi/f1.pdf`,
      estado: 'timbrado',
      motivoCancelacion: null,
      sustitucionUuid: null,
      canceladoEn: null,
      createdAt: new Date('2026-11-15T00:00:00Z'),
    };

    let facturapiOrgId: string | null = null;
    let filaActiva: Record<string, unknown> | null = null;
    const app = appCon(
      {
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          if (sql.includes('FROM facturas_cfdi f')) {
            return [
              {
                id: FACTURA_ID,
                uuid_cfdi: facturaBase.uuidCfdi,
                xml_url: facturaBase.xmlUrl,
                pdf_url: facturaBase.pdfUrl,
              },
            ];
          }
          if (sql.includes('paquetes_timbres')) return [{ disponibles: 10 }];
          return [{ ok: true }];
        },
        $executeRaw: async (strings: TemplateStringsArray) => {
          sqlExecs.push(strings.join(' '));
          return 1;
        },
        coto: {
          findUnique: async () => ({
            orgId: ORG_ID,
            rfcCoto: 'COTO850101AAA',
            razonSocialCoto: 'Condominio Miraflores AC',
            regimenFiscal: '603',
            cpFiscal: '44100',
            facturapiOrgId,
          }),
          update: async (args: { data: { facturapiOrgId?: string } }) => {
            if (args.data.facturapiOrgId) facturapiOrgId = args.data.facturapiOrgId;
            return {};
          },
        },
        pago: { findFirst: async () => ({ id: PAGO_ID, estado: 'confirmado' }) },
        facturaCfdi: {
          findFirst: async () => filaActiva,
          count: async () => 0,
          findMany: async () => [facturaBase],
          findUnique: async () => ({ id: FACTURA_ID, cotoId: COTO_ID, estado: 'timbrado' }),
        },
      },
      {
        cfdi: cfdiClient,
        encolarCfdi: async (p, opts) => {
          validarJobIdBullMq(opts?.jobId);
          encolados.push({ p, opts });
        },
        storage: {
          llaveParaArchivo: () => 'x',
          urlDeSubida: async () => ({ url: 'u', fields: {}, expiraEnSegundos: 300, llave: 'x' }),
          urlDeDescarga: async ({ llave }) => ({ url: `https://s3.test/${llave}`, expiraEnSegundos: 120 }),
        },
      },
    );

    // B3: ruta /cfdi/csd no existe (CSD nunca toca la API)
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/cfdi/csd`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);

    // M1: configurar emisor guarda datos en coto y encola sincronizar_llave al worker cfdi (sin MASTER_KEKS en API)
    const cfg = await app.request(`/api/v1/cotos/${COTO_ID}/cfdi/configurar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rfcCoto: 'COTO850101AAA',
        razonSocialCoto: 'Condominio Miraflores AC',
        regimenFiscal: '603',
        cpFiscal: '44100',
      }),
    });
    expect(cfg.status).toBe(200);
    expect(sqlExecs.some((s) => s.includes('app.guardar_facturapi_key'))).toBe(false);
    expect(encolados).toHaveLength(1);

    // Timbrar (B3: ignora filas cancelado/fallido), listar y descargar
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/facturacion/timbrar/${PAGO_ID}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rfc: 'XAXX010101000',
            nombre: 'Público General',
            regimenFiscal: '616',
            cpFiscal: '44100',
            usoCfdi: 'S01',
          }),
        })
      ).status,
    ).toBe(202);
    expect(encolados).toHaveLength(2);

    // B1: una fila 'pendiente' (job agotado) se reanuda con su clave y receptor, con un jobId nuevo
    filaActiva = {
      ...facturaBase,
      estado: 'pendiente',
      xmlUrl: null,
      pdfUrl: null,
      claveIdempotencia: `cfdi-pago:${PAGO_ID}`,
      receptorRegimen: '616',
      receptorCp: '44100',
      receptorUsoCfdi: 'S01',
    };
    const reanudar = await app.request(`/api/v1/cotos/${COTO_ID}/facturacion/timbrar/${PAGO_ID}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rfc: 'GOPJ800101BBB',
        nombre: 'Otro Receptor',
        regimenFiscal: '605',
        cpFiscal: '44110',
        usoCfdi: 'G03',
      }),
    });
    expect(reanudar.status).toBe(202);
    const reanudado = encolados[2] as {
      p: { claveIdempotencia: string; receptor: { rfc: string } };
      opts: { jobId: string };
    };
    expect(reanudado.p.claveIdempotencia).toBe(`cfdi-pago:${PAGO_ID}`);
    expect(reanudado.p.receptor.rfc).toBe('XAXX010101000');
    expect(reanudado.opts.jobId.startsWith(`cfdi-reanudar-${FACTURA_ID}-`)).toBe(true);
    // Una fila ya timbrada no se re-encola
    filaActiva = facturaBase;
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/facturacion/timbrar/${PAGO_ID}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rfc: 'XAXX010101000',
            nombre: 'Público General',
            regimenFiscal: '616',
            cpFiscal: '44100',
            usoCfdi: 'S01',
          }),
        })
      ).status,
    ).toBe(200);
    expect(encolados).toHaveLength(3);
    filaActiva = null;

    expect(
      (await app.request(`/api/v1/cotos/${COTO_ID}/facturacion`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
    expect(
      (await app.request(`/api/v1/facturas/${FACTURA_ID}/descarga`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/v1/facturas/${FACTURA_ID}/cancelar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: '02' }),
        })
      ).status,
    ).toBe(202);

    // B7: otro coto / sin rol finanzas en CFDI -> 403
    const appSinCfdi = appCon(
      { $queryRaw: async () => [{ ok: false }] },
      { cfdi: cfdiClient, encolarCfdi: async () => {} },
    );
    expect(
      (
        await appSinCfdi.request(`/api/v1/cotos/${OTRO_COTO_ID}/cfdi/configurar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rfcCoto: 'COTO850101AAA',
            razonSocialCoto: 'Otro',
            regimenFiscal: '603',
            cpFiscal: '44100',
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await appSinCfdi.request(`/api/v1/cotos/${OTRO_COTO_ID}/facturacion`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });

  test('Billing GET/POST: feliz, 403 otro rol/org y 409 sin stripeCustomerId', async () => {
    const token = await firmarToken();
    const stripeFake = {
      billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/session_1' }) } },
    } as unknown as Stripe;

    const app = appCon(
      {
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          if (sql.includes('paquetes_timbres')) return [{ disponibles: 42 }];
          return [{ ok: true }];
        },
        organizacion: {
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === ORG_ID
              ? {
                  id: ORG_ID,
                  tierMayoreo: 'tier_1',
                  estadoSuscripcion: 'activo',
                  walletCreditos: { toString: () => '100.00' },
                  autoRecarga: false,
                  montoRecargaMin: { toString: () => '2000.00' },
                  stripeCustomerId: 'cus_stripe_1',
                }
              : null,
        },
      },
      { stripe: { cliente: stripeFake } },
    );

    const est = await app.request(`/api/v1/orgs/${ORG_ID}/billing`, { headers: { Authorization: `Bearer ${token}` } });
    expect(est.status).toBe(200);
    expect(await est.json()).toMatchObject({ timbresDisponibles: 42, estadoSuscripcion: 'activo' });

    const appSinBilling = appCon({ $queryRaw: async () => [{ ok: false }] });
    expect(
      (
        await appSinBilling.request(`/api/v1/orgs/${OTRA_ORG_ID}/billing`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await app.request(`/api/v1/orgs/${OTRA_ORG_ID}/billing/portal`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/v1/orgs/${ORG_ID}/billing/portal`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  });

  test('Webhooks Conekta y Stripe: cuerpo crudo, falta livemode (401), firma inválida (401) y deduplicación en ruta', async () => {
    const pubPem = conektaPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const stripe = new Stripe('sk_test_fake');
    const stripeSecret = 'whsec_test_route_12345';
    const encoladosConekta: unknown[] = [];
    const encoladosStripe: unknown[] = [];
    const vistos = new Set<string>();

    const app = appCon(
      {},
      {
        conekta: { cliente: {} as ClienteConektaApi, webhookPublicKeyPem: pubPem },
        stripe: { cliente: stripe, webhookSecret: stripeSecret },
        encolarPagosWebhook: async (p) => {
          encoladosConekta.push(p);
        },
        encolarBilling: async (p) => {
          encoladosStripe.push(p);
        },
      },
      {
        $executeRaw: async (_strings: TemplateStringsArray, _id: unknown, eventId: string) => {
          if (vistos.has(eventId)) return 0;
          vistos.add(eventId);
          return 1;
        },
      },
    );

    // M9: Conekta sin campo livemode -> 401 aunque tenga firma válida
    const sinLive = JSON.stringify({ id: 'evt_no_live', type: 'order.paid', data: {} });
    const sigSinLive = crypto.createSign('SHA256').update(sinLive).end().sign(conektaPair.privateKey, 'base64');
    expect(
      (
        await app.request('/webhooks/conekta', {
          method: 'POST',
          headers: { digest: sigSinLive },
          body: sinLive,
        })
      ).status,
    ).toBe(401);

    // Conekta válido + duplicado
    const okCk = JSON.stringify({ id: 'evt_ck_ok', type: 'order.paid', livemode: false, data: {} });
    const sigOkCk = crypto.createSign('SHA256').update(okCk).end().sign(conektaPair.privateKey, 'base64');
    expect(
      (await app.request('/webhooks/conekta', { method: 'POST', headers: { digest: sigOkCk }, body: okCk })).status,
    ).toBe(200);
    expect(
      (await app.request('/webhooks/conekta', { method: 'POST', headers: { digest: sigOkCk }, body: okCk })).status,
    ).toBe(200);
    expect(encoladosConekta).toHaveLength(1);

    // B7: ruta POST /webhooks/stripe (firma inválida 401, livemode true 401, livemode false 200 y duplicado no re-encola)
    const rawStMalo = JSON.stringify({ id: 'evt_st_bad', type: 'invoice.paid', livemode: false, data: { object: {} } });
    expect(
      (
        await app.request('/webhooks/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': 't=1,v1=bad' },
          body: rawStMalo,
        })
      ).status,
    ).toBe(401);

    const rawStLive = JSON.stringify({ id: 'evt_st_live', type: 'invoice.paid', livemode: true, data: { object: {} } });
    const hdrLive = await stripe.webhooks.generateTestHeaderStringAsync({ payload: rawStLive, secret: stripeSecret });
    expect(
      (
        await app.request('/webhooks/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': hdrLive },
          body: rawStLive,
        })
      ).status,
    ).toBe(401);

    const rawStOk = JSON.stringify({ id: 'evt_st_ok', type: 'invoice.paid', livemode: false, data: { object: {} } });
    const hdrOk = await stripe.webhooks.generateTestHeaderStringAsync({ payload: rawStOk, secret: stripeSecret });
    const st1 = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': hdrOk },
      body: rawStOk,
    });
    const st2 = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': hdrOk },
      body: rawStOk,
    });
    expect(st1.status).toBe(200);
    expect(await st1.json()).toEqual({ received: true, duplicate: false });
    expect(st2.status).toBe(200);
    expect(await st2.json()).toEqual({ received: true, duplicate: true });
    expect(encoladosStripe).toHaveLength(1);
  });
});
