import crypto from 'node:crypto';
import { AppError, Uuid } from '@admcotos/shared';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type { S3Client };

export const TIPOS_ARCHIVO_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type TipoArchivoPermitido = (typeof TIPOS_ARCHIVO_PERMITIDOS)[number];
export const MAX_BYTES_ARCHIVO = 10 * 1024 * 1024;

const EXT_POR_MIME: Record<TipoArchivoPermitido, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export interface ConfigS3 {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export type CategoriaArchivo = 'comprobantes' | 'accesos' | 'cfdi' | 'egresos' | 'tickets';

/** Crea un cliente S3-compatible (Supabase Storage S3, Cloudflare R2, MinIO). */
export function crearClienteS3(config: ConfigS3): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle ?? true,
  });
}

/** Construye una llave aislada por organización y coto sin depender del nombre original del archivo. */
export function llaveParaArchivo(
  orgId: string,
  cotoId: string,
  categoria: CategoriaArchivo,
  contentType: TipoArchivoPermitido,
): string {
  const org = Uuid.safeParse(orgId);
  const coto = Uuid.safeParse(cotoId);
  if (!org.success || !coto.success) {
    throw new AppError(422, 'parametro_invalido', 'Identificador de organización o coto inválido para archivo');
  }
  const ext = EXT_POR_MIME[contentType];
  return `${org.data.toLowerCase()}/${coto.data.toLowerCase()}/${categoria}/${crypto.randomUUID()}.${ext}`;
}

export function validarLlaveObjeto(llave: string): string {
  const limpia = llave.trim();
  if (!limpia || limpia.startsWith('/') || limpia.includes('..') || !/^[a-z0-9/_.-]{10,255}$/i.test(limpia)) {
    throw new AppError(422, 'parametro_invalido', 'Llave de archivo inválida');
  }
  return limpia;
}

export function validarContentTypePermitido(
  contentType: string,
  permitidos: readonly string[] = TIPOS_ARCHIVO_PERMITIDOS,
): TipoArchivoPermitido {
  if (!permitidos.includes(contentType) || !(contentType in EXT_POR_MIME)) {
    throw new AppError(422, 'tipo_archivo_no_permitido', 'Tipo de archivo no permitido');
  }
  return contentType as TipoArchivoPermitido;
}

/** Genera una política POST prefirmada de subida directa (caduca en 5 min por defecto). */
export async function urlDeSubida(
  s3: S3Client,
  bucket: string,
  llave: string,
  tipos: readonly string[] = TIPOS_ARCHIVO_PERMITIDOS,
  maxBytes = MAX_BYTES_ARCHIVO,
  expiresSeconds = 300,
): Promise<PresignedPost> {
  const llaveSegura = validarLlaveObjeto(llave);
  const contentType = validarContentTypePermitido(tipos[0] ?? '', tipos);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES_ARCHIVO) {
    throw new AppError(422, 'tamano_archivo_invalido', 'Tamaño máximo de archivo fuera de rango');
  }
  return createPresignedPost(s3, {
    Bucket: bucket,
    Key: llaveSegura,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: expiresSeconds,
  });
}

/** Genera una URL firmada temporal de descarga (2 min por defecto) para archivos privados. */
export async function urlDeDescarga(
  s3: S3Client,
  bucket: string,
  llave: string,
  expiresSeconds = 120,
  opciones: { nombreDescarga?: string } = {},
): Promise<string> {
  const llaveSegura = validarLlaveObjeto(llave);
  const nombre = opciones.nombreDescarga?.replace(/[^a-zA-Z0-9._-]/g, '_');
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: llaveSegura,
      ...(nombre ? { ResponseContentDisposition: `attachment; filename="${nombre}"` } : {}),
    }),
    { expiresIn: expiresSeconds },
  );
}

/** Sube directamente un objeto privado desde workers (ej. XML y PDF timbrados). */
export async function subirObjeto(
  s3: S3Client,
  bucket: string,
  llave: string,
  cuerpo: Uint8Array,
  contentType: string,
): Promise<string> {
  const llaveSegura = validarLlaveObjeto(llave);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: llaveSegura,
      Body: cuerpo,
      ContentType: contentType,
    }),
  );
  return llaveSegura;
}
