import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { expect, test } from 'vitest';

test('rendimiento SQL F2 (PGlite): generación mensual de 300 cotos × 50 unidades en < 60 s e idempotente', async () => {
  const db = new PGlite({ extensions: { pgcrypto, citext, btree_gist, uuid_ossp } });
  const migraciones = new URL('../prisma/migrations/', import.meta.url);
  for (const dir of readdirSync(migraciones)
    .filter((d) => /^\d+_/.test(d))
    .sort()) {
    await db.exec(readFileSync(new URL(`${dir}/migration.sql`, migraciones), 'utf8'));
  }

  const orgId = crypto.randomUUID();
  await db.query(
    `INSERT INTO organizaciones (id, nombre, slug, email_contacto) VALUES ($1, 'Despacho Escala', 'escala', 'e@t.mx')`,
    [orgId],
  );

  // Poblar 300 cotos × 50 unidades = 15,000 unidades + 300 conceptos recurrentes
  await db.exec(`
    WITH cs AS (
      INSERT INTO cotos (org_id, nombre, slug, dia_corte, dia_limite_pago)
      SELECT '${orgId}'::uuid, 'Coto ' || g, 'coto-' || g, 1, 10
        FROM generate_series(1, 300) g
      RETURNING id
    ),
    cc AS (
      INSERT INTO conceptos_cargo (coto_id, nombre, tipo, monto_default, es_recurrente, activo)
      SELECT cs.id, 'Mantenimiento', 'ordinario', 1200.00, true, true FROM cs
      RETURNING id, coto_id
    )
    INSERT INTO unidades (coto_id, numero, activo)
    SELECT cs.id, 'U-' || n, true
      FROM cs CROSS JOIN generate_series(1, 50) n;
  `);

  const pares = (
    await db.query<{ coto_id: string; concepto_id: string }>(`SELECT coto_id, id AS concepto_id FROM conceptos_cargo`)
  ).rows;
  expect(pares).toHaveLength(300);

  const t0 = performance.now();
  let creados = 0;
  for (const par of pares) {
    const r = await db.query<{ creados: number }>(
      `SELECT app.generar_cargos($1::uuid, $2::uuid, '2026-11') AS creados`,
      [par.coto_id, par.concepto_id],
    );
    creados += r.rows[0]?.creados ?? 0;
  }
  const duracionMs = performance.now() - t0;

  expect(creados).toBe(15_000);
  expect(duracionMs).toBeLessThan(60_000);

  // Re-ejecutar es 100% idempotente
  const dup = await db.query<{ creados: number }>(
    `SELECT app.generar_cargos($1::uuid, $2::uuid, '2026-11') AS creados`,
    [pares[0]?.coto_id, pares[0]?.concepto_id],
  );
  expect(dup.rows[0]?.creados).toBe(0);
}, 90_000);
