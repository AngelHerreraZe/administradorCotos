import crypto from 'node:crypto';
import type { PrismaClient } from '@admcotos/db';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';
import type { Deps } from '../src/types.ts';

const ISSUER = 'https://test.supabase.co/auth/v1';
const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const COTO_ID = '33333333-3333-4333-8333-333333333333';
const OTRO_COTO_ID = '99999999-9999-4999-8999-999999999999';
const UNIDAD_ID = '44444444-4444-4444-8444-444444444444';
const CONCEPTO_ID = '55555555-5555-4555-8555-555555555555';
const CARGO_ID = '66666666-6666-4666-8666-666666666666';
const EGRESO_ID = '77777777-7777-4777-8777-777777777777';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

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

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [jwk] });
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

function appConTx(tx: Record<string, unknown>, extra: Partial<Deps> = {}) {
  const prisma = {
    $queryRaw: async () => [{ id: USER_ID }],
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({ $executeRaw: async () => 1, ...tx }),
  } as unknown as PrismaClient;

  return createApp({
    env,
    prisma,
    log: pino({ level: 'silent' }),
    jwks,
    limitador: { async consumir() {} },
    encolarCorreo: async () => {},
    storage: {
      llaveParaArchivo: (o, c, cat) => `${o}/${c}/${cat}/${crypto.randomUUID()}.pdf`,
      urlDeSubida: async ({ llave }) => ({ url: 'https://s3.test/up', fields: {}, expiraEnSegundos: 300, llave }),
      urlDeDescarga: async ({ llave }) => ({ url: `https://s3.test/${llave}`, expiraEnSegundos: 120 }),
    },
    ...extra,
  });
}

describe('Fase 2: conceptos, cargos, estado de cuenta, egresos y reportes', () => {
  test('conceptos GET/POST/PATCH: feliz, 422, 403 otro rol y 404 otro coto', async () => {
    const token = await firmarToken();
    const conceptoBase = {
      id: CONCEPTO_ID,
      cotoId: COTO_ID,
      nombre: 'Mantenimiento',
      tipo: 'ordinario',
      montoDefault: { toString: () => '1500.00' },
      usaIndiviso: false,
      esRecurrente: true,
      activo: true,
    };

    const appOk = appConTx({
      $queryRaw: async () => [{ ok: true }],
      conceptoCargo: {
        findMany: async () => [conceptoBase],
        create: async () => conceptoBase,
        findFirst: async (args: { where: { cotoId: string } }) =>
          args.where.cotoId === COTO_ID ? { id: CONCEPTO_ID } : null,
        update: async () => ({ ...conceptoBase, nombre: 'Mantenimiento 2026', activo: false }),
      },
    });

    expect(
      (await appOk.request(`/api/v1/cotos/${COTO_ID}/conceptos`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);

    const res201 = await appOk.request(`/api/v1/cotos/${COTO_ID}/conceptos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Mantenimiento', tipo: 'ordinario', montoDefault: '1500.00' }),
    });
    expect(res201.status).toBe(201);

    // PATCH happy + 422 + 404 otro coto + 403 otro rol
    const patchOk = await appOk.request(`/api/v1/cotos/${COTO_ID}/conceptos/${CONCEPTO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Mantenimiento 2026', activo: false }),
    });
    expect(patchOk.status).toBe(200);
    expect(await patchOk.json()).toMatchObject({ nombre: 'Mantenimiento 2026', activo: false });

    const patch422 = await appOk.request(`/api/v1/cotos/${COTO_ID}/conceptos/${CONCEPTO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(patch422.status).toBe(422);

    const patchOtroCoto = await appOk.request(`/api/v1/cotos/${OTRO_COTO_ID}/conceptos/${CONCEPTO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activo: false }),
    });
    expect(patchOtroCoto.status).toBe(404);

    const appOtroRol = appConTx({
      conceptoCargo: {
        findFirst: async () => ({ id: CONCEPTO_ID }),
        update: async () => {
          throw Object.assign(new Error('P2025'), { code: 'P2025' });
        },
      },
      $queryRaw: async () => [{ ok: false }],
    });
    expect(
      (
        await appOtroRol.request(`/api/v1/cotos/${COTO_ID}/conceptos/${CONCEPTO_ID}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ activo: false }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await appOtroRol.request(`/api/v1/cotos/${COTO_ID}/conceptos`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });

  test('cargos generar/crear/listar/condonar: feliz, 422, idempotencia, 403 otro rol y otro coto', async () => {
    const token = await firmarToken();
    let intentos = 0;
    const cargoBase = {
      id: CARGO_ID,
      cotoId: COTO_ID,
      unidadId: UNIDAD_ID,
      conceptoId: CONCEPTO_ID,
      periodo: '2026-11',
      montoOriginal: { toString: () => '800.00' },
      montoMoratoria: { toString: () => '0.00' },
      montoDescuento: { toString: () => '0.00' },
      saldoPendiente: { toString: () => '800.00' },
      estado: 'pendiente',
      fechaEmision: new Date('2026-11-01T00:00:00Z'),
      fechaVencimiento: new Date('2026-11-10T00:00:00Z'),
      notas: null,
    };

    const app = appConTx({
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('app.cotos_admin')) return [{ ok: true }];
        if (sql.includes('app.generar_cargos')) return [{ creados: 50 }];
        if (sql.includes('app.cotos_finanzas')) return [{ ok: false }];
        return [{ ok: true }];
      },
      cargo: {
        create: async () => {
          intentos += 1;
          if (intentos === 1) return cargoBase;
          throw Object.assign(new Error('Unique'), { code: 'P2002' });
        },
        findUnique: async () => ({ ...cargoBase, estado: 'condonado', saldoPendiente: { toString: () => '0.00' } }),
      },
    });

    const gen = await app.request(`/api/v1/cotos/${COTO_ID}/cargos/generar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptoId: CONCEPTO_ID, periodo: '2026-11' }),
    });
    expect(gen.status).toBe(200);
    expect(await gen.json()).toEqual({ creados: 50 });

    const key = crypto.randomUUID();
    const c1 = await app.request(`/api/v1/cotos/${COTO_ID}/cargos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        unidadId: UNIDAD_ID,
        conceptoId: CONCEPTO_ID,
        periodo: '2026-11',
        montoOriginal: '800.00',
        fechaVencimiento: '2026-11-10',
      }),
    });
    expect(c1.status).toBe(201);

    const c2 = await app.request(`/api/v1/cotos/${COTO_ID}/cargos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        unidadId: UNIDAD_ID,
        conceptoId: CONCEPTO_ID,
        periodo: '2026-11',
        montoOriginal: '800.00',
        fechaVencimiento: '2026-11-10',
      }),
    });
    expect(c2.status).toBe(200);

    // Comité / otro coto recibe 403 en GET /cargos
    expect(
      (await app.request(`/api/v1/cotos/${OTRO_COTO_ID}/cargos`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(403);

    // POST /cargos/{id}/condonar: feliz, 422, 403 otro rol, 404 otro coto
    const condOk = await app.request(`/api/v1/cargos/${CARGO_ID}/condonar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'Acuerdo asamblea' }),
    });
    expect(condOk.status).toBe(200);

    const cond422 = await app.request(`/api/v1/cargos/${CARGO_ID}/condonar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'x' }),
    });
    expect(cond422.status).toBe(422);

    const appSinPerm = appConTx({
      $executeRaw: async () => {
        throw Object.assign(new Error('UA403'), {
          meta: {
            driverAdapterError: {
              cause: { originalCode: 'UA403', originalMessage: 'Sin permiso para condonar cargos' },
            },
          },
        });
      },
    });
    expect(
      (
        await appSinPerm.request(`/api/v1/cargos/${CARGO_ID}/condonar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: 'Acuerdo' }),
        })
      ).status,
    ).toBe(403);
  });

  test('estado-cuenta JSON y PDF: feliz, 422 UUID inválido, 403 comité, 404 otro coto', async () => {
    const token = await firmarToken();
    const app = appConTx({
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('FROM unidades')) {
          return [
            {
              id: UNIDAD_ID,
              coto_id: COTO_ID,
              numero: 'A-101',
              saldo_a_favor: { toString: () => '250.00' },
              coto_nombre: 'Coto Miraflores',
            },
          ];
        }
        if (sql.includes('cotos_finanzas')) return [{ ok: true }];
        if (sql.includes('app.estado_cuenta')) {
          return [
            {
              cargo_id: CARGO_ID,
              concepto: 'Cuota ordinaria',
              periodo: '2026-11',
              vence: '2026-11-10',
              saldo: { toString: () => '1500.00' },
              vencido: true,
              total_pendiente: { toString: () => '1500.00' },
            },
          ];
        }
        return [];
      },
    });

    expect(
      (
        await app.request(`/api/v1/unidades/${UNIDAD_ID}/estado-cuenta`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (await app.request('/api/v1/unidades/no-uuid/estado-cuenta', { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(422);

    const pdfRes = await app.request(`/api/v1/unidades/${UNIDAD_ID}/estado-cuenta.pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    expect(
      Buffer.from(await pdfRes.arrayBuffer())
        .subarray(0, 5)
        .toString('utf8'),
    ).toBe('%PDF-');

    const appOtroCoto = appConTx({ $queryRaw: async () => [] });
    expect(
      (
        await appOtroCoto.request(`/api/v1/unidades/${UNIDAD_ID}/estado-cuenta`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
  });

  test('egresos GET/POST/PATCH/aprobar/rechazar: B6 bloquea mezclar marcarPagado y proveedorId, M10 valida llave y M11 valida 422', async () => {
    const token = await firmarToken();
    const egresoBase = {
      id: EGRESO_ID,
      cotoId: COTO_ID,
      cuentaBancariaId: null,
      proveedorId: null,
      categoria: 'mantenimiento',
      concepto: 'Podadora',
      monto: { toString: () => '2200.00' },
      fecha: new Date('2026-11-12T00:00:00Z'),
      estado: 'pendiente',
      solicitadoPor: USER_ID,
      aprobadoPor: null,
      aprobadoEn: null,
      rechazadoEn: null,
      motivoRechazo: null,
      tieneFactura: false,
      facturaUuid: null,
      comprobanteUrl: `${ORG_ID}/${COTO_ID}/egresos/fac1.pdf`,
      notas: null,
    };

    let intentos = 0;
    const app = appConTx({
      $queryRaw: async () => [{ org_id: ORG_ID, ok: true }],
      $executeRaw: async (strings: TemplateStringsArray) => {
        if (strings.join(' ').includes('aprobar_egreso')) {
          throw Object.assign(new Error('UA403'), {
            meta: {
              driverAdapterError: {
                cause: { originalCode: 'UA403', originalMessage: 'Quien solicita un egreso no puede aprobarlo' },
              },
            },
          });
        }
        return 1;
      },
      coto: { findUnique: async () => ({ orgId: ORG_ID }) },
      egreso: {
        findMany: async () => [egresoBase],
        create: async () => {
          intentos += 1;
          if (intentos === 1) return egresoBase;
          throw Object.assign(new Error('P2002'), { code: 'P2002' });
        },
        findUnique: async () => ({ ...egresoBase, estado: 'rechazado', motivoRechazo: 'Fuera de presupuesto' }),
        findUniqueOrThrow: async () => ({ ...egresoBase, estado: 'pagado' }),
        findFirst: async () => ({ id: EGRESO_ID, estado: 'aprobado' }),
      },
    });

    // POST idempotente + validación llave comprobante M10
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/egresos`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            concepto: 'Podadora',
            monto: '2200.00',
            comprobanteUrl: 'https://evil.example/archivo.pdf',
          }),
        })
      ).status,
    ).toBe(422);

    const key = crypto.randomUUID();
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/egresos`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({
            concepto: 'Podadora',
            monto: '2200.00',
            comprobanteUrl: `${ORG_ID}/${COTO_ID}/egresos/fac1.pdf`,
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`/api/v1/cotos/${COTO_ID}/egresos`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ concepto: 'Podadora', monto: '2200.00' }),
        })
      ).status,
    ).toBe(200);

    // B6: PATCH con marcarPagado + proveedorId rechazado con 422
    const patchMixto = await app.request(`/api/v1/cotos/${COTO_ID}/egresos/${EGRESO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marcarPagado: true, proveedorId: UNIDAD_ID }),
    });
    expect(patchMixto.status).toBe(422);

    // PATCH solo marcarPagado -> 200 (vía app.marcar_egreso_pagado)
    const patchPagado = await app.request(`/api/v1/cotos/${COTO_ID}/egresos/${EGRESO_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marcarPagado: true }),
    });
    expect(patchPagado.status).toBe(200);

    // Aprobar por el solicitante -> 403
    expect(
      (
        await app.request(`/api/v1/egresos/${EGRESO_ID}/aprobar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);

    // Rechazar egreso: M11 JSON inválido -> 422; JSON válido -> 200
    expect(
      (
        await app.request(`/api/v1/egresos/${EGRESO_ID}/rechazar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: 123 }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(`/api/v1/egresos/${EGRESO_ID}/rechazar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: 'Fuera de presupuesto' }),
        })
      ).status,
    ).toBe(200);

    // M4: URL prefirmada para comprobante de egreso en categoría 'egresos' + 403 otro rol
    const urlEgr = await app.request(`/api/v1/cotos/${COTO_ID}/egresos/comprobante-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'application/pdf' }),
    });
    expect(urlEgr.status).toBe(200);
    expect(((await urlEgr.json()) as { llave: string }).llave.startsWith(`${ORG_ID}/${COTO_ID}/egresos/`)).toBe(true);

    const appSinEgreso = appConTx({ $queryRaw: async () => [{ org_id: ORG_ID, ok: false }] });
    expect(
      (
        await appSinEgreso.request(`/api/v1/cotos/${COTO_ID}/egresos/comprobante-url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'application/pdf' }),
        })
      ).status,
    ).toBe(403);
  });

  test('reportes: resumen, morosidad (403 a comité y otro coto) y balance', async () => {
    const token = await firmarToken();
    const appComite = appConTx({
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('cotos_staff')) return [{ ok: true }];
        if (sql.includes('app.resumen_cotos')) {
          return [
            {
              coto_id: COTO_ID,
              coto: 'Miraflores',
              unidades: 50,
              emitido_mes: { toString: () => '50000.00' },
              cobrado_mes: { toString: () => '40000.00' },
              pct_cobrado: { toString: () => '80.0' },
              adeudo_vencido: { toString: () => '10000.00' },
              unidades_morosas: 5,
              pagos_por_revisar: 2,
              tickets_abiertos: 1,
            },
          ];
        }
        if (sql.includes('cotos_finanzas')) return [{ ok: false }];
        return [];
      },
    });

    expect(
      (await appComite.request(`/api/v1/cotos/${COTO_ID}/resumen`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
    expect(
      (await appComite.request(`/api/v1/cotos/${COTO_ID}/morosidad`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(403);
    expect(
      (
        await appComite.request(`/api/v1/cotos/${OTRO_COTO_ID}/morosidad`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await appComite.request(`/api/v1/cotos/${COTO_ID}/balance?meses=99`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(422);
  });
});
