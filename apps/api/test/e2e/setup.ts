import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRestrictedRole, createPrisma, type PrismaClient } from '@admcotos/db';
import type { PayloadCorreo } from '@admcotos/shared';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { createApp } from '../../src/app.ts';
import { loadEnv } from '../../src/env.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_DIR = path.resolve(__dirname, '../../../../packages/db');

export interface EscenarioE2E {
  app: ReturnType<typeof createApp>;
  correos: PayloadCorreo[];
  orgA: string;
  orgB: string;
  cotoA1: string;
  cotoA2: string;
  cotoB1: string;
  unidadA1: string;
  unidadA1B: string;
  unidadB1: string;
  sectorB1: string;
  usuarios: {
    ownerA: { id: string; authId: string; email: string };
    adminA1: { id: string; authId: string; email: string };
    propA1: { id: string; authId: string; email: string };
    propB1: { id: string; authId: string; email: string };
  };
  firmarJwt: (
    authId: string,
    opts?: { aal?: 'aal1' | 'aal2'; email?: string; emailVerified?: boolean },
  ) => Promise<string>;
  cerrar: () => Promise<void>;
}

const ISSUER = 'https://e2e.supabase.co/auth/v1';

export async function iniciarEscenarioE2E(): Promise<EscenarioE2E> {
  let contenedor: StartedPostgreSqlContainer | undefined;
  let directUrl = process.env.TEST_DIRECT_DATABASE_URL;
  if (!directUrl) {
    contenedor = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('administradorcotos')
      .withUsername('postgres')
      .start();
    directUrl = contenedor.getConnectionUri();
  }

  const prismaBin = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    cwd: DB_PKG_DIR,
    env: { ...process.env, DIRECT_DATABASE_URL: directUrl },
    stdio: 'pipe',
  });

  const ctxSecretHex = crypto.randomBytes(32).toString('hex');
  process.env.DB_CTX_SECRET = ctxSecretHex;
  const svcCred = crypto.randomBytes(16).toString('hex');

  const adminPrisma = createPrisma({ url: directUrl, applicationName: 'e2e-setup', max: 2 });
  await adminPrisma.$executeRaw`SELECT set_config('e2e.svc_cred', ${svcCred}, false)`;
  await adminPrisma.$executeRaw`
    DO $do$
    BEGIN
      EXECUTE format('ALTER ROLE app_service WITH LOGIN PASSWORD %L', current_setting('e2e.svc_cred'));
    END
    $do$;
  `;
  const ctxBuf = Buffer.from(ctxSecretHex, 'hex');
  await adminPrisma.$executeRaw`
    INSERT INTO app_private.ctx_secret (id, secret)
    VALUES (true, ${ctxBuf})
    ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret
  `;

  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const cotoA1 = crypto.randomUUID();
  const cotoA2 = crypto.randomUUID();
  const cotoB1 = crypto.randomUUID();
  const unidadA1 = crypto.randomUUID();
  const unidadA1B = crypto.randomUUID();
  const unidadB1 = crypto.randomUUID();
  const sectorB1 = crypto.randomUUID();

  const ownerA = { id: crypto.randomUUID(), authId: crypto.randomUUID(), email: `owner-${orgA.slice(0, 8)}@alfa.mx` };
  const adminA1 = { id: crypto.randomUUID(), authId: crypto.randomUUID(), email: `admin-${orgA.slice(0, 8)}@alfa.mx` };
  const propA1 = { id: crypto.randomUUID(), authId: crypto.randomUUID(), email: `prop-a-${orgA.slice(0, 8)}@alfa.mx` };
  const propB1 = { id: crypto.randomUUID(), authId: crypto.randomUUID(), email: `prop-b-${orgB.slice(0, 8)}@beta.mx` };

  await adminPrisma.$transaction(async (tx) => {
    await tx.organizacion.createMany({
      data: [
        { id: orgA, nombre: 'Despacho Alfa', slug: `alfa-${orgA.slice(0, 8)}`, emailContacto: 'a@alfa.mx' },
        { id: orgB, nombre: 'Despacho Beta', slug: `beta-${orgB.slice(0, 8)}`, emailContacto: 'b@beta.mx' },
      ],
    });
    await tx.coto.createMany({
      data: [
        { id: cotoA1, orgId: orgA, nombre: 'Miraflores', slug: `miraflores-${cotoA1.slice(0, 8)}` },
        { id: cotoA2, orgId: orgA, nombre: 'Altavista', slug: `altavista-${cotoA2.slice(0, 8)}` },
        { id: cotoB1, orgId: orgB, nombre: 'Cumbres', slug: `cumbres-${cotoB1.slice(0, 8)}` },
      ],
    });
    await tx.sector.create({ data: { id: sectorB1, cotoId: cotoB1, nombre: 'Sector Beta' } });
    await tx.unidad.createMany({
      data: [
        { id: unidadA1, cotoId: cotoA1, numero: '101', indiviso: '0.500000' },
        { id: unidadA1B, cotoId: cotoA1, numero: '102', indiviso: '0.500000' },
        { id: unidadB1, cotoId: cotoB1, sectorId: sectorB1, numero: 'B-1', indiviso: '1.000000' },
      ],
    });
    await tx.usuario.createMany({
      data: [ownerA, adminA1, propA1, propB1].map((u) => ({
        id: u.id,
        authId: u.authId,
        nombre: 'Prueba',
        apellidoPaterno: 'E2E',
        email: u.email,
      })),
    });
    await tx.orgMiembro.create({ data: { orgId: orgA, usuarioId: ownerA.id, rol: 'org_owner' } });
    await tx.miembroCoto.createMany({
      data: [
        { cotoId: cotoA1, usuarioId: adminA1.id, rol: 'coto_admin' },
        { cotoId: cotoA1, unidadId: unidadA1, usuarioId: propA1.id, rol: 'residente_propietario' },
        { cotoId: cotoB1, unidadId: unidadB1, usuarioId: propB1.id, rol: 'residente_propietario' },
      ],
    });
  });

  const parsedDirect = new URL(directUrl);
  const serviceUrl = `${parsedDirect.protocol}//app_service:${svcCred}@${parsedDirect.host}${parsedDirect.pathname}${parsedDirect.search}`;
  const appPrisma: PrismaClient = createPrisma({ url: serviceUrl, applicationName: 'api-e2e', max: 5 });
  await assertRestrictedRole(appPrisma);

  const pair = await generateKeyPair('ES256');
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'e2e-k1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [jwk] });

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: serviceUrl,
    DB_CTX_SECRET: ctxSecretHex,
    SUPABASE_URL: 'https://e2e.supabase.co',
    REDIS_URL: 'redis://localhost:6379',
    APP_PUBLIC_URL: 'https://app.admcotos.mx',
  });

  const correos: PayloadCorreo[] = [];
  const app = createApp({
    env,
    prisma: appPrisma,
    log: pino({ level: 'silent' }),
    jwks,
    limitador: { async consumir() {} },
    encolarCorreo: async (payload) => {
      correos.push(payload);
    },
  });

  return {
    app,
    correos,
    orgA,
    orgB,
    cotoA1,
    cotoA2,
    cotoB1,
    unidadA1,
    unidadA1B,
    unidadB1,
    sectorB1,
    usuarios: { ownerA, adminA1, propA1, propB1 },
    firmarJwt: (authId, opts = {}) =>
      new SignJWT({
        aal: opts.aal ?? 'aal1',
        ...(opts.email ? { email: opts.email } : {}),
        ...(opts.emailVerified !== undefined ? { email_verified: opts.emailVerified } : {}),
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'e2e-k1' })
        .setIssuer(ISSUER)
        .setAudience('authenticated')
        .setSubject(authId)
        .setExpirationTime('10m')
        .sign(pair.privateKey),
    cerrar: async () => {
      await appPrisma.$disconnect();
      await adminPrisma.$disconnect();
      if (contenedor) await contenedor.stop();
    },
  };
}
