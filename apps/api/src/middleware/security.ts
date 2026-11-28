import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from '../env.ts';
import type { AppEnv } from '../types.ts';
import { problema } from './errors.ts';

/**
 * Cabeceras base y límite de cuerpo para toda la API (modern-web-guidance › security).
 * Se aplica antes de los webhooks (que además quedan fuera de CORS y de auth).
 */
export function seguridadBase(): MiddlewareHandler<AppEnv>[] {
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
    // Archivos grandes (comprobantes, CSD) van directo al storage con URL firmada, no por la API.
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => problema(c, 413, 'cuerpo_muy_grande', 'La petición es demasiado grande'),
    }),
  ];
}

/** CORS por lista blanca exacta (modern-web-guidance › validate-origins). Solo rutas autenticadas/públicas web. */
export function seguridadCors(env: Env): MiddlewareHandler<AppEnv> {
  return cors({
    origin: (origin) => (env.CORS_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-Coto-Id'],
    exposeHeaders: ['X-Request-Id'],
    credentials: false,
    maxAge: 600,
  });
}

export function seguridad(env: Env): MiddlewareHandler<AppEnv>[] {
  return [...seguridadBase(), seguridadCors(env)];
}
