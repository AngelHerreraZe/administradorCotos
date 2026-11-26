// 🔴 Aislamiento multi-tenant contra un Postgres real (PGlite, sin Docker).
// Aplica las migraciones tal cual y actúa como app_service con contexto firmado.
// Debe pasar al 100% en CI antes de cualquier deploy.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { type AalLevel, signDbContext } from '@admcotos/security';
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

test('identidad e invitaciones: usuario_por_auth, mis_membresias, aceptación, expirada, revocada e idempotente', async () => {
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
  await como(
    u.adminA1,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, unidad_id, email, rol, token_hash, expira_en, creada_por)
     VALUES ($1, $2, $3, 'VecinoNuevo@alfa.mx', 'residente_propietario', $4, now() + interval '2 days', $5)`,
    [ORG_A, A1, UA1B, sha(tokOk), u.adminA1],
  );
  // No puede forjar aceptada_en directamente
  await assert.rejects(
    como(u.adminA1, `UPDATE invitaciones_miembro SET aceptada_en = now() WHERE token_hash = $1`, [sha(tokOk)]),
    /permission denied/,
  );

  const authNuevo = id();
  // Correo distinto -> UA403
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'otro@alfa.mx', 'Ana', 'García')`, [sha(tokOk), authNuevo]),
    /no coincide/,
  );

  // Aceptar con correo coincidente (case-insensitive via citext) -> crea usuario y membresía
  const uid1 = (
    await como(null, `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García') AS id`, [
      sha(tokOk),
      authNuevo,
    ])
  )[0].id;
  // Idempotente al repetir con el mismo auth_id
  const uid2 = (
    await como(null, `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García') AS id`, [
      sha(tokOk),
      authNuevo,
    ])
  )[0].id;
  assert.equal(uid1, uid2);

  // Invitación revocada -> rechazada
  const tokRev = 'token-inv-revocado';
  const [{ id: invRevId }] = await como(
    u.adminA1,
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por)
     VALUES ($1, $2, 'guardia@alfa.mx', 'guardia', $3, now() + interval '2 days', $4) RETURNING id`,
    [ORG_A, A1, sha(tokRev), u.adminA1],
  );
  await como(u.adminA1, `UPDATE invitaciones_miembro SET revocada_en = now() WHERE id = $1`, [invRevId]);
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'guardia@alfa.mx', 'Luis', 'Pérez')`, [sha(tokRev), id()]),
    /no existe o ya venció/,
  );

  // Invitación vencida -> rechazada
  const tokExp = 'token-inv-expirado';
  await db.query(
    `INSERT INTO invitaciones_miembro (org_id, coto_id, email, rol, token_hash, expira_en, creada_por, created_at)
     VALUES ($1, $2, 'exp@alfa.mx', 'guardia', $3, now() - interval '1 hour', $4, now() - interval '2 days')`,
    [ORG_A, A1, sha(tokExp), u.adminA1],
  );
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'exp@alfa.mx', 'Luis', 'Pérez')`, [sha(tokExp), id()]),
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
  await assert.rejects(
    como(null, `SELECT app.aceptar_invitacion($1, $2, 'vecinonuevo@alfa.mx', 'Ana', 'García')`, [
      sha(tokOtroAuth),
      id(),
    ]),
    /vinculado a otra cuenta/,
  );
});
