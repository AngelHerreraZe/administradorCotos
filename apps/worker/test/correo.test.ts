import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { loadEnv } from '../src/env.ts';
import { procesadorCorreo } from '../src/processors/correo.ts';

describe('worker correo', () => {
  const base = { WORKER_DATABASE_URL: 'postgresql://app_worker:x@db/app', REDIS_URL: 'redis://localhost:6379' };

  test('la cola correo exige RESEND_API_KEY y EMAIL_FROM', () => {
    expect(() => loadEnv({ ...base, WORKER_QUEUES: 'correo' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadEnv({ ...base, WORKER_QUEUES: 'correo', RESEND_API_KEY: 're_123' })).toThrow(/RESEND_API_KEY/);
    const env = loadEnv({
      ...base,
      WORKER_QUEUES: 'correo',
      RESEND_API_KEY: 're_123',
      EMAIL_FROM: 'notificaciones@admcotos.mx',
    });
    expect(env.WORKER_QUEUES).toEqual(['correo']);
  });

  test('procesa payload válido y rechaza payload inválido sin tocar PII en logs', async () => {
    const logs: Record<string, unknown>[] = [];
    const log = pino(
      { level: 'info' },
      {
        write(chunk: string) {
          logs.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    );
    const keys: (string | undefined)[] = [];
    const transport = {
      emails: {
        async send(_payload: unknown, options?: { idempotencyKey?: string }) {
          keys.push(options?.idempotencyKey);
          return { data: { id: 'msg_1' }, error: null };
        },
      },
    };
    const fn = procesadorCorreo({ apiKey: 're_test', from: 'noreply@admcotos.mx', log, transport });

    await expect(
      fn({ id: 'j1', data: { plantilla: 'invitacion', para: 'no-es-correo', datos: {} } }),
    ).rejects.toThrow();

    const res = await fn({
      id: 'inv:123',
      data: {
        plantilla: 'invitacion',
        para: 'persona.secreta@ejemplo.mx',
        datos: { coto: 'Miraflores', rol: 'guardia', url: 'https://app.admcotos.mx/ok' },
      },
    });
    expect(res).toEqual({ id: 'msg_1' });
    expect(keys).toEqual(['inv:123']);
    expect(JSON.stringify(logs)).not.toContain('persona.secreta@ejemplo.mx');
  });
});
