import { z } from '@hono/zod-openapi';

export const CotoParam = z.object({
  cotoId: z.uuid().openapi({ param: { name: 'cotoId', in: 'path' } }),
});

export const Coto = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    nombre: z.string(),
    slug: z.string(),
    zonaHoraria: z.string(),
    direccion: z.string().nullable(),
    colonia: z.string().nullable(),
    ciudad: z.string().nullable(),
    estado: z.string().nullable(),
    cp: z.string().nullable(),
    tipo: z.string(),
    regimenLegal: z.string().nullable(),
    diaCorte: z.number().int(),
    diaLimitePago: z.number().int(),
    tasaMoratoria: z.string(),
    tipoMoratoria: z.string(),
    baseMoratoria: z.enum(['capital', 'saldo']),
    descuentoProntoPago: z.string(),
    diasGracia: z.number().int(),
    bloquearAmenidadesMorosos: z.boolean(),
    mesesMorosidadBloqueo: z.number().int(),
    rfcCoto: z.string().nullable(),
    razonSocialCoto: z.string().nullable(),
    regimenFiscal: z.string().nullable(),
    cpFiscal: z.string().nullable(),
    activo: z.boolean(),
  })
  .openapi('Coto');

export const ActualizarCoto = z
  .object({
    nombre: z.string().trim().min(1).max(200).optional(),
    zonaHoraria: z.string().trim().min(3).max(50).optional(),
    direccion: z.string().trim().max(500).nullable().optional(),
    colonia: z.string().trim().max(200).nullable().optional(),
    ciudad: z.string().trim().max(100).nullable().optional(),
    estado: z.string().trim().max(100).nullable().optional(),
    cp: z
      .string()
      .regex(/^\d{5}$/)
      .nullable()
      .optional(),
    tipo: z.enum(['coto', 'torre', 'fraccionamiento', 'parque_industrial', 'plaza']).optional(),
    regimenLegal: z.string().trim().max(50).nullable().optional(),
    diaCorte: z.number().int().min(1).max(28).optional(),
    diaLimitePago: z.number().int().min(1).max(28).optional(),
    tasaMoratoria: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .optional(),
    tipoMoratoria: z.enum(['ninguno', 'porcentaje', 'fijo']).optional(),
    baseMoratoria: z.enum(['capital', 'saldo']).optional(),
    descuentoProntoPago: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .optional(),
    diasGracia: z.number().int().min(0).max(60).optional(),
    bloquearAmenidadesMorosos: z.boolean().optional(),
    mesesMorosidadBloqueo: z.number().int().min(1).max(24).optional(),
    rfcCoto: z.string().trim().min(12).max(13).nullable().optional(),
    razonSocialCoto: z.string().trim().max(300).nullable().optional(),
    regimenFiscal: z.string().trim().max(5).nullable().optional(),
    cpFiscal: z
      .string()
      .regex(/^\d{5}$/)
      .nullable()
      .optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .openapi('ActualizarCoto');
