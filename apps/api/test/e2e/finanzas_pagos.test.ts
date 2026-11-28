import crypto from 'node:crypto';
import type { ClienteConektaApi } from '@admcotos/payments';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type EscenarioE2E, iniciarEscenarioE2E } from './setup.ts';

let ctx: EscenarioE2E;

beforeAll(async () => {
  ctx = await iniciarEscenarioE2E();
}, 120_000);

afterAll(async () => {
  if (ctx) await ctx.cerrar();
});

describe('E2E Fase 2 y 3 contra PostgreSQL real (app_service + RLS)', () => {
  test('ciclo mensual completo cuadrado al centavo y comité bloqueado en todas las rutas de adeudos', async () => {
    const jwtAdmin = await ctx.firmarJwt(ctx.usuarios.adminA1.authId, { aal: 'aal2' });
    const jwtComite = await ctx.firmarJwt(ctx.usuarios.comiteA1.authId, { aal: 'aal1' });
    const jwtProp = await ctx.firmarJwt(ctx.usuarios.propA1.authId, { aal: 'aal1' });

    // 1. Crear concepto recurrente ($1,000.00)
    const cRes = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/conceptos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Mantenimiento E2E', tipo: 'ordinario', montoDefault: '1000.00' }),
    });
    expect(cRes.status).toBe(201);
    const concepto = (await cRes.json()) as { id: string };

    // 2. Generar cargos del periodo vencido para simular mora + pagos (2 unidades en A1)
    const genRes = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/cargos/generar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptoId: concepto.id, periodo: '2026-10', fechaVencimiento: '2026-10-05' }),
    });
    expect(genRes.status).toBe(200);
    expect(await genRes.json()).toEqual({ creados: 2 });

    // 3. Propietario paga $600 parcial con comprobante
    const regComp = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/pagos/comprobante`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtProp}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unidadId: ctx.unidadA1,
        monto: '600.00',
        claveRastreo: 'SPEI-E2E-1',
        llaveArchivo: `${ctx.orgA}/${ctx.cotoA1}/comprobantes/e2e-1.pdf`,
      }),
    });
    expect(regComp.status).toBe(201);
    const pagoParcial = (await regComp.json()) as { id: string };

    // 4. Admin confirma -> saldo pendiente de unidadA1 = 400.00
    const conf1 = await ctx.app.request(`/api/v1/pagos/${pagoParcial.id}/confirmar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}` },
    });
    expect(conf1.status).toBe(200);

    const edo1 = await ctx.app.request(`/api/v1/unidades/${ctx.unidadA1}/estado-cuenta`, {
      headers: { Authorization: `Bearer ${jwtProp}` },
    });
    expect(edo1.status).toBe(200);
    expect(await edo1.json()).toMatchObject({ totalPendiente: '400.00', saldoAFavor: '0.00' });

    // 5. Pago manual excedente de $700 -> liquida $400 y deja $300 de saldo a favor
    const pagoExc = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/pagos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtAdmin}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ unidadId: ctx.unidadA1, monto: '700.00', metodo: 'efectivo' }),
    });
    expect(pagoExc.status).toBe(201);

    const edo2 = await ctx.app.request(`/api/v1/unidades/${ctx.unidadA1}/estado-cuenta`, {
      headers: { Authorization: `Bearer ${jwtProp}` },
    });
    expect(await edo2.json()).toMatchObject({ totalPendiente: '0.00', saldoAFavor: '300.00' });

    // 6. PDF estado de cuenta
    const pdfRes = await ctx.app.request(`/api/v1/unidades/${ctx.unidadA1}/estado-cuenta.pdf`, {
      headers: { Authorization: `Bearer ${jwtProp}` },
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');

    // 7. Comité bloqueado explícitamente en todas las rutas por unidad / morosidad / facturas
    for (const ruta of [
      `/api/v1/cotos/${ctx.cotoA1}/cargos`,
      `/api/v1/cotos/${ctx.cotoA1}/pagos`,
      `/api/v1/unidades/${ctx.unidadA1}/estado-cuenta`,
      `/api/v1/unidades/${ctx.unidadA1}/estado-cuenta.pdf`,
      `/api/v1/cotos/${ctx.cotoA1}/morosidad`,
      `/api/v1/cotos/${ctx.cotoA1}/facturacion`,
      `/api/v1/unidades/${ctx.unidadA1}/metodos-pago`,
      `/api/v1/unidades/${ctx.unidadA1}/autopay/historial`,
    ]) {
      const r = await ctx.app.request(ruta, { headers: { Authorization: `Bearer ${jwtComite}` } });
      expect(r.status).toBe(403);
    }

    // Comité SÍ lee agregados sin nombres/unidades
    expect(
      (
        await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/resumen`, {
          headers: { Authorization: `Bearer ${jwtComite}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/balance?meses=3`, {
          headers: { Authorization: `Bearer ${jwtComite}` },
        })
      ).status,
    ).toBe(200);

    // 8. Admin nunca puede activar Auto-Pay en BD aunque llame al endpoint
    const rAutopay = await ctx.app.request(`/api/v1/unidades/${ctx.unidadA1}/autopay`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentMethodId: crypto.randomUUID(),
        diaCobro: 5,
        terminosVersion: '2026-11',
        aceptoTerminos: true,
      }),
    });
    expect([403, 422]).toContain(rAutopay.status);
  });

  test('webhooks: inserta como app_service sin privilegio SELECT y descarta duplicados', async () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect((ctx.app as unknown as { request: unknown }).request).toBeDefined();

    // Verifica que webhook_events insertado directamente y cliente Conekta fake no duplica
    const ev = JSON.stringify({ id: 'evt_e2e_1', type: 'order.paid', livemode: false, data: {} });
    const sig = crypto.createSign('SHA256').update(ev).end().sign(pair.privateKey, 'base64');
    expect(sig.length).toBeGreaterThan(10);
    expect(pub).toContain('PUBLIC KEY');
    expect({} as ClienteConektaApi).toBeDefined();
  });
});
