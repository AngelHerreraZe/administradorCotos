import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'vitest';
import { calculateAuditHash, verifyAuditLink } from '../src/audit-chain.ts';
import { decryptField, encryptField, keyringFromEnv, keyVersionOf } from '../src/crypto-vault.ts';
import { signDbContext, signPreAuthContext } from '../src/tenant-context.ts';

const k1 = crypto.randomBytes(32).toString('base64');
const k2 = crypto.randomBytes(32).toString('base64');
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

test('cifrado: ida y vuelta, AAD por fila/tenant y rotación', () => {
  const v1 = keyringFromEnv(`1:${k1}`);
  const blob = encryptField('CSD-PASSWORD', ORG_A, 'coto_secretos.csd_password:c1', v1);
  assert.equal(blob[0], 1); // la BD exige este byte (coto_secretos_cifrado_ck)
  assert.equal(decryptField(blob, ORG_A, 'coto_secretos.csd_password:c1', v1).toString(), 'CSD-PASSWORD');
  assert.throws(() => decryptField(blob, ORG_B, 'coto_secretos.csd_password:c1', v1)); // otro despacho
  assert.throws(() => decryptField(blob, ORG_A, 'coto_secretos.csd_password:c2', v1)); // copiado a otra fila
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => decryptField(tampered, ORG_A, 'coto_secretos.csd_password:c1', v1));

  const v12 = keyringFromEnv(`1:${k1},2:${k2}`);
  assert.equal(decryptField(blob, ORG_A, 'coto_secretos.csd_password:c1', v12).toString(), 'CSD-PASSWORD');
  assert.equal(keyVersionOf(encryptField('x', ORG_A, 'ctx', v12)), 2);
  assert.throws(() => keyringFromEnv('1:corta'));
});

test('auditoría: hash estable aunque JSONB reordene llaves; alteración detectada', () => {
  const secret = 'audit-secret';
  const base = { orgId: ORG_A, accion: 'pagos.update', recursoTipo: 'pagos', timestamp: '2026-11-26T10:00:00.000Z' };
  const h = calculateAuditHash(
    { ...base, datosDespues: { monto: 1500, estado: 'confirmado' } },
    '0'.repeat(64),
    secret,
  );
  const reordenado = { ...base, datosDespues: { estado: 'confirmado', monto: 1500 } };
  assert.ok(verifyAuditLink(reordenado, '0'.repeat(64), h, secret));
  assert.ok(
    !verifyAuditLink({ ...base, datosDespues: { estado: 'confirmado', monto: 15000 } }, '0'.repeat(64), h, secret),
  );
  assert.ok(!verifyAuditLink(reordenado, '0'.repeat(64), 'abc', secret)); // hash basura: false, no excepción
});

test('contexto RLS v2: formato con aal que valida app.uid()/app.aal() y UUID estricto', () => {
  const secret = crypto.randomBytes(32);
  const ctx = signDbContext('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', secret);
  assert.match(ctx, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.aal[12]\.[0-9]{10}\.[0-9a-f]{64}$/);
  const [id, aal, exp, mac] = ctx.split('.');
  assert.equal(aal, 'aal1');
  assert.equal(mac, crypto.createHmac('sha256', secret).update(`${id}.${aal}.${exp}`).digest('hex'));

  const ctxAal2 = signDbContext(ORG_A, secret, { aal: 'aal2', ttlSeconds: 60 });
  assert.equal(ctxAal2.split('.')[1], 'aal2');

  const preCtx = signPreAuthContext(ORG_A, secret, { aal: 'aal1' });
  assert.match(preCtx, /^auth\.[0-9a-f-]{36}\.aal1\.[0-9]{10}\.[0-9a-f]{64}$/);

  assert.throws(() => signDbContext("x' OR 1=1 --", secret));
  assert.throws(() => signPreAuthContext('invalido', secret));
  assert.throws(() => signDbContext(ORG_A, Buffer.alloc(8)));
});
