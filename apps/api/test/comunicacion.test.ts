import crypto from 'node:crypto';
import type { PrismaClient } from '@admcotos/db';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';
import type { Deps } from '../src/types.ts';

const ISSUER = 'https://test.supabase.co/auth/v1';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const COTO_ID = '33333333-3333-4333-8333-333333333333';
const OTRO_COTO_ID = '99999999-9999-4999-8999-999999999999';
const ORG_ID = '88888888-8888-4888-8888-888888888888';
const UNIDAD_ID = '44444444-4444-4444-8444-444444444444';
const ID = '77777777-7777-4777-8777-777777777777';
const OPCION_ID = '66666666-6666-4666-8666-666666666666';
const APIKEY_WA = 'k'.repeat(40);

process.env.DB_CTX_SECRET ??= 'ab'.repeat(32);

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_service:x@localhost:5432/test',
  DB_CTX_SECRET: 'ab'.repeat(32),
  SUPABASE_URL: 'https://test.supabase.co',
  REDIS_URL: 'redis://localhost:6379',
  EVOLUTION_WEBHOOK_APIKEY: APIKEY_WA,
});

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
let token: string;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'k1', alg: 'ES256', use: 'sig' });
  jwks = createLocalJWKSet({ keys: [jwk] });
  token = await new SignJWT({ aal: 'aal2' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject('11111111-1111-4111-8111-111111111111')
    .setExpirationTime('5m')
    .sign(privateKey);
});

const pgError = (codigo: string, mensaje = 'x') =>
  Object.assign(new Error('Raw query failed'), {
    meta: { driverAdapterError: { cause: { originalCode: codigo, originalMessage: mensaje } } },
  });
const prismaError = (code: string) => Object.assign(new Error(code), { code });

function app(tx: Record<string, unknown>, extra: Partial<Deps> = {}, raiz: Record<string, unknown> = {}) {
  const prisma = {
    $queryRaw: async () => [{ id: USER_ID }],
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({ $executeRaw: async () => 1, ...tx }),
    ...raiz,
  } as unknown as PrismaClient;
  return createApp({
    env,
    prisma,
    log: pino({ level: 'silent' }),
    jwks,
    limitador: { async consumir() {} },
    encolarCorreo: async () => {},
    storage: {
      llaveParaArchivo: (o, c, cat) => `${o}/${c}/${cat}/${crypto.randomUUID()}.jpg`,
      urlDeSubida: async ({ llave }) => ({ url: 'https://s3.test/up', fields: {}, expiraEnSegundos: 300, llave }),
      urlDeDescarga: async ({ llave }) => ({ url: `https://s3.test/${llave}`, expiraEnSegundos: 120 }),
    },
    ...extra,
  });
}

const pedir = (a: ReturnType<typeof app>, metodo: string, ruta: string, body?: unknown, headers = {}) =>
  a.request(`/api/v1${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const fecha = new Date('2026-11-27T12:00:00Z');

describe('Fase 4: comunicados, tickets, votaciones y webhook de WhatsApp', () => {
  test('comunicados: crear, Markdown sin HTML (422), otro rol (403), idempotencia, publicar y leído', async () => {
    const fila = {
      id: ID,
      cotoId: COTO_ID,
      titulo: 'Corte de agua',
      cuerpo: '**Mañana** de 9 a 12',
      prioridad: 'normal',
      dirigidoA: 'todos',
      publicado: false,
      publicadoEn: null,
      createdAt: fecha,
    };
    let duplicar = false;
    let publicado = false;
    let permiso = true;
    const encolados: { jobId?: string | undefined }[] = [];
    const a = app(
      {
        comunicado: {
          create: async () => {
            if (duplicar) throw prismaError('P2002');
            return fila;
          },
          findUnique: async (q: { where: { id?: string } }) =>
            q.where.id === OTRO_COTO_ID ? null : q.where.id ? { publicado } : fila,
          findMany: async () => [{ ...fila, lecturas: [{ leidoEn: fecha }] }],
        },
        comunicadoLectura: {
          count: async () => 3,
          findUnique: async (q: { where: { comunicadoId_usuarioId: { comunicadoId: string } } }) =>
            q.where.comunicadoId_usuarioId.comunicadoId === ID ? { leidoEn: null } : null,
          update: async () => ({}),
        },
        $queryRaw: async (s: TemplateStringsArray) =>
          s.join('?').includes('publicar_comunicado') ? [{ n: 3 }] : [{ ok: permiso }],
      },
      { encolarNotificaciones: async (_p, o) => void encolados.push(o ?? {}) },
    );
    const nuevo = { titulo: 'Corte de agua', cuerpo: '**Mañana** de 9 a 12' };

    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/comunicados`, nuevo)).status).toBe(201);
    expect(
      (await pedir(a, 'POST', `/cotos/${COTO_ID}/comunicados`, { ...nuevo, cuerpo: '<script>x</script>' })).status,
    ).toBe(422);
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/comunicados`, { ...nuevo, dirigidoA: 'sector' })).status).toBe(
      422,
    );
    const lista = await pedir(a, 'GET', `/cotos/${COTO_ID}/comunicados`);
    expect(((await lista.json()) as { datos: { leidoEn: string }[] }).datos[0]?.leidoEn).toBe(fecha.toISOString());

    // Idempotencia: la segunda vez la clave choca y se devuelve el existente con 200
    const llave = { 'Idempotency-Key': crypto.randomUUID() };
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/comunicados`, nuevo, llave)).status).toBe(201);
    duplicar = true;
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/comunicados`, nuevo, llave)).status).toBe(200);

    // Comité / otro coto: RLS rechaza el INSERT
    const sinPermiso = app({
      comunicado: {
        create: async () => {
          throw pgError('42501');
        },
      },
    });
    expect((await pedir(sinPermiso, 'POST', `/cotos/${OTRO_COTO_ID}/comunicados`, nuevo)).status).toBe(403);

    // Publicar encola el fan-out después del commit; repetir no republica y reencola el mismo jobId
    const r1 = await pedir(a, 'POST', `/comunicados/${ID}/publicar`);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ destinatarios: 3 });
    publicado = true;
    expect((await pedir(a, 'POST', `/comunicados/${ID}/publicar`)).status).toBe(200);
    expect(encolados.map((e) => e.jobId)).toEqual([`notif-${ID}`, `notif-${ID}`]);
    permiso = false;
    expect((await pedir(a, 'POST', `/comunicados/${ID}/publicar`)).status).toBe(403);
    expect((await pedir(a, 'POST', `/comunicados/${OTRO_COTO_ID}/publicar`)).status).toBe(404);

    expect((await pedir(a, 'POST', `/comunicados/${ID}/leido`)).status).toBe(204);
    expect((await pedir(a, 'POST', `/comunicados/${OTRO_COTO_ID}/leido`)).status).toBe(404);
  });

  test('tickets: crear con adjuntos del coto, 422, 403, idempotencia, PATCH admin, comentarios y adjuntos', async () => {
    const fila = {
      id: ID,
      cotoId: COTO_ID,
      unidadId: UNIDAD_ID,
      reportadoPor: USER_ID,
      numero: 12,
      titulo: 'Fuga',
      descripcion: 'Fuga en la calle',
      categoria: null,
      estado: 'abierto',
      adjuntos: [`${ORG_ID}/${COTO_ID}/tickets/a.jpg`],
      slaVenceEn: fecha,
      slaVencido: false,
      createdAt: fecha,
      updatedAt: fecha,
    };
    let duplicar = false;
    let esAdmin = true;
    let miembro = true;
    const comentario = {
      id: ID,
      ticketId: ID,
      usuarioId: USER_ID,
      comentario: 'Gracias',
      esInterno: false,
      createdAt: fecha,
    };
    const a = app({
      coto: { findUnique: async () => ({ orgId: ORG_ID }) },
      ticket: {
        create: async (q: { data: { adjuntos: string[] } }) => {
          if (duplicar) throw prismaError('P2002');
          expect(q.data).not.toHaveProperty('slaVenceEn');
          return fila;
        },
        findUnique: async (q: { where: { id?: string } }) => (q.where.id === OTRO_COTO_ID ? null : fila),
        findMany: async () => [fila],
        update: async () => {
          if (!esAdmin) throw prismaError('P2025');
          return { ...fila, estado: 'en_proceso' };
        },
      },
      ticketComentario: { create: async () => comentario, findMany: async () => [comentario] },
      $queryRaw: async () => [{ ok: miembro }],
    });
    const nuevo = { titulo: 'Fuga', descripcion: 'Fuga en la calle', unidadId: UNIDAD_ID };

    const r = await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets`, { ...nuevo, adjuntos: fila.adjuntos });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { adjuntos: number }).adjuntos).toBe(1);
    expect(
      (
        await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets`, {
          ...nuevo,
          adjuntos: [`${ORG_ID}/${OTRO_COTO_ID}/tickets/x.jpg`],
        })
      ).status,
    ).toBe(422);
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets`, { ...nuevo, titulo: '' })).status).toBe(422);
    expect((await pedir(a, 'GET', `/cotos/${COTO_ID}/tickets?estado=abierto`)).status).toBe(200);

    const llave = { 'Idempotency-Key': crypto.randomUUID() };
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets`, nuevo, llave)).status).toBe(201);
    duplicar = true;
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets`, nuevo, llave)).status).toBe(200);

    const otroCoto = app({
      ticket: {
        create: async () => {
          throw pgError('42501');
        },
      },
    });
    expect((await pedir(otroCoto, 'POST', `/cotos/${OTRO_COTO_ID}/tickets`, nuevo)).status).toBe(403);

    expect((await pedir(a, 'PATCH', `/tickets/${ID}`, { estado: 'en_proceso' })).status).toBe(200);
    expect((await pedir(a, 'PATCH', `/tickets/${ID}`, {})).status).toBe(422);
    expect((await pedir(a, 'PATCH', `/tickets/${OTRO_COTO_ID}`, { estado: 'cerrado' })).status).toBe(404);
    esAdmin = false; // residente o comité: RLS no deja actualizar
    expect((await pedir(a, 'PATCH', `/tickets/${ID}`, { estado: 'cerrado' })).status).toBe(403);

    expect((await pedir(a, 'POST', `/tickets/${ID}/comentarios`, { comentario: 'Gracias' })).status).toBe(201);
    expect((await pedir(a, 'POST', `/tickets/${ID}/comentarios`, { comentario: '' })).status).toBe(422);
    expect((await pedir(a, 'GET', `/tickets/${ID}/comentarios`)).status).toBe(200);

    expect(
      (await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets/adjunto-url`, { contentType: 'image/jpeg' })).status,
    ).toBe(200);
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/tickets/adjunto-url`, { contentType: 'text/html' })).status).toBe(
      422,
    );
    miembro = false;
    expect(
      (await pedir(a, 'POST', `/cotos/${OTRO_COTO_ID}/tickets/adjunto-url`, { contentType: 'image/jpeg' })).status,
    ).toBe(403);
    const adj = await pedir(a, 'GET', `/tickets/${ID}/adjuntos`);
    expect(((await adj.json()) as { datos: string[] }).datos).toEqual([`https://s3.test/${fila.adjuntos[0]}`]);
  });

  test('votaciones: crear (422/403/idempotente), abrir programada, cerrar, votar y resultados agregados', async () => {
    const futuro = new Date(Date.now() + 86_400_000);
    const despues = new Date(Date.now() + 2 * 86_400_000);
    const fila = {
      id: ID,
      cotoId: COTO_ID,
      titulo: 'Alberca',
      ponderadaPorIndiviso: true,
      fechaInicio: futuro,
      fechaFin: despues,
      estado: 'borrador',
      createdAt: fecha,
      opciones: [{ id: OPCION_ID, texto: 'Sí' }],
    };
    let estado = 'borrador';
    let duplicar = false;
    let resultados: unknown[] = [
      {
        opcion_id: OPCION_ID,
        opcion: 'Sí',
        votos: 1,
        peso: { toString: () => '0.500000' },
        unidades_votantes: 1,
        unidades_totales: 2,
        indiviso_votante: { toString: () => '0.500000' },
      },
    ];
    let votoError: Error | null = null;
    const a = app({
      votacion: {
        create: async (q: { data: { opciones: { create: { cotoId: string }[] } } }) => {
          if (duplicar) throw prismaError('P2002');
          expect(q.data.opciones.create.every((o) => o.cotoId === COTO_ID)).toBe(true);
          return fila;
        },
        findUnique: async (q: { where: { id?: string } }) => (q.where.id === OTRO_COTO_ID ? null : { ...fila, estado }),
        findMany: async () => [fila],
        update: async (q: { data: { estado: string } }) => ({ ...fila, estado: q.data.estado }),
      },
      $queryRaw: async (s: TemplateStringsArray) => {
        const sql = s.join('?');
        if (sql.includes('app.votar')) {
          if (votoError) throw votoError;
          return [{ id: ID }];
        }
        return resultados;
      },
    });
    const nueva = {
      titulo: 'Alberca',
      fechaInicio: futuro.toISOString(),
      fechaFin: despues.toISOString(),
      ponderadaPorIndiviso: true,
      opciones: ['Sí', 'No'],
    };
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/votaciones`, nueva)).status).toBe(201);
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/votaciones`, { ...nueva, opciones: ['Sí'] })).status).toBe(422);
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/votaciones`, { ...nueva, opciones: ['Sí', 'sí'] })).status).toBe(
      422,
    );
    expect(
      (
        await pedir(a, 'POST', `/cotos/${COTO_ID}/votaciones`, {
          ...nueva,
          fechaFin: futuro.toISOString(),
          fechaInicio: despues.toISOString(),
        })
      ).status,
    ).toBe(422);
    const llave = { 'Idempotency-Key': crypto.randomUUID() };
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/votaciones`, nueva, llave)).status).toBe(201);
    duplicar = true;
    expect((await pedir(a, 'POST', `/cotos/${COTO_ID}/votaciones`, nueva, llave)).status).toBe(200);
    const residente = app({
      votacion: {
        create: async () => {
          throw pgError('42501');
        },
      },
    });
    expect((await pedir(residente, 'POST', `/cotos/${COTO_ID}/votaciones`, nueva)).status).toBe(403);
    expect((await pedir(a, 'GET', `/cotos/${COTO_ID}/votaciones?estado=activa`)).status).toBe(200);

    const abierta = await pedir(a, 'POST', `/votaciones/${ID}/abrir`);
    expect(((await abierta.json()) as { estado: string }).estado).toBe('programada'); // inicia mañana
    estado = 'activa';
    expect((await pedir(a, 'POST', `/votaciones/${ID}/abrir`)).status).toBe(409);
    expect((await pedir(a, 'POST', `/votaciones/${OTRO_COTO_ID}/abrir`)).status).toBe(404);
    expect((await pedir(a, 'POST', `/votaciones/${ID}/cerrar`)).status).toBe(200);
    estado = 'cerrada';
    expect((await pedir(a, 'POST', `/votaciones/${ID}/cerrar`)).status).toBe(409);

    const voto = { opcionId: OPCION_ID, unidadId: UNIDAD_ID };
    expect((await pedir(a, 'POST', `/votaciones/${ID}/votos`, voto)).status).toBe(201);
    expect((await pedir(a, 'POST', `/votaciones/${ID}/votos`, { opcionId: 'x' })).status).toBe(422);
    votoError = pgError('UA403', 'Solo la persona propietaria de la unidad puede votar');
    expect((await pedir(a, 'POST', `/votaciones/${ID}/votos`, voto)).status).toBe(403);
    votoError = pgError('UA409', 'Esta unidad ya votó');
    expect((await pedir(a, 'POST', `/votaciones/${ID}/votos`, voto)).status).toBe(409);

    const res = await pedir(a, 'GET', `/votaciones/${ID}/resultados`);
    expect(await res.json()).toEqual({
      votacionId: ID,
      opciones: [{ opcionId: OPCION_ID, opcion: 'Sí', votos: 1, peso: '0.500000' }],
      unidadesVotantes: 1,
      unidadesTotales: 2,
      indivisoVotante: '0.500000',
    });
    resultados = []; // residente u otro coto: la función no devuelve nada
    expect((await pedir(a, 'GET', `/votaciones/${ID}/resultados`)).status).toBe(404);
  });

  test('webhook WhatsApp: apikey por hash, solo mensajes, idempotente y sin guardar el texto', async () => {
    const inserts: unknown[][] = [];
    const encolados: unknown[] = [];
    let nuevo = 1;
    const a = app(
      {},
      {
        encolarWhatsappEntrante: async (p) => {
          encolados.push(p);
        },
      },
      {
        $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
          inserts.push(v);
          return nuevo;
        },
      },
    );
    const evento = (jid: string, texto = 'cuánto debo') => ({
      event: 'messages.upsert',
      instance: `coto_${COTO_ID}`,
      data: { key: { remoteJid: jid, fromMe: false, id: 'MSG1' }, message: { conversation: texto } },
    });
    const enviar = (body: unknown, apikey?: string) =>
      a.request('/webhooks/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apikey ? { apikey } : {}) },
        body: JSON.stringify(body),
      });

    expect((await enviar(evento('5213312345678@s.whatsapp.net'))).status).toBe(401);
    expect((await enviar(evento('5213312345678@s.whatsapp.net'), 'otra')).status).toBe(401);
    expect(await (await enviar(evento('120363@g.us'), APIKEY_WA)).json()).toMatchObject({ ignored: true });
    expect(encolados).toHaveLength(0);

    const ok = await enviar(evento('5213312345678@s.whatsapp.net'), APIKEY_WA);
    expect(ok.status).toBe(200);
    expect(encolados).toEqual([
      { instancia: `coto_${COTO_ID}`, telefono: '5213312345678', mensajeId: 'MSG1', texto: 'cuánto debo' },
    ]);
    expect(JSON.stringify(inserts)).not.toContain('cuánto debo'); // webhook_events no guarda el mensaje
    nuevo = 0;
    expect(await (await enviar(evento('5213312345678@s.whatsapp.net'), APIKEY_WA)).json()).toMatchObject({
      duplicate: true,
    });
    expect(encolados).toHaveLength(1);

    const sinConfig = createApp({
      env: { ...env, EVOLUTION_WEBHOOK_APIKEY: undefined },
      prisma: {} as PrismaClient,
      log: pino({ level: 'silent' }),
      jwks,
      limitador: { async consumir() {} },
      encolarCorreo: async () => {},
    });
    expect((await sinConfig.request('/webhooks/whatsapp', { method: 'POST', body: '{}' })).status).toBe(503);
  });
});
