import { AppError, Monto } from '@admcotos/shared';

export * from './conekta.ts';
export * from './stripe.ts';

/** Convierte texto decimal ("1450.50") a centavos enteros sin aritmética flotante. */
export function montoACentavos(monto: string): number {
  const validado = Monto.safeParse(monto);
  if (!validado.success) {
    throw new AppError(422, 'monto_invalido', 'Monto inválido');
  }
  const [entero, dec = ''] = validado.data.split('.');
  return Number(entero) * 100 + Number(dec.padEnd(2, '0'));
}

/** Convierte centavos enteros positivos a texto decimal exacto de 2 decimales. */
export function centavosAMonto(centavos: number): string {
  if (!Number.isInteger(centavos) || centavos < 0) {
    throw new AppError(422, 'monto_invalido', 'Centavos inválidos');
  }
  const entero = Math.floor(centavos / 100);
  const dec = String(centavos % 100).padStart(2, '0');
  return `${entero}.${dec}`;
}
