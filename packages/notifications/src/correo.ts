import type { PayloadCorreo } from '@admcotos/shared';
import { Resend } from 'resend';

export interface CorreoTransport {
  emails: {
    send(
      payload: {
        from: string;
        to: string[];
        subject: string;
        text: string;
        html: string;
      },
      options?: { idempotencyKey?: string },
    ): Promise<{ data: { id: string } | null; error: { message: string; name?: string } | null }>;
  };
}

export interface OpcionesCorreo {
  apiKey: string;
  from: string;
  idempotencyKey?: string;
  transport?: CorreoTransport;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapa caracteres HTML para evitar inyección en plantillas de correo. */
export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

function sanitizarUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function envolverHtml(titulo: string, cuerpoHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="es"><body style="font-family:system-ui,-apple-system,sans-serif;color:#111827;line-height:1.5;margin:0;padding:24px;background:#f9fafb;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">',
    `<h1 style="font-size:18px;margin:0 0 12px;">${escaparHtml(titulo)}</h1>`,
    cuerpoHtml,
    '<p style="font-size:12px;color:#6b7280;margin-top:24px;">Administrador de Cotos · Correo automático</p>',
    '</div></body></html>',
  ].join('');
}

export function renderizarCorreo(
  plantilla: PayloadCorreo['plantilla'],
  datos: Record<string, string>,
): { subject: string; text: string; html: string } {
  if (plantilla === 'invitacion') {
    const destino = datos.coto || datos.organizacion || 'Administrador de Cotos';
    const rol = datos.rol || 'miembro';
    const expira = datos.expira || '7 días';
    const url = sanitizarUrl(datos.url);
    const subject = `Invitación a ${destino}`;

    const textLines = [
      `Recibiste una invitación para unirte a ${destino} con el rol ${rol}.`,
      url ? `Acepta tu invitación en: ${url}` : 'Ingresa a la plataforma para aceptar tu invitación.',
      `Esta invitación vence en ${expira}. Si no la esperabas, puedes ignorar este mensaje.`,
    ];

    const botonHtml = url
      ? `<p style="margin:20px 0;"><a href="${escaparHtml(url)}" style="display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">Aceptar invitación</a></p>`
      : '';

    const html = envolverHtml(
      subject,
      `<p>Recibiste una invitación para unirte a <strong>${escaparHtml(destino)}</strong> con el rol <strong>${escaparHtml(rol)}</strong>.</p>${botonHtml}<p style="font-size:13px;color:#4b5563;">Esta invitación vence en ${escaparHtml(expira)}. Si no la esperabas, puedes ignorar este mensaje.</p>`,
    );
    return { subject, text: textLines.join('\n\n'), html };
  }

  if (plantilla === 'recibo') {
    const coto = datos.coto || 'Tu coto';
    const unidad = datos.unidad || '-';
    const monto = datos.monto || '0.00';
    const folio = datos.folio || '-';
    const subject = `Recibo de pago · ${coto}`;
    const text = `Confirmamos tu pago por $${monto} MXN en ${coto} (unidad ${unidad}). Folio: ${folio}.`;
    const html = envolverHtml(
      subject,
      `<p>Confirmamos tu pago en <strong>${escaparHtml(coto)}</strong>.</p><ul><li>Unidad: ${escaparHtml(unidad)}</li><li>Monto: $${escaparHtml(monto)} MXN</li><li>Folio: ${escaparHtml(folio)}</li></ul>`,
    );
    return { subject, text, html };
  }

  const titulo = datos.titulo || 'Aviso';
  const coto = datos.coto || 'Administrador de Cotos';
  const mensaje = datos.mensaje || '';
  const subject = `${titulo} · ${coto}`;
  const text = `${titulo}\n\n${mensaje}`;
  const html = envolverHtml(titulo, `<p>${escaparHtml(mensaje)}</p>`);
  return { subject, text, html };
}

export async function enviarCorreo(params: PayloadCorreo, opciones: OpcionesCorreo): Promise<{ id: string }> {
  const cliente: CorreoTransport = opciones.transport ?? new Resend(opciones.apiKey);
  const { subject, text, html } = renderizarCorreo(params.plantilla, params.datos);
  const requestOpts = opciones.idempotencyKey ? { idempotencyKey: opciones.idempotencyKey } : undefined;
  const res = await cliente.emails.send(
    {
      from: opciones.from,
      to: [params.para],
      subject,
      text,
      html,
    },
    requestOpts,
  );
  if (res.error || !res.data?.id) {
    throw new Error(`No se pudo enviar correo (${params.plantilla}): ${res.error?.message ?? 'sin id'}`);
  }
  return { id: res.data.id };
}

export function crearEnviadorCorreo(opciones: OpcionesCorreo) {
  return (params: PayloadCorreo) => enviarCorreo(params, opciones);
}
