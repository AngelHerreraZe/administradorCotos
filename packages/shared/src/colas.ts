import { z } from 'zod';

export const Colas = {
  correo: z.object({
    plantilla: z.enum(['invitacion', 'recibo', 'aviso']),
    para: z.email(),
    datos: z.record(z.string(), z.string()),
  }),
} as const;

export type Cola = keyof typeof Colas;
export type PayloadCorreo = z.infer<typeof Colas.correo>;

export const OPCIONES_JOB_CORREO = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 3_600 },
} as const;
