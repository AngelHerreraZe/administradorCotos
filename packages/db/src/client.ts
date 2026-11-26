import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export interface DbOptions {
  /** API: DATABASE_URL (app_service). Workers: WORKER_DATABASE_URL (app_worker). Nunca el rol dueño. */
  url: string;
  /** Nombre visible en pg_stat_activity: identifica qué servicio abrió la conexión. */
  applicationName: string;
  /** Conexiones por proceso. Con PgBouncer (transaction mode, ≥1.21) mantén esto bajo. */
  max?: number;
}

/** Un cliente por proceso. Los timeouts de consulta los fija el rol en la BD (migración seguridad_rls). */
export function createPrisma({ url, applicationName, max = 10 }: DbOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: url,
    application_name: applicationName,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}
