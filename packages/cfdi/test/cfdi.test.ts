import { Readable } from 'node:stream';
import { AppError } from '@admcotos/shared';
import { describe, expect, test } from 'vitest';
import {
  buscarFacturaPorExternalId,
  type ClienteCfdiApi,
  cancelar,
  complementoDePago,
  consultarEstadoCancelacion,
  descargarXmlPdf,
  esRechazoDefinitivoPac,
  obtenerApiKeyOrgPac,
  registrarEmisorPac,
  timbrar,
} from '../src/index.ts';

const EMISOR = {
  rfc: 'COTO850101AAA',
  nombre: 'Condominio Miraflores AC',
  regimenFiscal: '603',
  cpFiscal: '44100',
};

const RECEPTOR = {
  rfc: 'GOPJ800101BBB',
  nombre: 'Juan Gómez Pérez',
  regimenFiscal: '605',
  cpFiscal: '44110',
  usoCfdi: 'G03',
};

describe('@admcotos/cfdi (PAC plataformas)', () => {
  test('rechaza timbrar sin datos fiscales completos antes de llamar al PAC', async () => {
    let llamadas = 0;
    const api = {
      organizations: {},
      invoices: {
        create: async () => {
          llamadas += 1;
          return {};
        },
      },
    } as unknown as ClienteCfdiApi;

    await expect(
      timbrar(
        {
          emisor: { ...EMISOR, rfc: '' },
          receptor: RECEPTOR,
          conceptos: [
            {
              descripcion: 'Cuota',
              claveProdServ: '80131500',
              claveUnidad: 'E48',
              cantidad: 1,
              valorUnitario: '1000.00',
            },
          ],
          formaPago: '03',
          metodoPago: 'PUE',
        },
        api,
      ),
    ).rejects.toThrow(AppError);
    expect(llamadas).toBe(0);
  });

  test('timbra ingreso, emite complemento de pago, cancela validando motivo 01 y descarga XML/PDF', async () => {
    const cancelaciones: unknown[] = [];
    const api = {
      organizations: {
        create: async () => ({ id: 'org_pac_1' }),
        updateLegal: async () => ({ id: 'org_pac_1' }),
        getTestApiKey: async () => 'sk_test_org_1',
        renewLiveApiKey: async () => 'sk_live_org_1',
      },
      invoices: {
        list: async ({ external_id }: { external_id?: string }) => ({
          data: external_id === 'solo-cancelada' ? [{ id: 'inv_old', status: 'canceled', total: 100 }] : [],
        }),
        retrieve: async () => ({ status: 'canceled', cancellation_status: 'accepted' }),
        create: async (body: { type?: string }) => ({
          id: body.type === 'P' ? 'inv_pac_pago' : 'inv_pac_1',
          uuid: body.type === 'P' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
          series: 'A',
          folio_number: 101,
          subtotal: 1000,
          total: 1000,
          status: 'valid',
        }),
        cancel: async (id: string, params: unknown) => {
          cancelaciones.push({ id, params });
          return { status: 'canceled', cancellation_status: 'accepted' };
        },
        downloadXml: async () => Readable.from([Buffer.from('<cfdi:Comprobante/>')]),
        downloadPdf: async () => new Blob(['%PDF-1.4']),
      },
    } as unknown as ClienteCfdiApi;

    expect(await registrarEmisorPac(EMISOR, api)).toEqual({ pacOrgId: 'org_pac_1' });
    expect(await obtenerApiKeyOrgPac('org_pac_1', true, api)).toBe('sk_test_org_1');
    expect(await buscarFacturaPorExternalId('inexistente', api)).toBeNull();
    expect(await buscarFacturaPorExternalId('solo-cancelada', api)).toBeNull();
    expect(await consultarEstadoCancelacion('inv_pac_1', api)).toEqual({
      status: 'canceled',
      cancellationStatus: 'accepted',
    });
    expect(esRechazoDefinitivoPac({ statusCode: 400 })).toBe(true);
    expect(esRechazoDefinitivoPac({ statusCode: 502 })).toBe(false);
    expect(esRechazoDefinitivoPac({ statusCode: 429 })).toBe(false);

    const cfdi = await timbrar(
      {
        emisor: EMISOR,
        receptor: RECEPTOR,
        conceptos: [
          {
            descripcion: 'Mantenimiento Nov 2026',
            claveProdServ: '80131500',
            claveUnidad: 'E48',
            cantidad: 1,
            valorUnitario: '1000.00',
          },
        ],
        formaPago: '03',
        metodoPago: 'PUE',
        idempotencyKey: 'cfdi-pago-1',
      },
      api,
    );
    expect(cfdi).toEqual({
      pacInvoiceId: 'inv_pac_1',
      uuidCfdi: '11111111-1111-4111-8111-111111111111',
      serie: 'A',
      folio: '101',
      subtotal: '1000.00',
      total: '1000.00',
      estado: 'timbrado',
    });

    const rep = await complementoDePago(
      {
        emisor: EMISOR,
        receptor: RECEPTOR,
        formaPago: '03',
        documentosRelacionados: [{ uuid: cfdi.uuidCfdi, monto: '1000.00', saldoAnterior: '1000.00', parcialidad: 1 }],
      },
      api,
    );
    expect(rep.pacInvoiceId).toBe('inv_pac_pago');

    await expect(cancelar({ pacInvoiceId: 'inv_pac_1', motivo: '01' }, api)).rejects.toThrow(AppError);
    expect(await cancelar({ pacInvoiceId: 'inv_pac_1', motivo: '02' }, api)).toEqual({
      status: 'canceled',
      cancellationStatus: 'accepted',
    });
    expect(cancelaciones).toHaveLength(1);

    const archivos = await descargarXmlPdf('inv_pac_1', api);
    expect(Buffer.from(archivos.xml).toString('utf8')).toBe('<cfdi:Comprobante/>');
    expect(Buffer.from(archivos.pdf).toString('utf8')).toBe('%PDF-1.4');
  });
});
