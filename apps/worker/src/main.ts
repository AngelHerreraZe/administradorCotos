import { crearClienteIa } from '@admcotos/ai';
import { crearClienteCfdi } from '@admcotos/cfdi';
import { assertRestrictedRole, createPrisma } from '@admcotos/db';
import { crearClienteConekta, crearClienteStripe } from '@admcotos/payments';
import { keyringFromEnv } from '@admcotos/security';
import { OPCIONES_JOB_CORREO, type PayloadCorreo } from '@admcotos/shared';
import { crearClienteS3, subirObjeto } from '@admcotos/storage';
import { EvolutionApiClient } from '@admcotos/whatsapp';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadEnv } from './env.ts';
import { iniciarAuditoria } from './processors/auditoria.ts';
import { iniciarAutopay } from './processors/autopay.ts';
import { iniciarBilling } from './processors/billing.ts';
import { iniciarBot } from './processors/bot.ts';
import { iniciarCfdi } from './processors/cfdi.ts';
import { iniciarCorreo } from './processors/correo.ts';
import { iniciarFinanzas } from './processors/finanzas.ts';
import { iniciarGobernanza } from './processors/gobernanza.ts';
import { iniciarNotificaciones } from './processors/notificaciones.ts';
import { iniciarPagosWebhook } from './processors/pagos-webhook.ts';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, base: { service: 'worker', colas: env.WORKER_QUEUES } });
const prisma = createPrisma({
  url: env.WORKER_DATABASE_URL,
  applicationName: `worker:${env.WORKER_QUEUES.join('+')}`,
  max: 10,
});
// BullMQ exige maxRetriesPerRequest: null en conexiones de workers (comandos bloqueantes).
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const cerrables: { close(): Promise<void> }[] = [];
const requiereProductorCorreo = ['pagosWebhook', 'autopay', 'notificaciones'].some((q) =>
  env.WORKER_QUEUES.includes(q as (typeof env.WORKER_QUEUES)[number]),
);
const evolution =
  env.EVOLUTION_URL && env.EVOLUTION_API_KEY
    ? new EvolutionApiClient(env.EVOLUTION_URL, env.EVOLUTION_API_KEY)
    : undefined;
const colaCorreo = requiereProductorCorreo ? new Queue('correo', { connection }) : undefined;
if (colaCorreo) cerrables.push(colaCorreo);

const encolarCorreo = colaCorreo
  ? async (payload: PayloadCorreo, opts?: { jobId?: string }) => {
      await colaCorreo.add('correo', payload, {
        ...OPCIONES_JOB_CORREO,
        ...(opts?.jobId ? { jobId: opts.jobId } : {}),
      });
    }
  : undefined;

if (env.WORKER_QUEUES.includes('auditoria') && env.AUDIT_LOG_HMAC_SECRET) {
  const { queue, worker } = await iniciarAuditoria({ prisma, connection, log, hmacSecret: env.AUDIT_LOG_HMAC_SECRET });
  cerrables.push(worker, queue);
}
if (env.WORKER_QUEUES.includes('correo') && env.RESEND_API_KEY && env.EMAIL_FROM) {
  const { worker } = iniciarCorreo({
    connection,
    log,
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM,
  });
  cerrables.push(worker);
}
if (env.WORKER_QUEUES.includes('finanzas')) {
  const { queue, worker } = await iniciarFinanzas({ prisma, connection, log });
  cerrables.push(worker, queue);
}
if (env.WORKER_QUEUES.includes('pagosWebhook')) {
  const { worker } = iniciarPagosWebhook({
    prisma,
    connection,
    log,
    ...(encolarCorreo ? { encolarCorreo } : {}),
  });
  cerrables.push(worker);
}
if (env.WORKER_QUEUES.includes('autopay') && env.CONEKTA_API_KEY) {
  const { queue, worker } = await iniciarAutopay({
    prisma,
    connection,
    conekta: crearClienteConekta(env.CONEKTA_API_KEY, env.CONEKTA_API_VERSION),
    log,
    ...(encolarCorreo ? { encolarCorreo } : {}),
  });
  cerrables.push(worker, queue);
}
if (
  env.WORKER_QUEUES.includes('cfdi') &&
  env.FACTURAPI_API_KEY &&
  env.MASTER_KEKS &&
  env.S3_ENDPOINT &&
  env.S3_BUCKET &&
  env.S3_ACCESS_KEY_ID &&
  env.S3_SECRET_ACCESS_KEY
) {
  const { queue, worker } = iniciarCfdi({
    prisma,
    connection,
    redis: connection,
    cfdiMaestro: crearClienteCfdi(env.FACTURAPI_API_KEY),
    cfdiTestMode: env.FACTURAPI_TEST_MODE,
    keyring: keyringFromEnv(env.MASTER_KEKS),
    crearClientePorOrg: crearClienteCfdi,
    s3: crearClienteS3({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    }),
    bucket: env.S3_BUCKET,
    log,
  });
  cerrables.push(worker, queue);
}
if (env.WORKER_QUEUES.includes('billing') && env.STRIPE_SECRET_KEY) {
  const { queue, worker } = await iniciarBilling({
    prisma,
    connection,
    stripe: crearClienteStripe(env.STRIPE_SECRET_KEY),
    meterEventName: env.STRIPE_METER_EVENT_NAME,
    log,
  });
  cerrables.push(worker, queue);
}

if (env.WORKER_QUEUES.includes('notificaciones')) {
  const { queue, worker } = iniciarNotificaciones({
    prisma,
    connection,
    redis: connection,
    log,
    ...(encolarCorreo ? { encolarCorreo } : {}),
    ...(evolution ? { evolution } : {}),
  });
  cerrables.push(worker, queue);
}
if (env.WORKER_QUEUES.includes('gobernanza')) {
  const { queue, worker } = await iniciarGobernanza({ prisma, connection, log });
  cerrables.push(worker, queue);
}
if (
  env.WORKER_QUEUES.includes('whatsappEntrante') &&
  evolution &&
  env.GEMINI_API_KEY &&
  env.GEMINI_MODEL &&
  env.S3_ENDPOINT &&
  env.S3_BUCKET &&
  env.S3_ACCESS_KEY_ID &&
  env.S3_SECRET_ACCESS_KEY
) {
  // El bot actúa como el residente: exige app_service (RLS) y nunca un rol que se salte las políticas.
  await assertRestrictedRole(prisma);
  const [rol] = await prisma.$queryRaw<{ rol: string }[]>`SELECT current_user::text AS rol`;
  if (rol?.rol !== 'app_service') throw new Error('El bot debe conectarse con el rol app_service');
  const s3 = crearClienteS3({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  const bucket = env.S3_BUCKET;
  const { worker } = iniciarBot({
    prisma,
    connection,
    log,
    ia: crearClienteIa(env.GEMINI_API_KEY),
    modelo: env.GEMINI_MODEL,
    evolution,
    subir: (llave, bytes, contentType) => subirObjeto(s3, bucket, llave, bytes, contentType),
  });
  cerrables.push(worker);
}

log.info('worker listo');

// Apagado ordenado: los jobs en curso terminan; los pendientes quedan en Redis para otra réplica.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'apagando');
    setTimeout(() => process.exit(1), 30_000).unref();
    Promise.all(cerrables.map((c) => c.close()))
      .then(() => Promise.all([prisma.$disconnect(), connection.quit()]))
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
