import { describe, expect, test } from 'vitest';
import { enviarCorreo, escaparHtml, renderizarCorreo } from '../src/correo.ts';

describe('correo transaccional', () => {
  test('escapa HTML peligroso y rechaza URLs javascript:', () => {
    expect(escaparHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');

    const { html, text, subject } = renderizarCorreo('invitacion', {
      coto: 'Coto <script>XSS</script>',
      rol: 'coto_admin',
      url: 'javascript:alert(1)',
      expira: '48 horas',
    });
    expect(subject).toContain('Coto');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(text).not.toContain('javascript:');
  });

  test('renderiza y envía plantilla de invitación con URL https válida e idempotencyKey', async () => {
    const enviados: {
      payload: { from: string; to: string[]; subject: string; text: string; html: string };
      options?: { idempotencyKey?: string };
    }[] = [];
    const transport = {
      emails: {
        async send(
          payload: { from: string; to: string[]; subject: string; text: string; html: string },
          options?: { idempotencyKey?: string },
        ) {
          enviados.push({ payload, options });
          return { data: { id: 'email_123' }, error: null };
        },
      },
    };

    const res = await enviarCorreo(
      {
        plantilla: 'invitacion',
        para: 'vecino@admcotos.mx',
        datos: {
          coto: 'Miraflores',
          rol: 'residente_propietario',
          url: 'https://app.admcotos.mx/invitaciones#token=abc',
          expira: '7 días',
        },
      },
      {
        apiKey: 're_test',
        from: 'Administrador de Cotos <notificaciones@admcotos.mx>',
        idempotencyKey: 'inv-123',
        transport,
      },
    );

    expect(res).toEqual({ id: 'email_123' });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.payload.html).toContain('https://app.admcotos.mx/invitaciones#token=abc');
    expect(enviados[0]?.payload.text).toContain('Miraflores');
    expect(enviados[0]?.options).toEqual({ idempotencyKey: 'inv-123' });
  });

  test('propaga error del proveedor sin incluir la dirección del destinatario', async () => {
    const transport = {
      emails: {
        async send() {
          return { data: null, error: { message: 'rate limit' } };
        },
      },
    };

    await expect(
      enviarCorreo(
        { plantilla: 'aviso', para: 'secreto@ejemplo.mx', datos: { titulo: 'T', mensaje: 'M' } },
        { apiKey: 're_test', from: 'notificaciones@admcotos.mx', transport },
      ),
    ).rejects.toThrow(/rate limit/);
  });
});
