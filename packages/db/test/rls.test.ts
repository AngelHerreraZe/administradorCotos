// 🔴 Aislamiento multi-tenant contra un Postgres real (PGlite, sin Docker).
// Aplica las migraciones tal cual y actúa como app_service con contexto firmado.
// Debe pasar al 100% en CI antes de cualquier deploy.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { type AalLevel, signDbContext, signPreAuthContext } from '@admcotos/security';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { test } from 'vitest';

const SECRET = crypto.randomBytes(32);
const db = new PGlite({ extensions: { pgcrypto, citext, btree_gist, uuid_ossp } });
const migraciones = new URL('../prisma/migrations/', import.meta.url);
for (const dir of readdirSync(migraciones)
  .filter((d) => /^\d+_/.test(d))
  .sort()) {
  await db.exec(readFileSync(new URL(`${dir}/migration.sql`, migraciones), 'utf8'));
}
await db.query(`INSERT INTO app_private.ctx_secret (secret) VALUES ($1)`, [SECRET]);

const id = () => crypto.randomUUID();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const dia = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const periodo = (n: number) => dia(n).slice(0, 7);

// biome-ignore lint/suspicious/noExplicitAny: filas de SQL dinámico; cada prueba afirma sus columnas
type Fila = any;

/** Ejecuta como app_service con el contexto de `user` (null = sin contexto). */
function como(
  user: string | null,
  sql: string,
  params: unknown[] = [],
  { coto = '', ctx, aal = 'aal2' }: { coto?: string; ctx?: string; aal?: AalLevel } = {},
) {
  return db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_service');
    await tx.query(`SELECT set_config('app.ctx', $1, true), set_config('app.coto_id', $2, true)`, [
      ctx ?? (user ? signDbContext(user, SECRET, { aal }) : ''),
      coto,
    ]);
    return (await tx.query<Fila>(sql, params)).rows;
  });
}
const contar = async (user: string | null, tabla: string, opts?: { coto?: string; ctx?: string; aal?: AalLevel }) =>
  (await como(user, `SELECT count(*)::int AS n FROM ${tabla}`, [], opts))[0].n;

// ─── Escenario: despacho A (cotos A1, A2) y despacho B (coto B1) ───
const ORG_A = id(),
  ORG_B = id(),
  A1 = id(),
  A2 = id(),
  B1 = id();
const u = {
  ownerA: id(),
  adminA1: id(),
  tesA1: id(),
  comiteA1: id(),
  propA1: id(),
  inqA1: id(),
  propA1b: id(),
  guardA1: id(),
  ownerB: id(),
  propB1: id(),
  soporte: id(),
};
const UA1 = id(),
  UA1B = id(),
  UA2 = id(),
  UB1 = id(),
  CONC_A1 = id(),
  CONC_B1 = id(),
  AMEN_A1 = id();

await db.exec(`
  INSERT INTO organizaciones (id, nombre, slug, email_contacto) VALUES
    ('${ORG_A}', 'Despacho Alfa', 'alfa', 'a@alfa.mx'), ('${ORG_B}', 'Despacho Beta', 'beta', 'b@beta.mx');
  INSERT INTO cotos (id, org_id, nombre, slug) VALUES
    ('${A1}', '${ORG_A}', 'Miraflores', 'miraflores'), ('${A2}', '${ORG_A}', 'Altavista', 'altavista'),
    ('${B1}', '${ORG_B}', 'Cumbres', 'cumbres');
  INSERT INTO usuarios (id, auth_id, nombre, apellido_paterno, email)
    SELECT v, gen_random_uuid(), 'N', 'P', v || '@t.mx' FROM unnest(ARRAY[${Object.values(u)
      .map((v) => `'${v}'`)
      .join(',')}]::uuid[]) v;
  INSERT INTO org_miembros (org_id, usuario_id, rol) VALUES ('${ORG_A}', '${u.ownerA}', 'org_owner'), ('${ORG_B}', '${u.ownerB}', 'org_owner');
  INSERT INTO unidades (id, coto_id, numero, indiviso) VALUES
    ('${UA1}', '${A1}', '101', 0.5), ('${UA1B}', '${A1}', '102', 0.5), ('${UA2}', '${A2}', '201', 1), ('${UB1}', '${B1}', 'B-1', 1);
  INSERT INTO miembros_coto (coto_id, unidad_id, usuario_id, rol) VALUES
    ('${A1}', NULL, '${u.adminA1}', 'coto_admin'), ('${A1}', NULL, '${u.tesA1}', 'coto_tesorero'),
    ('${A1}', NULL, '${u.comiteA1}', 'coto_comite'), ('${A1}', '${UA1}', '${u.propA1}', 'residente_propietario'),
    ('${A1}', '${UA1}', '${u.inqA1}', 'residente_inquilino'), ('${A1}', '${UA1B}', '${u.propA1b}', 'residente_propietario'),
    ('${A1}', NULL, '${u.guardA1}', 'guardia'), ('${B1}', '${UB1}', '${u.propB1}', 'residente_propietario');
  INSERT INTO conceptos_cargo (id, coto_id, nombre, tipo, monto_default) VALUES
    ('${CONC_A1}', '${A1}', 'Mantenimiento', 'ordinario', 1000), ('${CONC_B1}', '${B1}', 'Mantenimiento', 'ordinario', 900);
  INSERT INTO amenidades (id, coto_id, nombre) VALUES ('${AMEN_A1}', '${A1}', 'Palapa');
  INSERT INTO staff_plataforma (usuario_id) VALUES ('${u.soporte}');
`);
await db.query(
  `INSERT INTO cargos (coto_id, unidad_id, concepto_id, periodo, monto_original, saldo_pendiente, fecha_vencimiento)
                VALUES ($1, $2, $3, $4, 900, 900, $5)`,
  [B1, UB1, CONC_B1, periodo(0), dia(10)],
);

test('toda tabla de negocio tiene RLS activo', async () => {
  const sinRls = await db.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND relname <> '_prisma_migrations'`);
  assert.deepEqual(sinRls.rows, []);
});

test('generar_cargos: solo administración, idempotente, nunca en otro coto', async () => {
  const gen = (user: string, coto: string, conc: string, per: string, vence: string) =>
    como(user, `SELECT app.generar_cargos($1, $2, $3, NULL, $4) AS n`, [coto, conc, per, vence]).then((r) => r[0].n);
  assert.equal(await gen(u.adminA1, A1, CONC_A1, periodo(-60), dia(-60)), 2); // vencido
  assert.equal(await gen(u.adminA1, A1, CONC_A1, periodo(0), dia(10)), 2);
  assert.equal(await gen(u.adminA1, A1, CONC_A1, periodo(0), dia(10)), 0); // doble clic
  await assert.rejects(gen(u.propA1, A1, CONC_A1, periodo(-30), dia(-30)), /row-level security/);
  await assert.rejects(gen(u.adminA1, B1, CONC_B1, periodo(0), dia(10)), /Concepto no encontrado/);
});

test('sin contexto, firma falsa, expirada o con otro secreto: cero filas', async () => {
  assert.equal(await contar(null, 'cargos'), 0);
  const valida = signDbContext(u.adminA1, SECRET);
  assert.equal(await contar(null, 'cargos', { ctx: valida.slice(0, -1) + (valida.endsWith('0') ? '1' : '0') }), 0);
  assert.equal(await contar(null, 'cargos', { ctx: signDbContext(u.adminA1, SECRET, { ttlSeconds: -5 }) }), 0);
  assert.equal(await contar(null, 'cargos', { ctx: signDbContext(u.adminA1, crypto.randomBytes(32)) }), 0);
  assert.equal(await contar(null, 'cargos', { ctx: `${u.adminA1}' OR 1=1 --` }), 0);
});

test('lectura de cargos según rol (matriz §4.2 + LFPDPPP)', async () => {
  assert.equal(await contar(u.adminA1, 'cargos'), 4);
  assert.equal(await contar(u.tesA1, 'cargos'), 4);
  assert.equal(await contar(u.ownerA, 'cargos'), 4); // despacho ve sus cotos...
  assert.equal(await contar(u.ownerA, 'cargos', { coto: A2 }), 0); // ...y app.coto_id solo acota
  assert.equal(await contar(u.adminA1, 'cargos', { coto: B1 }), 0); // acotar a un coto ajeno no amplía
  assert.equal(await contar(u.ownerB, 'cargos'), 1);
  assert.equal(await contar(u.propA1, 'cargos'), 2); // solo su unidad
  assert.equal(await contar(u.propB1, 'cargos'), 1);
  for (const sinDetalle of [u.inqA1, u.comiteA1, u.guardA1, u.soporte])
    assert.equal(await contar(sinDetalle, 'cargos'), 0);
  // El comité recibe agregados, no adeudos por vecino
  const [r] = await como(u.comiteA1, `SELECT * FROM app.resumen_cotos(p_cotos => $1)`, [[A1]]);
  assert.equal(Number(r.emitido_mes), 2000);
  assert.equal(r.unidades_morosas, 2);
  assert.equal((await como(u.comiteA1, `SELECT * FROM app.morosidad($1)`, [A1])).length, 0);
  assert.equal((await como(u.tesA1, `SELECT * FROM app.morosidad($1)`, [A1])).length, 2);
  assert.equal((await como(u.propB1, `SELECT * FROM app.resumen_cotos(p_cotos => $1)`, [[A1]])).length, 0);
  assert.equal((await como(u.ownerA, `SELECT * FROM app.resumen_cotos(p_org => $1)`, [ORG_A])).length, 2);
  // Un vecino no puede averiguar si otro debe
  assert.equal((await como(u.propA1, `SELECT * FROM app.unidad_al_corriente($1)`, [UA1B])).length, 0);
  assert.equal((await como(u.propA1, `SELECT * FROM app.unidad_al_corriente($1)`, [UA1]))[0].al_corriente, false);
});

test('escrituras cruzadas y columnas protegidas', async () => {
  const insCargo = (user: string, coto: string, unidad: string, concepto: string) =>
    como(
      user,
      `INSERT INTO cargos (coto_id, unidad_id, concepto_id, periodo, monto_original, saldo_pendiente, fecha_vencimiento)
                VALUES ($1, $2, $3, $4, 10, 10, $5)`,
      [coto, unidad, concepto, periodo(0), dia(10)],
    );
  await assert.rejects(insCargo(u.adminA1, B1, UB1, CONC_B1), /row-level security/); // otro tenant
  await assert.rejects(insCargo(u.adminA1, A1, UB1, CONC_A1), /Referencia inválida/); // FK hacia otro tenant
  await assert.rejects(
    como(u.adminA1, `UPDATE cargos SET monto_original = 1 WHERE coto_id = $1`, [A1]),
    /no se puede modificar/,
  );
  await assert.rejects(
    como(u.adminA1, `UPDATE cargos SET coto_id = $1 WHERE coto_id = $2`, [A2, A1]),
    /no se puede modificar/,
  );
  await assert.rejects(como(u.adminA1, `DELETE FROM cargos`), /permission denied/);
  await assert.rejects(
    como(u.propA1, `UPDATE usuarios SET email = 'x@y.mx' WHERE id = $1`, [u.propA1]),
    /permission denied/,
  );
  await assert.rejects(como(u.ownerA, `UPDATE organizaciones SET wallet_creditos = 1e6`), /permission denied/);
  await assert.rejects(
    como(u.ownerA, `UPDATE organizaciones SET logo_url = 'javascript:alert(1)'`),
    /organizaciones_marca_ck/,
  );
  // Residente: solo comprobantes en revisión, solo de su unidad
  const pago = `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, 500, 'transferencia_manual', $3) RETURNING id`;
  assert.equal((await como(u.propA1, pago, [A1, UA1, 'en_revision'])).length, 1);
  await assert.rejects(como(u.propA1, pago, [A1, UA1, 'confirmado']), /row-level security/);
  await assert.rejects(como(u.propA1, pago, [A1, UA1B, 'en_revision']), /row-level security/);
  await assert.rejects(como(u.inqA1, pago, [A1, UA1, 'en_revision']), /row-level security/);
  // Cambiar el teléfono invalida la verificación
  await db.query(`UPDATE usuarios SET telefono = '3300000000', telefono_verificado = true WHERE id = $1`, [u.propA1]);
  await como(u.propA1, `UPDATE usuarios SET telefono = '3311111111' WHERE id = $1`, [u.propA1]);
  assert.equal(
    (await db.query<Fila>(`SELECT telefono_verificado FROM usuarios WHERE id = $1`, [u.propA1])).rows[0]
      .telefono_verificado,
    false,
  );
});

test('aplicar_pago: FIFO, saldo a favor e idempotente', async () => {
  const nuevoPago = async (monto: number) =>
    (
      await como(
        u.adminA1,
        `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, $3, 'spei', 'confirmado') RETURNING id`,
        [A1, UA1, monto],
      )
    )[0].id;
  const aplicar = (p: string) =>
    como(u.adminA1, `SELECT app.aplicar_pago($1) AS resto`, [p]).then((r) => Number(r[0].resto));
  const p1 = await nuevoPago(1500);
  assert.equal(await aplicar(p1), 0);
  assert.equal(await aplicar(p1), 0); // segunda vez no aplica nada
  const saldos = await como(
    u.adminA1,
    `SELECT saldo_pendiente::numeric AS s, estado FROM cargos WHERE unidad_id = $1 ORDER BY fecha_vencimiento`,
    [UA1],
  );
  assert.deepEqual(
    saldos.map((c) => [Number(c.s), c.estado]),
    [
      [0, 'pagado'],
      [500, 'parcial'],
    ],
  );
  assert.equal(await aplicar(await nuevoPago(2000)), 1500);
  assert.equal(
    Number((await como(u.adminA1, `SELECT saldo_a_favor FROM unidades WHERE id = $1`, [UA1]))[0].saldo_a_favor),
    1500,
  );
  // Sin permiso de UPDATE, FOR UPDATE no le devuelve el pago: no puede aplicarlo
  await assert.rejects(como(u.propA1, `SELECT app.aplicar_pago($1)`, [p1]), /Pago no encontrado/);
});

test('caseta: QR de un uso entra una vez; freno a fuerza bruta; solo guardias del coto', async () => {
  const token = crypto.randomBytes(24).toString('base64url');
  await como(
    u.inqA1,
    `INSERT INTO invitaciones_acceso (coto_id, unidad_id, creado_por, nombre_invitado, tipo, token_hash)
                       VALUES ($1, $2, $3, 'Juan Pérez López', 'unico', $4)`,
    [A1, UA1, u.inqA1, sha(token)],
  );
  const validar = (user: string, coto: string, hash: string | null, codigo: string | null = null) =>
    como(user, `SELECT * FROM app.validar_acceso($1, $2, $3)`, [coto, hash, codigo]).then((r) => r[0]);
  const ok = await validar(u.guardA1, A1, sha(token));
  assert.deepEqual([ok.autorizado, ok.invitado, ok.unidad], [true, 'Juan', '101']);
  assert.equal((await validar(u.guardA1, A1, sha(token))).autorizado, false);
  await assert.rejects(validar(u.propA1, A1, sha(token)), /Sin permiso/);
  await assert.rejects(validar(u.guardA1, B1, sha(token)), /Sin permiso/);
  assert.equal(await contar(u.propA1b, 'invitaciones_acceso'), 0); // el vecino no ve mis visitas
  assert.equal((await como(u.guardA1, `UPDATE invitaciones_acceso SET usos_actuales = 0 RETURNING id`)).length, 0); // la caseta no edita pases
  for (let i = 0; i < 20; i++) await validar(u.guardA1, A1, null, String(100000 + i));
  assert.match((await validar(u.guardA1, A1, null, '999999')).motivo, /Demasiados/);
  await assert.rejects(
    como(
      u.propA1,
      `INSERT INTO invitaciones_acceso (coto_id, unidad_id, creado_por, nombre_invitado, tipo, token_hash, codigo_numerico)
                       VALUES ($1, $2, $3, 'X', 'frecuente', $4, '123456')`,
      [A1, UA1, u.propA1, sha('perm')],
    ),
    /invitaciones_ck/,
  );
});

test('votos: uno por unidad, solo propietario, inmutables', async () => {
  const [{ id: vot }] = await como(
    u.adminA1,
    `INSERT INTO votaciones (coto_id, titulo, fecha_inicio, fecha_fin, estado)
    VALUES ($1, 'Pintura', now() - interval '1 hour', now() + interval '1 day', 'activa') RETURNING id`,
    [A1],
  );
  const [{ id: op }] = await como(
    u.adminA1,
    `INSERT INTO opciones_voto (coto_id, votacion_id, texto) VALUES ($1, $2, 'Sí') RETURNING id`,
    [A1, vot],
  );
  const votar = (user: string, unidad: string) => como(user, `SELECT app.votar($1, $2, $3)`, [vot, op, unidad]);
  await votar(u.propA1, UA1);
  await assert.rejects(votar(u.propA1, UA1), /ya votó/);
  await assert.rejects(votar(u.inqA1, UA1), /propietaria/);
  await assert.rejects(votar(u.propA1, UA1B), /propietaria/);
  await assert.rejects(votar(u.propB1, UB1), /no está abierta/);
  await assert.rejects(db.query(`UPDATE votos SET peso = 99`), /solo inserción/); // ni el dueño de la BD
});

test('amenidades: doble reservación imposible; ocupación sin nombres', async () => {
  const reservar = (user: string, unidad: string, ini: string, fin: string) =>
    como(
      user,
      `INSERT INTO reservaciones (coto_id, amenidad_id, unidad_id, usuario_id, fecha, hora_inicio, hora_fin) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [A1, AMEN_A1, unidad, user, dia(5), ini, fin],
    );
  await reservar(u.propA1, UA1, '10:00', '12:00');
  await assert.rejects(reservar(u.propA1b, UA1B, '11:00', '13:00'), /reservaciones_sin_traslape/);
  await reservar(u.propA1b, UA1B, '12:00', '14:00');
  assert.equal(await contar(u.propA1b, 'reservaciones'), 1);
  assert.equal(
    (await como(u.propA1b, `SELECT * FROM app.ocupacion_amenidad($1, $2, $3)`, [AMEN_A1, dia(0), dia(30)])).length,
    2,
  );
  assert.equal(
    (await como(u.propB1, `SELECT * FROM app.ocupacion_amenidad($1, $2, $3)`, [AMEN_A1, dia(0), dia(30)])).length,
    0,
  );
});

test('auditoría: outbox automático, invisible para la API, libro inmutable', async () => {
  const { rows } = await db.query<Fila>(
    `SELECT count(*)::int AS n FROM audit_outbox WHERE accion = 'cargos.insert' AND usuario_id = $1`,
    [u.adminA1],
  );
  assert.equal(rows[0].n, 4);
  await assert.rejects(como(u.ownerA, `SELECT * FROM audit_outbox`), /permission denied/);
  await db.query(
    `INSERT INTO audit_log (org_id, accion, recurso_tipo, hash_anterior, hash_integridad, created_at)
                  VALUES ($1, 'x', 'x', $2, $2, now())`,
    [ORG_A, '0'.repeat(64)],
  );
  await assert.rejects(db.query(`UPDATE audit_log SET accion = 'y'`), /solo inserción/);
  await assert.rejects(db.query(`DELETE FROM audit_log`), /solo inserción/);
  await assert.rejects(db.query(`TRUNCATE audit_log`), /solo inserción/);
});

test('despacho en mora: corte suave sin tocar residentes ni caseta', async () => {
  await db.query(`UPDATE organizaciones SET estado_suscripcion = 'solo_lectura' WHERE id = $1`, [ORG_A]);
  await assert.rejects(
    como(u.adminA1, `INSERT INTO sectores (coto_id, nombre) VALUES ($1, 'Torre A')`, [A1]),
    /row-level security/,
  );
  assert.equal(await contar(u.adminA1, 'cargos'), 4); // sigue leyendo
  await como(
    u.propA1,
    `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, 100, 'spei', 'en_revision')`,
    [A1, UA1],
  );
  await db.query(`UPDATE organizaciones SET estado_suscripcion = 'suspendido' WHERE id = $1`, [ORG_A]);
  assert.equal(await contar(u.ownerA, 'cargos'), 0); // portal del despacho cerrado
  assert.equal(await contar(u.propA1, 'cargos'), 2); // el residente sigue viendo y pagando
  assert.equal((await como(u.guardA1, `SELECT * FROM app.validar_acceso($1, $2)`, [A1, sha('nada')])).length, 1); // caseta opera
  await db.query(`UPDATE organizaciones SET estado_suscripcion = 'activo' WHERE id = $1`, [ORG_A]);
});

test('soporte: nada sin ventana consentida; con ventana solo lectura', async () => {
  assert.equal(await contar(u.soporte, 'cargos'), 0);
  await assert.rejects(
    como(
      u.ownerA,
      `INSERT INTO soporte_accesos (org_id, otorgado_por, ticket_ref, hasta) VALUES ($1, $2, 'T-1', now() + interval '10 days')`,
      [ORG_A, u.ownerA],
    ),
    /soporte_ventana_ck/,
  );
  await como(
    u.ownerA,
    `INSERT INTO soporte_accesos (org_id, otorgado_por, ticket_ref, hasta) VALUES ($1, $2, 'T-1', now() + interval '1 hour')`,
    [ORG_A, u.ownerA],
  );
  assert.equal(await contar(u.soporte, 'cargos'), 4);
  assert.equal(await contar(u.soporte, 'cargos', { coto: B1 }), 0);
  assert.equal((await como(u.soporte, `UPDATE cargos SET notas = 'x' RETURNING id`)).length, 0);
  await assert.rejects(como(u.soporte, `SELECT app.guardar_csd($1, '\\x01', '\\x01', '\\x01')`, [A1]), /Sin permiso/);
});

test('CSD: se escribe cifrado por función y la API jamás lo lee', async () => {
  const cifrado = Buffer.from([1, 0, 1, 9, 9]);
  await como(u.adminA1, `SELECT app.guardar_csd($1, $2, $2, $2)`, [A1, cifrado]);
  await assert.rejects(
    como(u.adminA1, `SELECT app.guardar_csd($1, $2, $2, $2)`, [A1, Buffer.from([0x30, 0x82])]),
    /coto_secretos_cifrado_ck/,
  );
  await assert.rejects(como(u.adminA1, `SELECT * FROM coto_secretos`), /permission denied/);
  await assert.rejects(como(u.propA1, `SELECT app.guardar_csd($1, $2, $2, $2)`, [A1, cifrado]), /Sin permiso/);
});

test('webhooks: la API registra eventos (idempotente) pero no lee payloads', async () => {
  const ins = `INSERT INTO webhook_events (proveedor, event_id, tipo, payload) VALUES ('conekta', 'evt_1', 'order.paid', '{}') ON CONFLICT DO NOTHING`;
  await como(null, ins);
  await como(null, ins);
  assert.equal((await db.query<Fila>(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n, 1);
  await assert.rejects(como(null, `SELECT * FROM webhook_events`), /permission denied/);
});

test('MFA (aal2) y contexto v2: firma v1 rechazada; staff sin aal2 lee pero no escribe; residente sin MFA sí paga', async () => {
  // Firma v1 (sin segmento aal) debe ser rechazada
  const exp = Math.floor(Date.now() / 1000) + 300;
  const v1Mac = crypto.createHmac('sha256', SECRET).update(`${u.adminA1}.${exp}`).digest('hex');
  assert.equal(await contar(null, 'cargos', { ctx: `${u.adminA1}.${exp}.${v1Mac}` }), 0);

  // Staff sin aal2 sí lee, pero no puede escribir en coto ni organización
  assert.equal(await contar(u.adminA1, 'cargos', { aal: 'aal1' }), 4);
  assert.equal(await contar(u.ownerA, 'cotos', { aal: 'aal1' }), 2);
  await assert.rejects(
    como(u.adminA1, `INSERT INTO sectores (coto_id, nombre) VALUES ($1, 'Privada Sin MFA')`, [A1], { aal: 'aal1' }),
    /row-level security/,
  );
  assert.equal(
    (
      await como(u.ownerA, `UPDATE organizaciones SET nombre = 'X' WHERE id = $1 RETURNING id`, [ORG_A], {
        aal: 'aal1',
      })
    ).length,
    0,
  );
  assert.equal(
    (await db.query<Fila>(`SELECT nombre FROM organizaciones WHERE id = $1`, [ORG_A])).rows[0].nombre,
    'Despacho Alfa',
  );
  await assert.rejects(
    como(u.ownerA, `INSERT INTO cotos (org_id, nombre, slug) VALUES ($1, 'SinMFA', 'sin-mfa')`, [ORG_A], {
      aal: 'aal1',
    }),
    /row-level security/,
  );

  // Si la organización desactiva exigir_mfa, staff con aal1 sí escribe
  await db.query(`UPDATE organizaciones SET exigir_mfa = false WHERE id = $1`, [ORG_A]);
  await como(u.adminA1, `INSERT INTO sectores (coto_id, nombre) VALUES ($1, 'Sin MFA Permitido')`, [A1], {
    aal: 'aal1',
  });
  await db.query(`UPDATE organizaciones SET exigir_mfa = true WHERE id = $1`, [ORG_A]);

  // Residente sin MFA (aal1) sí puede leer su unidad y registrar un comprobante de pago
  assert.equal(await contar(u.propA1, 'cargos', { aal: 'aal1' }), 2);
  assert.equal(
    (
      await como(
        u.propA1,
        `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, 250, 'transferencia_manual', 'en_revision') RETURNING id`,
        [A1, UA1],
        { aal: 'aal1' },
      )
    ).length,
    1,
  );
});

test('identidad e invitaciones: políticas RLS, pre-auth, auditoría con usuario.id real, expirada, revocada e idempotente', async () => {
  const authAdmin = (await db.query<Fila>(`SELECT auth_id FROM usuarios WHERE id = $1`, [u.adminA1])).rows[0].auth_id;
  assert.equal((await como(null, `SELECT app.usuario_por_auth($1) AS id`, [authAdmin]))[0].id, u.adminA1);
  assert.equal((await como(null, `SELECT app.usuario_por_auth($1) AS id`, [id()]))[0].id, null);

  const memProp = await como(u.propA1, `SELECT * FROM app.mis_membresias()`, [], { aal: 'aal1' });
  assert.equal(memProp.length, 1);
  assert.deepEqual(
    { coto_id: memProp[0].coto_id, rol: memProp[0].rol, unidad: memProp[0].unidad },
    { coto_id: A1, rol: 'residente_propietario', unidad: '101' },
  );

  // coto_admin no puede invitar org_owner/org_admin ni a otro coto/org
  await assert.rejects(
    como(
      u.adminA1,
      `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
       VALUES ($1, NULL, 'x@alfa.mx', 'org_owner', $2, now() + interval '1 day', $3)`,
      [ORG_A, sha('org-owner-por-coto-admin'), u.adminA1],
    ),
    /row-level security/,
  );
  await assert.rejects(
    como(
      u.adminA1,
      `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
       VALUES ($1, $2, 'x@alfa.mx', 'guardia', $3, now() + interval '1 day', $4)`,
      [ORG_B, A1, sha('cross-org'), u.adminA1],
    ),
    /Referencia inválida/,
  );

  // Invitación válida creada por adminA1
  const tokOk = 'token-inv-valido-1';
  const [{ id: invOkId }] = await como(
    u.adminA1,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, unidad_id, email, rol, token_hash, expira_en, creada_por)
     VALUES ($1, $2, $3, 'VecinoNuevo@alfa.mx', 'residente_propietario', $4, now() + interval '2 days', $5) RETURNING id`,
    [ORG_A, A1, UA1B, sha(tokOk), u.adminA1],
  );

  // M1: tg_invitacion_defaults fuerza created_at = now() para app_service (no evade CHECK de 7 días ni falsea pasado)
  await assert.rejects(
    como(
      u.adminA1,
      `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por, created_at)
       VALUES ($1, $2, 'futuro@alfa.mx', 'guardia', $3, now() + interval '400 days', $4, now() + interval '395 days')`,
      [ORG_A, A1, sha('inv-futuro'), u.adminA1],
    ),
    /invitaciones_miembro_exp_ck/,
  );
  const [{ created_at: createdAtPasado, id: invPasadoId }] = await como(
    u.adminA1,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por, created_at)
     VALUES ($1, $2, 'pasado@alfa.mx', 'guardia', $3, now() + interval '2 days', $4, now() - interval '10 days')
     RETURNING id, created_at`,
    [ORG_A, A1, sha('inv-pasado'), u.adminA1],
  );
  assert.ok(Math.abs(Date.now() - new Date(createdAtPasado).getTime()) < 60_000);
  await db.query(`DELETE FROM invitaciones_miembro WHERE id = $1`, [invPasadoId]);

  // Políticas sel y coto_activo en invitaciones_miembro
  assert.equal(await contar(u.adminA1, 'invitaciones_miembro'), 1);
  assert.equal(await contar(u.adminA1, 'invitaciones_miembro', { aal: 'aal1' }), 0); // sin MFA no ve
  assert.equal(await contar(u.adminA1, 'invitaciones_miembro', { coto: A2 }), 0); // coto_activo restringe
  assert.equal(await contar(u.propA1, 'invitaciones_miembro'), 0);
  assert.equal(await contar(u.guardA1, 'invitaciones_miembro'), 0);
  assert.equal(await contar(u.ownerB, 'invitaciones_miembro'), 0);
  // No puede forjar aceptada_en directamente
  await assert.rejects(
    como(u.adminA1, `UPDATE invitaciones_miembro SET aceptada_en = now() WHERE token_hash = $1`, [sha(tokOk)]),
    /permission denied/,
  );
  // Admin de otra organización o sin MFA no puede revocar invitación de A1
  assert.equal(
    (await como(u.ownerB, `UPDATE invitaciones_miembro SET revocada_en = now() WHERE id = $1 RETURNING id`, [invOkId]))
      .length,
    0,
  );
  assert.equal(
    (
      await como(
        u.adminA1,
        `UPDATE invitaciones_miembro SET revocada_en = now() WHERE id = $1 RETURNING id`,
        [invOkId],
        { aal: 'aal1' },
      )
    ).length,
    0,
  );

  const authNuevo = id();
  const preCtx = signPreAuthContext(authNuevo, SECRET, { aal: 'aal1' });
  // Sin contexto pre-auth firmado o con otro auth_id -> UA403
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García')`, [
      sha(tokOk),
      authNuevo,
    ]),
    /Sesión inválida/,
  );
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García')`, [sha(tokOk), id()], {
      ctx: preCtx,
    }),
    /Sesión inválida/,
  );
  // Pre-auth no permite leer tablas con RLS
  assert.equal(await contar(null, 'cargos', { ctx: preCtx }), 0);

  // Correo distinto -> UA403
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'otro@alfa.mx', 'Ana', 'García')`, [sha(tokOk), authNuevo], {
      ctx: preCtx,
    }),
    /no coincide/,
  );

  // Aceptar con correo coincidente (contexto pre-auth igual al de la API) -> crea usuario, membresía y auditoría correcta
  const uid1 = (
    await como(
      null,
      `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García') AS id`,
      [sha(tokOk), authNuevo],
      { ctx: preCtx },
    )
  )[0].id;
  assert.notEqual(uid1, authNuevo);

  // Auditoría debe registrar usuarios.id real (nunca auth_id)
  const auditAcept = await db.query<Fila>(
    `SELECT accion, usuario_id FROM audit_outbox WHERE recurso_id = $1 AND accion = 'invitaciones_miembro.update'`,
    [invOkId],
  );
  assert.equal(auditAcept.rows.length, 1);
  assert.equal(auditAcept.rows[0].usuario_id, uid1);

  // Idempotente al repetir con el mismo auth_id
  const uid2 = (
    await como(
      null,
      `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García') AS id`,
      [sha(tokOk), authNuevo],
      { ctx: preCtx },
    )
  )[0].id;
  assert.equal(uid1, uid2);

  // Ya aceptada por otro auth_id -> UA409
  const authOtro = id();
  await assert.rejects(
    como(
      null,
      `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García')`,
      [sha(tokOk), authOtro],
      { ctx: signPreAuthContext(authOtro, SECRET) },
    ),
    /ya fue utilizada/,
  );

  // Ya aceptada no puede ser revocada por RLS
  assert.equal(
    (await como(u.adminA1, `UPDATE invitaciones_miembro SET revocada_en = now() WHERE id = $1 RETURNING id`, [invOkId]))
      .length,
    0,
  );

  // Rama de despacho (coto_id IS NULL): org_owner con aal2 sí puede invitar org_admin; sin aal2 o sin ser owner no
  const tokOrg = 'token-inv-org-admin';
  await como(
    u.ownerA,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
     VALUES ($1, NULL, 'orgadmin@alfa.mx', 'org_admin', $2, now() + interval '1 day', $3)`,
    [ORG_A, sha(tokOrg), u.ownerA],
  );
  await assert.rejects(
    como(
      u.ownerA,
      `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
       VALUES ($1, NULL, 'orgadmin2@alfa.mx', 'org_admin', $2, now() + interval '1 day', $3)`,
      [ORG_A, sha('tok-org-aal1'), u.ownerA],
      { aal: 'aal1' },
    ),
    /row-level security/,
  );
  const authOrgAdmin = id();
  const orgAdminUid = (
    await como(
      null,
      `SELECT app.aceptar_invitacion($1, $2, 'orgadmin@alfa.mx', 'Carlos', 'Ruiz') AS id`,
      [sha(tokOrg), authOrgAdmin],
      { ctx: signPreAuthContext(authOrgAdmin, SECRET, { aal: 'aal2' }) },
    )
  )[0].id;
  // org_admin no puede invitar otro org_admin (solo orgs_owner)
  await assert.rejects(
    como(
      orgAdminUid,
      `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
       VALUES ($1, NULL, 'otroorg@alfa.mx', 'org_admin', $2, now() + interval '1 day', $3)`,
      [ORG_A, sha('tok-por-orgadmin'), orgAdminUid],
    ),
    /row-level security/,
  );

  // Invitación revocada -> rechazada y no se puede des-revocar
  const tokRev = 'token-inv-revocado';
  const [{ id: invRevId }] = await como(
    u.adminA1,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
     VALUES ($1, $2, 'guardia@alfa.mx', 'guardia', $3, now() + interval '2 days', $4) RETURNING id`,
    [ORG_A, A1, sha(tokRev), u.adminA1],
  );
  await como(u.adminA1, `UPDATE invitaciones_miembro SET revocada_en = now() WHERE id = $1`, [invRevId]);
  assert.equal(
    (await como(u.adminA1, `UPDATE invitaciones_miembro SET revocada_en = NULL WHERE id = $1 RETURNING id`, [invRevId]))
      .length,
    0,
  );
  const authRev = id();
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'guardia@alfa.mx', 'Luis', 'Pérez')`, [sha(tokRev), authRev], {
      ctx: signPreAuthContext(authRev, SECRET),
    }),
    /no existe o ya venció/,
  );

  // Invitación vencida -> rechazada
  const tokExp = 'token-inv-expirado';
  await db.query(
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por, created_at)
     VALUES ($1, $2, 'exp@alfa.mx', 'guardia', $3, now() - interval '1 hour', $4, now() - interval '2 days')`,
    [ORG_A, A1, sha(tokExp), u.adminA1],
  );
  const authExp = id();
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'exp@alfa.mx', 'Luis', 'Pérez')`, [sha(tokExp), authExp], {
      ctx: signPreAuthContext(authExp, SECRET),
    }),
    /no existe o ya venció/,
  );

  // Mismo correo con otro auth_id en una segunda invitación -> UA409
  const tokOtroAuth = 'token-inv-otro-auth';
  await como(
    u.adminA1,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
     VALUES ($1, $2, 'vecinonuevo@alfa.mx', 'coto_comite', $3, now() + interval '2 days', $4)`,
    [ORG_A, A1, sha(tokOtroAuth), u.adminA1],
  );
  const authDup = id();
  await assert.rejects(
    como(
      null,
      `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García')`,
      [sha(tokOtroAuth), authDup],
      { ctx: signPreAuthContext(authDup, SECRET) },
    ),
    /vinculado a otra cuenta/,
  );

  // Usuario desactivado (usuarios.activo = false) pierde acceso inmediato en BD
  await db.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [uid1]);
  assert.equal(await contar(uid1, 'cargos', { aal: 'aal1' }), 0);
  await db.query(`UPDATE usuarios SET activo = true WHERE id = $1`, [uid1]);

  // M2: LFPDPPP en BD: comité no lee otros usuarios directamente y directorio_coto oculta email/teléfono salvo finanzas
  const usuariosComite = await como(u.comiteA1, `SELECT id FROM usuarios`, [], { aal: 'aal1' });
  assert.deepEqual(
    usuariosComite.map((r) => r.id),
    [u.comiteA1],
  );
  const dirComite = await como(u.comiteA1, `SELECT * FROM app.directorio_coto($1, 20, NULL)`, [A1], { aal: 'aal1' });
  assert.ok(dirComite.length >= 6);
  for (const fila of dirComite) {
    assert.equal(fila.email, null);
    assert.equal(fila.telefono, null);
  }
  const dirFinanzas = await como(u.tesA1, `SELECT * FROM app.directorio_coto($1, 20, NULL)`, [A1], { aal: 'aal1' });
  assert.ok(dirFinanzas.some((fila) => typeof fila.email === 'string' && fila.email.includes('@')));

  // Paginación por cursor e invariante coto_activo + rechazo a no-staff
  const pag1 = await como(u.adminA1, `SELECT * FROM app.directorio_coto($1, 2, NULL)`, [A1]);
  assert.equal(pag1.length, 3);
  const pag2 = await como(u.adminA1, `SELECT * FROM app.directorio_coto($1, 2, $2)`, [A1, pag1[1].id]);
  assert.ok(pag2.length >= 1);
  assert.equal(pag2[0].id, pag1[2].id);

  assert.equal(
    (await como(u.adminA1, `SELECT * FROM app.directorio_coto($1, 20, NULL)`, [A1], { coto: A2 })).length,
    0,
  );
  await assert.rejects(como(u.propA1, `SELECT * FROM app.directorio_coto($1, 20, NULL)`, [A1]), /Sin permiso/);
  await assert.rejects(como(u.guardA1, `SELECT * FROM app.directorio_coto($1, 20, NULL)`, [A1]), /Sin permiso/);
  await assert.rejects(como(u.ownerB, `SELECT * FROM app.directorio_coto($1, 20, NULL)`, [A1]), /Sin permiso/);
});

test('finanzas F2: moratorios idempotentes, saldo a favor FIFO, rechazo de pago, condonación y segregación en egresos', async () => {
  // 1. Moratorios: cargo vencido hace 15 días en A1 (días_gracia=0, porcentaje 10%)
  await db.query(`UPDATE cotos SET tipo_moratoria = 'porcentaje', tasa_moratoria = 10, dias_gracia = 0 WHERE id = $1`, [
    A1,
  ]);
  const cVencidoId = id();
  await db.query(
    `INSERT INTO cargos (id, coto_id, unidad_id, concepto_id, periodo, monto_original, saldo_pendiente, fecha_vencimiento)
     VALUES ($1, $2, $3, $4, '2026-01', 1000.00, 1000.00, '2026-01-10')`,
    [cVencidoId, A1, UA1B, CONC_A1],
  );

  // app_service no puede insertar directo en moratorios_aplicados ni llamar aplicar_moratorios
  await assert.rejects(como(u.adminA1, `SELECT app.aplicar_moratorios($1, '2026-01-25')`, [A1]), /permission denied/);
  await assert.rejects(
    como(
      u.adminA1,
      `INSERT INTO moratorios_aplicados (cargo_id, coto_id, unidad_id, periodo, fecha_corte, monto)
       VALUES ($1, $2, $3, '2026-01', '2026-01-25', 50)`,
      [cVencidoId, A1, UA1B],
    ),
    /permission denied/,
  );

  // Worker aplica moratorio una vez -> +100.00; repetir en el mismo mes es no-op
  const aplica1 = await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_worker');
    return (await tx.query<Fila>(`SELECT app.aplicar_moratorios($1, '2026-01-25'::date) AS n`, [A1])).rows[0].n;
  });
  assert.equal(aplica1, 1);
  const aplica2 = await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_worker');
    return (await tx.query<Fila>(`SELECT app.aplicar_moratorios($1, '2026-01-26'::date) AS n`, [A1])).rows[0].n;
  });
  assert.equal(aplica2, 0);

  const cargoMor = (
    await db.query<Fila>(`SELECT monto_moratoria, saldo_pendiente FROM cargos WHERE id = $1`, [cVencidoId])
  ).rows[0];
  assert.equal(cargoMor.monto_moratoria, '100.00');
  assert.equal(cargoMor.saldo_pendiente, '1100.00');

  // RLS en moratorios_aplicados: comité ve 0, propietario de UA1B ve 1, propietario de UA1 ve 0
  assert.equal(await contar(u.comiteA1, 'moratorios_aplicados'), 0);
  assert.equal(await contar(u.propA1, 'moratorios_aplicados'), 0);
  assert.equal(await contar(u.propA1b, 'moratorios_aplicados'), 1);

  // Solo inserción bloquea modificar moratorios_aplicados
  await assert.rejects(
    db.query(`UPDATE moratorios_aplicados SET monto = 1 WHERE cargo_id = $1`, [cVencidoId]),
    /solo inserción/,
  );

  // 2. Saldo a favor FIFO
  await db.query(`UPDATE unidades SET saldo_a_favor = 400.00 WHERE id = $1`, [UA1B]);
  const aplicadoSaldo = await como(u.adminA1, `SELECT app.aplicar_saldo_a_favor($1) AS aplicado`, [UA1B]);
  assert.equal(aplicadoSaldo[0].aplicado, '400.00');
  const cargoTrasSaldo = (
    await db.query<Fila>(`SELECT saldo_pendiente, estado FROM cargos WHERE id = $1`, [cVencidoId])
  ).rows[0];
  assert.equal(cargoTrasSaldo.saldo_pendiente, '700.00');
  assert.equal(cargoTrasSaldo.estado, 'parcial');

  // 3. Clave de rastreo única por coto + rechazar_pago
  const pagoRev = (
    await como(
      u.propA1,
      `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, estado, clave_rastreo)
       VALUES ($1, $2, 500, 'transferencia_manual', 'en_revision', 'SPEI-ABC-999') RETURNING id`,
      [A1, UA1],
      { aal: 'aal1' },
    )
  )[0].id;
  await assert.rejects(
    como(
      u.propA1b,
      `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, estado, clave_rastreo)
       VALUES ($1, $2, 500, 'transferencia_manual', 'en_revision', 'SPEI-ABC-999')`,
      [A1, UA1B],
      { aal: 'aal1' },
    ),
    /pagos_coto_clave_rastreo_key/,
  );
  // Residente no puede rechazar
  await assert.rejects(
    como(u.propA1, `SELECT app.rechazar_pago($1, 'No procede')`, [pagoRev], { aal: 'aal1' }),
    /Sin permiso/,
  );
  await como(u.adminA1, `SELECT app.rechazar_pago($1, 'Comprobante ilegible')`, [pagoRev]);
  const pagoRech = (await db.query<Fila>(`SELECT estado, motivo_rechazo FROM pagos WHERE id = $1`, [pagoRev])).rows[0];
  assert.equal(pagoRech.estado, 'rechazado');
  assert.equal(pagoRech.motivo_rechazo, 'Comprobante ilegible');

  // Rechazar pago ya rechazado falla con UA409
  await assert.rejects(como(u.adminA1, `SELECT app.rechazar_pago($1, 'Otro')`, [pagoRev]), /pendientes o en revisión/);

  // Inmutabilidad condicional en gateway_charge_id (NULL -> non-NULL permitido; cambiar después bloqueado)
  const pagoOnlineId = id();
  await db.query(
    `INSERT INTO pagos (id, coto_id, unidad_id, monto, metodo, gateway, gateway_order_id, estado)
     VALUES ($1, $2, $3, 300, 'spei', 'conekta', 'ord_test_1', 'pendiente')`,
    [pagoOnlineId, A1, UA1],
  );
  await db.query(`UPDATE pagos SET gateway_charge_id = 'chg_test_1', estado = 'confirmado' WHERE id = $1`, [
    pagoOnlineId,
  ]);
  await assert.rejects(
    db.query(`UPDATE pagos SET gateway_charge_id = 'chg_test_2' WHERE id = $1`, [pagoOnlineId]),
    /gateway_charge_id de pagos no se puede modificar/,
  );

  // 4. Condonar cargo
  await assert.rejects(como(u.adminA1, `SELECT app.condonar_cargo($1, '  ')`, [cVencidoId]), /motivo/);
  await assert.rejects(como(u.propA1b, `SELECT app.condonar_cargo($1, 'Por favor')`, [cVencidoId]), /Sin permiso/);
  await como(u.adminA1, `SELECT app.condonar_cargo($1, 'Acuerdo asamblea')`, [cVencidoId]);
  const condonado = (
    await db.query<Fila>(`SELECT estado, saldo_pendiente, monto_descuento, notas FROM cargos WHERE id = $1`, [
      cVencidoId,
    ])
  ).rows[0];
  assert.equal(condonado.estado, 'condonado');
  assert.equal(condonado.saldo_pendiente, '0.00');
  assert.equal(condonado.monto_descuento, '700.00');
  assert.match(condonado.notas, /\[CONDONADO\] Acuerdo asamblea/);

  // Saldo a favor dejó rastro en aplicaciones_saldo_favor (solo lectura API, inmutable)
  assert.equal(await contar(u.comiteA1, 'aplicaciones_saldo_favor'), 0);
  assert.equal(await contar(u.propA1b, 'aplicaciones_saldo_favor'), 1);
  await assert.rejects(
    db.query(`UPDATE aplicaciones_saldo_favor SET monto_aplicado = 1 WHERE cargo_id = $1`, [cVencidoId]),
    /solo inserción/,
  );

  // Moratoria simple (capital) vs compuesta (saldo) según cotos.base_moratoria
  const cMor2 = id();
  await db.query(
    `INSERT INTO cargos (id, coto_id, unidad_id, concepto_id, periodo, monto_original, monto_moratoria, saldo_pendiente, fecha_vencimiento)
     VALUES ($1, $2, $3, $4, '2025-11', 1000.00, 100.00, 1100.00, '2025-11-10')`,
    [cMor2, A1, UA1, CONC_A1],
  );
  await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_worker');
    await tx.query(`SELECT app.aplicar_moratorios($1, '2025-12-01'::date)`, [A1]);
  });
  const mSimple = (await db.query<Fila>(`SELECT monto_moratoria FROM cargos WHERE id = $1`, [cMor2])).rows[0];
  assert.equal(mSimple.monto_moratoria, '200.00'); // 10% sobre 1000 capital = +100

  await db.query(`UPDATE cotos SET base_moratoria = 'saldo' WHERE id = $1`, [A1]);
  await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_worker');
    await tx.query(`SELECT app.aplicar_moratorios($1, '2026-01-01'::date)`, [A1]);
  });
  const mCompuesto = (await db.query<Fila>(`SELECT monto_moratoria FROM cargos WHERE id = $1`, [cMor2])).rows[0];
  assert.equal(mCompuesto.monto_moratoria, '320.00'); // 10% sobre 1200 saldo = +120

  // 5. Egresos: segregación de funciones y bloqueo directo en Postgres (pendiente y post-aprobación)
  await assert.rejects(
    como(u.comiteA1, `INSERT INTO egresos (coto_id, concepto, monto) VALUES ($1, 'Jardín', 200)`, [A1]),
    /row-level security/,
  );
  const egresoId = (
    await como(
      u.tesA1,
      `INSERT INTO egresos (coto_id, concepto, monto, estado, aprobado_por) VALUES ($1, 'Bomba de agua', 1500, 'aprobado', $2) RETURNING id`,
      [A1, u.adminA1],
    )
  )[0].id;
  // Trigger debe haber forzado estado = pendiente, solicitado_por = tesA1, aprobado_por = null
  const egrInicial = (
    await db.query<Fila>(`SELECT estado, solicitado_por, aprobado_por FROM egresos WHERE id = $1`, [egresoId])
  ).rows[0];
  assert.equal(egrInicial.estado, 'pendiente');
  assert.equal(egrInicial.solicitado_por, u.tesA1);
  assert.equal(egrInicial.aprobado_por, null);

  // Solicitante no puede saltarse app.aprobar_egreso con UPDATE directo (tampoco fijando app.egreso_fn)
  await assert.rejects(
    como(u.tesA1, `UPDATE egresos SET estado = 'aprobado', aprobado_por = $2 WHERE id = $1`, [egresoId, u.adminA1]),
    /dictamen de egresos/,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_service');
      await tx.query(`SELECT set_config('app.ctx', $1, true), set_config('app.egreso_fn', '1', true)`, [
        signDbContext(u.tesA1, SECRET, { aal: 'aal2' }),
      ]);
      await tx.query(`UPDATE egresos SET estado = 'aprobado', aprobado_por = $2 WHERE id = $1`, [egresoId, u.adminA1]);
    }),
    /dictamen de egresos/,
  );
  await assert.rejects(
    como(u.tesA1, `SELECT app.aprobar_egreso($1)`, [egresoId]),
    /Quien solicita un egreso no puede aprobarlo/,
  );
  await assert.rejects(como(u.comiteA1, `SELECT app.aprobar_egreso($1)`, [egresoId]), /Sin permiso de tesorería/);
  await como(u.adminA1, `SELECT app.aprobar_egreso($1)`, [egresoId]);
  const egrAprobado = (await db.query<Fila>(`SELECT estado, aprobado_por FROM egresos WHERE id = $1`, [egresoId]))
    .rows[0];
  assert.equal(egrAprobado.estado, 'aprobado');
  assert.equal(egrAprobado.aprobado_por, u.adminA1);

  // Post-aprobación: UPDATE directo de monto/concepto falla aún con app.egreso_fn; solo app.marcar_egreso_pagado transiciona a pagado
  await assert.rejects(como(u.tesA1, `UPDATE egresos SET monto = 9999 WHERE id = $1`, [egresoId]), /dictaminado/);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_service');
      await tx.query(`SELECT set_config('app.ctx', $1, true), set_config('app.egreso_fn', '1', true)`, [
        signDbContext(u.tesA1, SECRET, { aal: 'aal2' }),
      ]);
      await tx.query(`UPDATE egresos SET monto = 99999 WHERE id = $1`, [egresoId]);
    }),
    /dictaminado/,
  );
  await como(u.tesA1, `SELECT app.marcar_egreso_pagado($1)`, [egresoId]);
  const egrPagado = (await db.query<Fila>(`SELECT estado FROM egresos WHERE id = $1`, [egresoId])).rows[0];
  assert.equal(egrPagado.estado, 'pagado');
});

test('pagos F3: consentimiento autopay (admin pausa pero no activa) y consumo atómico de timbres', async () => {
  // Método de pago del propietario UA1
  const pmId = (
    await como(
      u.propA1,
      `INSERT INTO payment_methods (coto_id, unidad_id, usuario_id, tipo, gateway, gateway_customer_id, gateway_source_id, ultimos_4)
       VALUES ($1, $2, $3, 'card', 'conekta', 'cus_1', 'src_1', '4242') RETURNING id`,
      [A1, UA1, u.propA1],
      { aal: 'aal1' },
    )
  )[0].id;

  // Sin términos -> rechazo
  await assert.rejects(
    como(
      u.propA1,
      `INSERT INTO autopay_config (coto_id, unidad_id, payment_method_id, activo, dia_cobro, estado)
       VALUES ($1, $2, $3, true, 5, 'activo')`,
      [A1, UA1, pmId],
      { aal: 'aal1' },
    ),
    /términos/,
  );

  // Admin nunca puede activar ni crear autopay
  await assert.rejects(
    como(
      u.adminA1,
      `INSERT INTO autopay_config (coto_id, unidad_id, payment_method_id, activo, dia_cobro, estado, terminos_version)
       VALUES ($1, $2, $3, true, 5, 'activo', 'v1')`,
      [A1, UA1, pmId],
    ),
    /row-level security|Solo la persona propietaria/,
  );

  // Propietario activa con términos aceptados
  const apId = (
    await como(
      u.propA1,
      `INSERT INTO autopay_config (coto_id, unidad_id, payment_method_id, activo, dia_cobro, estado, terminos_version)
       VALUES ($1, $2, $3, true, 5, 'activo', '2026-11') RETURNING id`,
      [A1, UA1, pmId],
      { aal: 'aal1' },
    )
  )[0].id;
  const apRow = (
    await db.query<Fila>(`SELECT activado_por, terminos_aceptados_en FROM autopay_config WHERE id = $1`, [apId])
  ).rows[0];
  assert.equal(apRow.activado_por, u.propA1);
  assert.ok(apRow.terminos_aceptados_en !== null);

  // Admin sí puede pausar, pero no reactivar ni cambiar método de pago
  await como(u.adminA1, `UPDATE autopay_config SET activo = false, estado = 'pausado' WHERE id = $1`, [apId]);
  await assert.rejects(
    como(u.adminA1, `UPDATE autopay_config SET activo = true, estado = 'activo' WHERE id = $1`, [apId]),
    /Solo la persona propietaria/,
  );

  // Consumo atómico de timbres: solo worker ejecuta app.consumir_timbre y soporta concurrencia sin falsos agotados
  const paqId = id();
  await db.query(
    `INSERT INTO paquetes_timbres (id, org_id, cantidad, usados, precio_unitario, total_pagado, estado)
     VALUES ($1, $2, 3, 0, 1.50, 4.50, 'activo')`,
    [paqId, ORG_A],
  );
  await assert.rejects(como(u.adminA1, `SELECT app.consumir_timbre($1)`, [ORG_A]), /permission denied/);

  const consumirComoWorker = () =>
    db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_worker');
      return (await tx.query<Fila>(`SELECT app.consumir_timbre($1) AS id`, [ORG_A])).rows[0].id;
    });

  const [r1, r2, r3] = await Promise.all([consumirComoWorker(), consumirComoWorker(), consumirComoWorker()]);
  assert.deepEqual([r1, r2, r3], [paqId, paqId, paqId]);
  await assert.rejects(consumirComoWorker(), /Sin timbres fiscales disponibles/);

  const paqFinal = (await db.query<Fila>(`SELECT usados, estado FROM paquetes_timbres WHERE id = $1`, [paqId])).rows[0];
  assert.equal(paqFinal.usados, 3);
  assert.equal(paqFinal.estado, 'agotado');

  // M1: llave privada Facturapi por coto cifrada en coto_secretos gestionada solo por app_worker (app_service sin acceso)
  const keyCifrada = Buffer.concat([Buffer.from([1, 0, 1]), crypto.randomBytes(40)]);
  await assert.rejects(
    como(u.adminA1, `INSERT INTO coto_secretos (coto_id, facturapi_api_key_enc) VALUES ($1, $2)`, [A1, keyCifrada]),
    /permission denied/,
  );
  await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_worker');
    await tx.query(
      `INSERT INTO coto_secretos (coto_id, facturapi_api_key_enc, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (coto_id) DO UPDATE SET facturapi_api_key_enc = EXCLUDED.facturapi_api_key_enc`,
      [A1, keyCifrada],
    );
  });
  await assert.rejects(como(u.adminA1, `SELECT facturapi_api_key_enc FROM coto_secretos`), /permission denied/);

  const pagoCfdiId = id();
  await db.query(
    `INSERT INTO pagos (id, coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, $3, 500, 'spei', 'confirmado')`,
    [pagoCfdiId, A1, UA1],
  );
  // B3: estado fallido permite reintentar nuevo CFDI activo; una factura cancelada es inmutable
  const fFailId = id();
  await db.query(
    `INSERT INTO facturas_cfdi (id, coto_id, pago_id, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, subtotal, total, estado, clave_idempotencia)
     VALUES ($1, $2, $3, 'COTO850101AAA', 'Coto', 'XAXX010101000', 'Publico', 500, 500, 'fallido', 'cfdi:fail')`,
    [fFailId, A1, pagoCfdiId],
  );
  const f1Id = id();
  await db.query(
    `INSERT INTO facturas_cfdi (id, coto_id, pago_id, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, subtotal, total, estado, clave_idempotencia)
     VALUES ($1, $2, $3, 'COTO850101AAA', 'Coto', 'XAXX010101000', 'Publico', 500, 500, 'pendiente', 'cfdi:1')`,
    [f1Id, A1, pagoCfdiId],
  );
  await db.query(
    `UPDATE facturas_cfdi SET pac_invoice_id = 'inv_1', uuid_cfdi = '11111111-1111-4111-8111-111111111111', estado = 'timbrado' WHERE id = $1`,
    [f1Id],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO facturas_cfdi (coto_id, pago_id, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, subtotal, total, estado, clave_idempotencia)
       VALUES ($1, $2, 'COTO850101AAA', 'Coto', 'XAXX010101000', 'Publico', 500, 500, 'pendiente', 'cfdi:2')`,
      [A1, pagoCfdiId],
    ),
    /facturas_cfdi_pago_activo_key/,
  );
  // Al cancelar f1 se permite re-timbrar el mismo pago y f1 no puede reactivarse
  await db.query(`UPDATE facturas_cfdi SET estado = 'cancelado', cancelado_en = now() WHERE id = $1`, [f1Id]);
  await assert.rejects(
    db.query(`UPDATE facturas_cfdi SET estado = 'timbrado' WHERE id = $1`, [f1Id]),
    /cancelada no puede reactivarse/,
  );
  await db.query(
    `INSERT INTO facturas_cfdi (coto_id, pago_id, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, subtotal, total, estado, clave_idempotencia)
     VALUES ($1, $2, 'COTO850101AAA', 'Coto', 'XAXX010101000', 'Publico', 500, 500, 'pendiente', 'cfdi:3')`,
    [A1, pagoCfdiId],
  );

  // B1 (ronda 4): rechazo definitivo devuelve el timbre reservado una sola vez; solo el worker; nunca si ya se timbró
  const pagoRechazoId = id();
  await db.query(
    `INSERT INTO pagos (id, coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, $3, 500, 'spei', 'confirmado')`,
    [pagoRechazoId, A1, UA1],
  );
  const fRechazoId = id();
  await db.query(
    `INSERT INTO facturas_cfdi (id, coto_id, pago_id, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, subtotal, total, estado, clave_idempotencia, paquete_timbre_id)
     VALUES ($1, $2, $3, 'COTO850101AAA', 'Coto', 'XAXX010101000', 'Publico', 500, 500, 'pendiente', 'cfdi:rechazo', $4)`,
    [fRechazoId, A1, pagoRechazoId, paqId],
  );
  await assert.rejects(como(u.adminA1, `SELECT app.marcar_cfdi_fallido($1)`, [fRechazoId]), /permission denied/);
  const marcarComoWorker = (facturaId: string) =>
    db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_worker');
      await tx.query(`SELECT app.marcar_cfdi_fallido($1)`, [facturaId]);
    });
  await marcarComoWorker(fRechazoId);
  await marcarComoWorker(fRechazoId);
  const paqDevuelto = (await db.query<Fila>(`SELECT usados, estado FROM paquetes_timbres WHERE id = $1`, [paqId]))
    .rows[0];
  assert.equal(paqDevuelto.usados, 2);
  assert.equal(paqDevuelto.estado, 'activo');
  assert.equal(
    (await db.query<Fila>(`SELECT estado FROM facturas_cfdi WHERE id = $1`, [fRechazoId])).rows[0].estado,
    'fallido',
  );
  // Una fila con pac_invoice_id (ya timbrada en el PAC) nunca pasa a fallido ni devuelve timbre
  const pagoTimbradoId = id();
  await db.query(
    `INSERT INTO pagos (id, coto_id, unidad_id, monto, metodo, estado) VALUES ($1, $2, $3, 500, 'spei', 'confirmado')`,
    [pagoTimbradoId, A1, UA1],
  );
  const fConPacId = id();
  await db.query(
    `INSERT INTO facturas_cfdi (id, coto_id, pago_id, emisor_rfc, emisor_nombre, receptor_rfc, receptor_nombre, subtotal, total, estado, clave_idempotencia, paquete_timbre_id, pac_invoice_id)
     VALUES ($1, $2, $3, 'COTO850101AAA', 'Coto', 'XAXX010101000', 'Publico', 500, 500, 'pendiente', 'cfdi:conpac', $4, 'inv_conpac')`,
    [fConPacId, A1, pagoTimbradoId, paqId],
  );
  await marcarComoWorker(fConPacId);
  assert.equal(
    (await db.query<Fila>(`SELECT estado FROM facturas_cfdi WHERE id = $1`, [fConPacId])).rows[0].estado,
    'pendiente',
  );
  assert.equal((await db.query<Fila>(`SELECT usados FROM paquetes_timbres WHERE id = $1`, [paqId])).rows[0].usados, 2);
});

test('comunicación F4: segmento de morosos privado, lectura propia, bot resuelve solo verificados y RLS frena la inyección', async () => {
  // Comunicado a morosos: solo propietarios de unidades morosas lo reciben; el comité no ve la lista
  await db.query(
    `INSERT INTO cargos (coto_id, unidad_id, concepto_id, periodo, monto_original, saldo_pendiente, fecha_vencimiento)
     VALUES ($1, $2, $3, $4, 1000, 1000, $5)`,
    [A1, UA1, CONC_A1, periodo(-90), dia(-90)],
  );
  await assert.rejects(
    como(u.adminA1, `INSERT INTO comunicados (coto_id, titulo, cuerpo) VALUES ($1, 'Aviso', '<script>x</script>')`, [
      A1,
    ]),
    /comunicados_sin_html_ck/,
  );
  await assert.rejects(
    como(
      u.adminA1,
      `INSERT INTO comunicados (coto_id, titulo, cuerpo, dirigido_a) VALUES ($1, 'Aviso', 'x', 'sector')`,
      [A1],
    ),
    /comunicados_dirigido_ck/,
  );
  await assert.rejects(
    como(u.comiteA1, `INSERT INTO comunicados (coto_id, titulo, cuerpo) VALUES ($1, 'Aviso', 'x')`, [A1]),
    /row-level security/,
  );
  const [{ id: cMor }] = await como(
    u.adminA1,
    `INSERT INTO comunicados (coto_id, titulo, cuerpo, dirigido_a)
     VALUES ($1, 'Regulariza tu adeudo', '**Hola**', 'morosos') RETURNING id`,
    [A1],
  );
  await assert.rejects(como(u.comiteA1, `SELECT app.publicar_comunicado($1)`, [cMor]), /no encontrado/);
  const [{ n }] = await como(u.adminA1, `SELECT app.publicar_comunicado($1) AS n`, [cMor]);
  await assert.rejects(como(u.adminA1, `SELECT app.publicar_comunicado($1)`, [cMor]), /ya fue publicado/);

  const morosas = (await como(u.tesA1, `SELECT unidad_id FROM app.morosidad($1)`, [A1])).map((r: Fila) => r.unidad_id);
  assert.ok(morosas.includes(UA1));
  const destinatarios = (
    await db.query<Fila>(`SELECT usuario_id FROM comunicados_lectura WHERE comunicado_id = $1`, [cMor])
  ).rows.map((r: Fila) => r.usuario_id);
  assert.equal(destinatarios.length, n);
  assert.ok(destinatarios.includes(u.propA1));
  assert.ok(!destinatarios.includes(u.inqA1)); // el inquilino no es el deudor
  assert.ok(!destinatarios.includes(u.comiteA1));

  const ve = async (user: string, comunicado: string) =>
    (await como(user, `SELECT count(*)::int AS n FROM comunicados WHERE id = $1`, [comunicado]))[0].n;
  const lecturas = async (user: string, comunicado: string) =>
    (await como(user, `SELECT count(*)::int AS n FROM comunicados_lectura WHERE comunicado_id = $1`, [comunicado]))[0]
      .n;
  assert.equal(await ve(u.propA1, cMor), 1);
  assert.equal(await ve(u.inqA1, cMor), 0);
  assert.equal(await ve(u.propB1, cMor), 0);
  assert.equal(await ve(u.comiteA1, cMor), 1); // staff ve el comunicado…
  assert.equal(await lecturas(u.comiteA1, cMor), 0); // …pero no la lista de morosos
  assert.equal(await lecturas(u.tesA1, cMor), n);
  assert.equal(await lecturas(u.propA1, cMor), 1);

  // Acuse de lectura: solo la fila propia; no puede tocar notificado_en
  await como(u.propA1, `UPDATE comunicados_lectura SET leido_en = now(), canal = 'app' WHERE comunicado_id = $1`, [
    cMor,
  ]);
  const leidos = await db.query<Fila>(
    `SELECT count(*)::int AS n FROM comunicados_lectura WHERE comunicado_id = $1 AND leido_en IS NOT NULL`,
    [cMor],
  );
  assert.equal(leidos.rows[0].n, 1);
  await assert.rejects(
    como(u.propA1, `UPDATE comunicados_lectura SET notificado_en = now() WHERE comunicado_id = $1`, [cMor]),
    /permission denied/,
  );

  // 'todos': cada miembro activo del coto, nadie de otro coto
  const [{ id: cTodos }] = await como(
    u.adminA1,
    `INSERT INTO comunicados (coto_id, titulo, cuerpo) VALUES ($1, 'Corte de agua', 'Mañana 9 a 12') RETURNING id`,
    [A1],
  );
  await como(u.adminA1, `SELECT app.publicar_comunicado($1)`, [cTodos]);
  assert.equal(await ve(u.guardA1, cTodos), 1);
  assert.equal(await ve(u.propB1, cTodos), 0);

  // Bot: instancia atada al coto por constraint; teléfono verificado y no ambiguo
  await assert.rejects(
    db.query(`INSERT INTO evolution_instances (coto_id, instance_name) VALUES ($1, $2)`, [A1, `coto_${B1}`]),
    /evolution_instances_nombre_ck/,
  );
  await db.query(`INSERT INTO evolution_instances (coto_id, instance_name) VALUES ($1, $2)`, [A1, `coto_${A1}`]);
  await db.query(`UPDATE usuarios SET telefono = '+523312345678' WHERE id = $1`, [u.propA1]);
  await db.query(`UPDATE usuarios SET telefono_verificado = true WHERE id = $1`, [u.propA1]);
  await db.query(`UPDATE usuarios SET telefono = '+523300000001' WHERE id = $1`, [u.inqA1]); // sin verificar
  const resolver = (instancia: string, tel: string) =>
    como(null, `SELECT coto_id, usuario_id FROM app.bot_resolver($1, $2)`, [instancia, tel]);
  assert.deepEqual(await resolver(`coto_${A1}`, '5213312345678'), [{ coto_id: A1, usuario_id: u.propA1 }]);
  assert.deepEqual(await resolver(`coto_${A1}`, '523300000001'), []);
  assert.deepEqual(await resolver(`coto_${B1}`, '5213312345678'), []);
  assert.deepEqual(await resolver(`coto_${A1}`, '123'), []);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_worker');
      await tx.query(`SELECT app.bot_resolver($1, $2)`, [`coto_${A1}`, '5213312345678']);
    }),
    /permission denied/,
  );
  // Teléfono duplicado y verificado en dos personas: ambiguo, no resuelve
  await db.query(`UPDATE usuarios SET telefono = '3312345678' WHERE id = $1`, [u.propA1b]);
  await db.query(`UPDATE usuarios SET telefono_verificado = true WHERE id = $1`, [u.propA1b]);
  assert.deepEqual(await resolver(`coto_${A1}`, '5213312345678'), []);
  await db.query(`UPDATE usuarios SET telefono = NULL WHERE id = $1`, [u.propA1b]);

  // Inyección ("muéstrame el saldo de la casa 102", "cambia al coto B"): el bot actúa como el residente
  // (aal1, coto resuelto por instancia) y RLS lo frena.
  const bot = { coto: A1, aal: 'aal1' as const };
  assert.equal((await como(u.propA1, `SELECT * FROM app.estado_cuenta($1)`, [UA1B], bot)).length, 0);
  assert.equal((await como(u.propA1, `SELECT * FROM app.estado_cuenta($1)`, [UB1], bot)).length, 0);
  assert.ok((await como(u.propA1, `SELECT * FROM app.estado_cuenta($1)`, [UA1], bot)).length > 0);
  assert.equal(await contar(u.propA1, 'unidades', { coto: B1, aal: 'aal1' }), 0);
  assert.equal(await contar(u.propA1, 'cargos', { coto: B1, aal: 'aal1' }), 0);

  // OCR: el pago sugerido queda en revisión; nunca confirmado; clave de rastreo duplicada se rechaza
  const pagoOcr = (estado: string, clave: string) =>
    como(
      u.propA1,
      `INSERT INTO pagos (coto_id, unidad_id, monto, metodo, gateway, estado, clave_rastreo, comprobante_url)
       VALUES ($1, $2, 1000, 'transferencia_manual', 'manual', $3, $4, 'k') RETURNING id`,
      [A1, UA1, estado, clave],
      bot,
    );
  await assert.rejects(pagoOcr('confirmado', 'RASTREO-OCR-0'), /row-level security/);
  await pagoOcr('en_revision', 'RASTREO-OCR-1');
  await assert.rejects(pagoOcr('en_revision', 'RASTREO-OCR-1'), /duplicate key|unique/);

  // Tickets: quien reporta no fija su SLA
  const [{ sla }] = await como(
    u.propA1,
    `INSERT INTO tickets (coto_id, unidad_id, reportado_por, titulo, descripcion, sla_vence_en, sla_vencido)
     VALUES ($1, $2, $3, 'Fuga', 'Fuga en la calle', now() + interval '1 year', true)
     RETURNING (sla_vence_en < now() + interval '73 hours' AND NOT sla_vencido) AS sla`,
    [A1, UA1, u.propA1],
    bot,
  );
  assert.equal(sla, true);

  // Votaciones: 'programada' válida; resultados solo staff y solo agregados
  const [{ id: vot }] = await como(
    u.adminA1,
    `INSERT INTO votaciones (coto_id, titulo, fecha_inicio, fecha_fin, estado, ponderada_por_indiviso)
     VALUES ($1, 'Alberca', now() + interval '1 day', now() + interval '2 day', 'programada', true) RETURNING id`,
    [A1],
  );
  const [{ id: opSi }] = await como(
    u.adminA1,
    `INSERT INTO opciones_voto (coto_id, votacion_id, texto) VALUES ($1, $2, 'Sí') RETURNING id`,
    [A1, vot],
  );
  await como(u.adminA1, `INSERT INTO opciones_voto (coto_id, votacion_id, texto) VALUES ($1, $2, 'No')`, [A1, vot]);
  await assert.rejects(como(u.propA1, `SELECT app.votar($1, $2, $3)`, [vot, opSi, UA1]), /no está abierta/);
  await db.query(`UPDATE votaciones SET estado = 'activa', fecha_inicio = now() - interval '1 hour' WHERE id = $1`, [
    vot,
  ]);
  await como(u.propA1, `SELECT app.votar($1, $2, $3)`, [vot, opSi, UA1]);
  const res = await como(u.comiteA1, `SELECT * FROM app.resultados_votacion($1)`, [vot]);
  assert.equal(res.length, 2);
  const si = res.find((r: Fila) => r.opcion === 'Sí');
  assert.equal(si.votos, 1);
  assert.equal(Number(si.peso), 0.5);
  assert.equal(si.unidades_votantes, 1);
  assert.equal(si.unidades_totales, 2);
  assert.equal(Number(si.indiviso_votante), 0.5);
  assert.deepEqual(Object.keys(si).sort(), [
    'indiviso_votante',
    'opcion',
    'opcion_id',
    'peso',
    'unidades_totales',
    'unidades_votantes',
    'votos',
  ]);
  assert.equal((await como(u.propA1, `SELECT * FROM app.resultados_votacion($1)`, [vot])).length, 0);
  assert.equal((await como(u.ownerB, `SELECT * FROM app.resultados_votacion($1)`, [vot])).length, 0);
  assert.equal((await como(u.comiteA1, `SELECT * FROM app.resultados_votacion($1)`, [vot], { coto: A2 })).length, 0);
});
