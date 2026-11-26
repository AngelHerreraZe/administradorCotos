import { pino } from 'pino';

/** JSON estructurado a stdout. Nunca registra tokens, cuerpos ni PII (LFPDPPP). */
export function createLogger(level: string) {
  return pino({
    level,
    base: { service: 'api' },
    redact: {
      paths: ['*.authorization', '*.cookie', '*.password', '*.token', '*.secret', '*.telefono', '*.email'],
      censor: '[redactado]',
    },
  });
}
