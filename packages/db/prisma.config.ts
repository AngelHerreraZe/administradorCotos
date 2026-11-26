import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no carga .env por sí mismo; Node sí, sin dependencias.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Solo el CLI (migraciones) usa esta URL: rol dueño de las tablas, conexión directa (sin PgBouncer).
// En runtime la API y los workers conectan por el adapter con su propio rol (src/client.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DIRECT_DATABASE_URL ?? '' },
});
