import type { ClienteCfdiApi } from '@admcotos/cfdi';
import type { PrismaClient } from '@admcotos/db';
import type { ClienteConektaApi } from '@admcotos/payments';
import type { AalLevel } from '@admcotos/security';
import type {
  PayloadBilling,
  PayloadCfdi,
  PayloadCorreo,
  PayloadNotificaciones,
  PayloadPagosWebhook,
  PayloadWhatsappEntrante,
} from '@admcotos/shared';
import type { CategoriaArchivo, TipoArchivoPermitido } from '@admcotos/storage';
import type { JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import type Stripe from 'stripe';
import type { Env } from './env.ts';

export interface AuthContext {
  usuarioId: string;
  authId: string;
  aal: AalLevel;
}

export interface AuthPreRegistroContext {
  authId: string;
  aal: AalLevel;
  email: string;
}

export type EncoladorCorreo = (payload: PayloadCorreo, opts?: { jobId?: string }) => Promise<void>;
export type EncoladorPagosWebhook = (payload: PayloadPagosWebhook, opts?: { jobId?: string }) => Promise<void>;
export type EncoladorCfdi = (payload: PayloadCfdi, opts?: { jobId?: string }) => Promise<void>;
export type EncoladorBilling = (payload: PayloadBilling, opts?: { jobId?: string }) => Promise<void>;
export type EncoladorNotificaciones = (payload: PayloadNotificaciones, opts?: { jobId?: string }) => Promise<void>;
export type EncoladorWhatsappEntrante = (payload: PayloadWhatsappEntrante, opts?: { jobId?: string }) => Promise<void>;

export interface LimitadorTasa {
  consumir(clave: string, puntos: number, duracionSegundos: number, prefijo: string): Promise<void>;
}

export interface StorageService {
  llaveParaArchivo(
    orgId: string,
    cotoId: string,
    categoria: CategoriaArchivo,
    contentType: TipoArchivoPermitido,
  ): string;
  urlDeSubida(params: {
    llave: string;
    contentType: TipoArchivoPermitido;
    maxBytes?: number;
    ttlSegundos?: number;
  }): Promise<{ url: string; fields: Record<string, string>; expiraEnSegundos: number; llave: string }>;
  urlDeDescarga(params: {
    llave: string;
    ttlSegundos?: number;
    nombreDescarga?: string;
  }): Promise<{ url: string; expiraEnSegundos: number }>;
}

export interface ConektaDeps {
  cliente: ClienteConektaApi;
  webhookPublicKeyPem?: string;
}

export interface StripeDeps {
  cliente: Stripe;
  webhookSecret?: string;
}

/** Dependencias explícitas: las rutas las reciben por parámetro (fácil de probar, sin singletons). */
export interface Deps {
  env: Env;
  prisma: PrismaClient;
  log: Logger;
  jwks: JWTVerifyGetKey;
  limitador: LimitadorTasa;
  encolarCorreo: EncoladorCorreo;
  encolarPagosWebhook?: EncoladorPagosWebhook;
  encolarCfdi?: EncoladorCfdi;
  encolarBilling?: EncoladorBilling;
  encolarNotificaciones?: EncoladorNotificaciones;
  encolarWhatsappEntrante?: EncoladorWhatsappEntrante;
  storage?: StorageService;
  conekta?: ConektaDeps;
  cfdi?: ClienteCfdiApi;
  stripe?: StripeDeps;
}

/** Variables de contexto de Hono disponibles en cada petición. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    auth: AuthContext;
    authPre: AuthPreRegistroContext;
  };
}
