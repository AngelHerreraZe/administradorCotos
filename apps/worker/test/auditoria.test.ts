import { expect, test } from 'vitest';
import { loadEnv } from '../src/env.ts';
import { drenarTodo } from '../src/processors/auditoria.ts';

test('drena lotes completos hasta encontrar uno incompleto', async () => {
  const lotes = [500, 500, 120];
  let llamadas = 0;
  const total = await drenarTodo(async () => lotes[llamadas++] ?? 0);
  expect(total).toBe(1120);
  expect(llamadas).toBe(3);
});

test('la cola auditoria no arranca sin su secreto HMAC', () => {
  const base = { WORKER_DATABASE_URL: 'postgresql://app_worker:x@db/app', REDIS_URL: 'redis://localhost:6379' };
  expect(() => loadEnv({ ...base, WORKER_QUEUES: 'auditoria' })).toThrow(/AUDIT_LOG_HMAC_SECRET/);
  expect(() => loadEnv({ ...base, WORKER_QUEUES: 'inventada' })).toThrow();
  expect(loadEnv({ ...base, WORKER_QUEUES: 'auditoria', AUDIT_LOG_HMAC_SECRET: 'x'.repeat(32) }).WORKER_QUEUES).toEqual(
    ['auditoria'],
  );
});
