import { crearClienteCfdi } from '@admcotos/cfdi';
import { crearClienteConekta, crearClienteStripe } from '@admcotos/payments';
import { crearClienteS3, llaveParaArchivo, MAX_BYTES_ARCHIVO, urlDeDescarga, urlDeSubida } from '@admcotos/storage';
import type { Env } from '../env.ts';
import type { ConektaDeps, Deps, StorageService, StripeDeps } from '../types.ts';

export function crearAdaptadoresExternos(env: Env): Pick<Deps, 'storage' | 'conekta' | 'cfdi' | 'stripe'> {
  let storage: StorageService | undefined;
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    const s3 = crearClienteS3({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
    const bucket = env.S3_BUCKET;
    storage = {
      llaveParaArchivo,
      async urlDeSubida({ llave, contentType, maxBytes = MAX_BYTES_ARCHIVO, ttlSegundos = 300 }) {
        const post = await urlDeSubida(s3, bucket, llave, [contentType], maxBytes, ttlSegundos);
        return { url: post.url, fields: post.fields, expiraEnSegundos: ttlSegundos, llave };
      },
      async urlDeDescarga({ llave, ttlSegundos = 120, nombreDescarga }) {
        const url = await urlDeDescarga(s3, bucket, llave, ttlSegundos, nombreDescarga ? { nombreDescarga } : {});
        return { url, expiraEnSegundos: ttlSegundos };
      },
    };
  }

  let conekta: ConektaDeps | undefined;
  if (env.CONEKTA_API_KEY) {
    const pem = env.CONEKTA_WEBHOOK_PUBLIC_KEY_PEM?.replace(/\\n/g, '\n');
    conekta = {
      cliente: crearClienteConekta(env.CONEKTA_API_KEY, env.CONEKTA_API_VERSION),
      ...(pem ? { webhookPublicKeyPem: pem } : {}),
    };
  }

  const cfdi = env.FACTURAPI_API_KEY ? crearClienteCfdi(env.FACTURAPI_API_KEY) : undefined;

  let stripe: StripeDeps | undefined;
  if (env.STRIPE_SECRET_KEY) {
    stripe = {
      cliente: crearClienteStripe(env.STRIPE_SECRET_KEY),
      ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
    };
  }

  return {
    ...(storage ? { storage } : {}),
    ...(conekta ? { conekta } : {}),
    ...(cfdi ? { cfdi } : {}),
    ...(stripe ? { stripe } : {}),
  };
}
