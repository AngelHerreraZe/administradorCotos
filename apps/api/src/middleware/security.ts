import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from '../env.ts';
import type { AppEnv } from '../types.ts';
import { problema } from './errors.ts';

/**
 * Cabeceras para una API JSON (modern-web-guidance › security): la respuesta nunca es un
 * documento, así que CSP cierra todo; HSTS largo; CORP same-origin (las peticiones CORS
 * no se ven afectadas); sin caché salvo que la ruta lo declare (CDN + multi-tenant = fuga).
 * Autenticación por header Authorization: sin cookies, sin CSRF y sin Fetch-Metadata aquí.
 */
export function seguridad(env: Env): MiddlewareHandler<AppEnv>[] {
  return [
    secureHeaders({
      strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
      crossOriginResourcePolicy: 'same-origin',
      crossOriginOpenerPolicy: 'same-origin',
      referrerPolicy: 'no-referrer',
      xFrameOptions: 'DENY',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
    }),
    async (c, next) => {
      await next();
      if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
    },
    cors({
      origin: (origin) => (env.CORS_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-Coto-Id'],
      exposeHeaders: ['X-Request-Id'],
      credentials: false,
      maxAge: 600,
    }),
    // Archivos grandes (comprobantes, CSD) van directo al storage con URL firmada, no por la API.
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => problema(c, 413, 'cuerpo_muy_grande', 'La petición es demasiado grande'),
    }),
  ];
}
