// Se carga con `node --import` antes que cualquier otro módulo (ver apps/api/src/instrument.ts).
import { SENTRY_SIN_PII } from '@admcotos/shared';
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    dataCollection: SENTRY_SIN_PII, // LFPDPPP: sin cuerpos, headers, cookies ni datos de usuario
  });
}
