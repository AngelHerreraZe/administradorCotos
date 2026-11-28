import { z } from '@hono/zod-openapi';

const RfcRegex = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const CpRegex = /^\d{5}$/;
const RegimenRegex = /^\d{3}$/;

export const CotoParam = z.object({ cotoId: z.uuid() });
export const TimbrarParam = z.object({ cotoId: z.uuid(), pagoId: z.uuid() });
export const FacturaParam = z.object({ id: z.uuid() });

export const ConfigurarCfdiCoto = z
  .object({
    rfcCoto: z.string().trim().regex(RfcRegex, 'RFC inválido'),
    razonSocialCoto: z.string().trim().min(2).max(300),
    regimenFiscal: z.string().trim().regex(RegimenRegex, 'Régimen fiscal SAT inválido (3 dígitos)'),
    cpFiscal: z.string().trim().regex(CpRegex, 'Código postal fiscal inválido (5 dígitos)'),
  })
  .openapi('ConfigurarCfdiCoto');

export const SolicitarTimbrado = z
  .object({
    rfc: z.string().trim().min(12).max(13),
    nombre: z.string().trim().min(1).max(300),
    regimenFiscal: z.string().trim().regex(RegimenRegex, 'Régimen fiscal SAT inválido (3 dígitos)'),
    cpFiscal: z.string().trim().regex(CpRegex, 'Código postal fiscal inválido (5 dígitos)'),
    usoCfdi: z.string().trim().min(3).max(5).default('G03'),
    email: z.email().optional(),
  })
  .openapi('SolicitarTimbrado');

export const CancelarFactura = z
  .object({
    motivo: z.enum(['01', '02', '03', '04']),
    sustitucionUuid: z.uuid().optional(),
  })
  .refine((v) => (v.motivo !== '01' && v.motivo !== '04') || Boolean(v.sustitucionUuid), {
    message: 'Los motivos 01 y 04 requieren UUID de factura sustituta',
    path: ['sustitucionUuid'],
  })
  .openapi('CancelarFactura');

export const FacturaCfdiDto = z
  .object({
    id: z.uuid(),
    cotoId: z.uuid(),
    pagoId: z.uuid().nullable(),
    pacInvoiceId: z.string().nullable(),
    tipoComprobante: z.enum(['I', 'P']),
    uuidCfdi: z.string().nullable(),
    serie: z.string().nullable(),
    folio: z.string().nullable(),
    emisorRfc: z.string(),
    emisorNombre: z.string(),
    receptorRfc: z.string(),
    receptorNombre: z.string(),
    subtotal: z.string(),
    total: z.string(),
    estado: z.enum(['pendiente', 'timbrado', 'pendiente_cancelacion', 'cancelado', 'fallido']),
    motivoCancelacion: z.string().nullable(),
    sustitucionUuid: z.string().nullable(),
    canceladoEn: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('FacturaCfdi');
