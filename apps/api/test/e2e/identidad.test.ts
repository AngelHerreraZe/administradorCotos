import crypto from 'node:crypto';
import { AppError } from '@admcotos/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type EscenarioE2E, iniciarEscenarioE2E } from './setup.ts';

let ctx: EscenarioE2E;

beforeAll(async () => {
  ctx = await iniciarEscenarioE2E();
}, 120_000);

afterAll(async () => {
  if (ctx) await ctx.cerrar();
});

describe('E2E Fase 1 contra PostgreSQL real (app_service + RLS)', () => {
  test('residente A no lee unidades ni coto de B; solo ve su propia unidad en A1', async () => {
    const jwtA = await ctx.firmarJwt(ctx.usuarios.propA1.authId, { aal: 'aal1' });

    const cotoB = await ctx.app.request(`/api/v1/cotos/${ctx.cotoB1}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(cotoB.status).toBe(404);

    const unidadesB = await ctx.app.request(`/api/v1/cotos/${ctx.cotoB1}/unidades`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(unidadesB.status).toBe(403);

    const unidadesA = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(unidadesA.status).toBe(200);
    const body = (await unidadesA.json()) as { datos: { id: string }[] };
    expect(body.datos.map((u) => u.id)).toEqual([ctx.unidadA1]);
  });

  test('X-Coto-Id manipulado no amplía permisos ni mezcla contextos', async () => {
    const jwtA = await ctx.firmarJwt(ctx.usuarios.propA1.authId, { aal: 'aal1' });

    const meAcotadoB = await ctx.app.request('/api/v1/me', {
      headers: { Authorization: `Bearer ${jwtA}`, 'X-Coto-Id': ctx.cotoB1 },
    });
    expect(meAcotadoB.status).toBe(200);
    expect(((await meAcotadoB.json()) as { membresias: unknown[] }).membresias).toEqual([]);

    const cruce = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades`, {
      headers: { Authorization: `Bearer ${jwtA}`, 'X-Coto-Id': ctx.cotoB1 },
    });
    expect(cruce.status).toBe(403);
  });

  test('admin sin aal2 lee pero recibe 403 al escribir; con aal2 sí escribe', async () => {
    const jwtAdminAal1 = await ctx.firmarJwt(ctx.usuarios.adminA1.authId, { aal: 'aal1' });
    const jwtAdminAal2 = await ctx.firmarJwt(ctx.usuarios.adminA1.authId, { aal: 'aal2' });
    const jwtOwnerAal1 = await ctx.firmarJwt(ctx.usuarios.ownerA.authId, { aal: 'aal1' });

    expect(
      (
        await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/sectores`, {
          headers: { Authorization: `Bearer ${jwtAdminAal1}` },
        })
      ).status,
    ).toBe(200);

    const postSinMfa = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/sectores`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdminAal1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Sector Sin MFA' }),
    });
    expect(postSinMfa.status).toBe(403);

    const patchOrgSinMfa = await ctx.app.request(`/api/v1/orgs/${ctx.orgA}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwtOwnerAal1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Sin MFA' }),
    });
    expect(patchOrgSinMfa.status).toBe(403);

    const postConMfa = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/sectores`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdminAal2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Torre Sur' }),
    });
    expect(postConMfa.status).toBe(201);
  });

  test('invitación de punta a punta: rollback ante fallo de cola, idempotencia, #token=, auditoría con usuario_id real, aceptar y /me', async () => {
    const jwtAdmin = await ctx.firmarJwt(ctx.usuarios.adminA1.authId, { aal: 'aal2' });
    const emailInvitado = `nuevo-${crypto.randomUUID().slice(0, 8)}@alfa.mx`;
    const idemKey = crypto.randomUUID();

    // Si encolarCorreo falla con 503, la transacción se revierte sin dejar clave_idempotencia huérfana
    ctx.fallarSiguienteCorreo(
      new AppError(503, 'servicio_no_disponible', 'El servicio de correo no está disponible temporalmente'),
    );
    const crearFallo = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/invitaciones`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtAdmin}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({ email: emailInvitado, rol: 'residente_propietario', unidadId: ctx.unidadA1B }),
    });
    expect(crearFallo.status).toBe(503);
    expect(ctx.correos.filter((c) => c.para === emailInvitado)).toHaveLength(0);

    // Reintento con la misma Idempotency-Key tras fallo -> 201 y un correo encolado
    const crear1 = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/invitaciones`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtAdmin}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({ email: emailInvitado, rol: 'residente_propietario', unidadId: ctx.unidadA1B }),
    });
    expect(crear1.status).toBe(201);
    const invDto = (await crear1.json()) as { id: string };

    // Misma Idempotency-Key -> 200, mismo id y un solo correo encolado
    const crear2 = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/invitaciones`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtAdmin}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({ email: emailInvitado, rol: 'residente_propietario', unidadId: ctx.unidadA1B }),
    });
    expect(crear2.status).toBe(200);
    expect((await crear2.json()) as { id: string }).toEqual(invDto);
    const enviadosParaInvitado = ctx.correos.filter((c) => c.para === emailInvitado);
    expect(enviadosParaInvitado).toHaveLength(1);

    const urlCorreo = enviadosParaInvitado[0]?.datos.url ?? '';
    const parsedUrl = new URL(urlCorreo);
    expect(parsedUrl.search).toBe('');
    const token = new URLSearchParams(parsedUrl.hash.replace(/^#/, '')).get('token') ?? '';
    expect(token.length).toBeGreaterThan(20);

    const authNuevo = crypto.randomUUID();
    const jwtCorreoDistinto = await ctx.firmarJwt(authNuevo, {
      aal: 'aal1',
      email: 'intruso@alfa.mx',
      emailVerified: true,
    });
    const aceptarDistinto = await ctx.app.request('/api/v1/invitaciones/aceptar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtCorreoDistinto}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, nombre: 'Intruso', apellidoPaterno: 'Test' }),
    });
    expect(aceptarDistinto.status).toBe(403);
    expect(await aceptarDistinto.json()).toMatchObject({ code: 'bd.ua403' });

    const jwtCorrecto = await ctx.firmarJwt(authNuevo, {
      aal: 'aal1',
      email: emailInvitado,
    });
    const aceptar1 = await ctx.app.request('/api/v1/invitaciones/aceptar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtCorrecto}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, nombre: 'Sofía', apellidoPaterno: 'Mendoza' }),
    });
    expect(aceptar1.status).toBe(200);
    const body1 = (await aceptar1.json()) as { usuarioId: string };

    // Verificar en audit_outbox que usuario_id sea el usuarios.id real (nunca auth_id)
    const auditRows = await ctx.adminPrisma.$queryRaw<{ usuario_id: string | null }[]>`
      SELECT usuario_id FROM audit_outbox WHERE recurso_id = ${invDto.id}::uuid AND accion = 'invitaciones_miembro.update'
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.usuario_id).toBe(body1.usuarioId);

    // Idempotente en segundo intento
    const aceptar2 = await ctx.app.request('/api/v1/invitaciones/aceptar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtCorrecto}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, nombre: 'Sofía', apellidoPaterno: 'Mendoza' }),
    });
    expect(aceptar2.status).toBe(200);
    expect(await aceptar2.json()).toEqual(body1);

    // El usuario ya puede consultar /me inmediatamente (sin caché negativa estancada)
    const me = await ctx.app.request('/api/v1/me', { headers: { Authorization: `Bearer ${jwtCorrecto}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      id: body1.usuarioId,
      membresias: [{ cotoId: ctx.cotoA1, unidadId: ctx.unidadA1B, rol: 'residente_propietario' }],
    });

    // Revocar invitación ya aceptada -> 409
    const revocarAceptada = await ctx.app.request(`/api/v1/invitaciones/${invDto.id}/revocar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}` },
    });
    expect(revocarAceptada.status).toBe(409);
  });

  test('importación CSV con errores por fila no inserta nada; CSV válido inserta en una transacción', async () => {
    const jwtAdmin = await ctx.firmarJwt(ctx.usuarios.adminA1.authId, { aal: 'aal2' });
    const secRes = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/sectores`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Torre CSV' }),
    });
    expect(secRes.status).toBe(201);

    const csvMalo = ['numero,tipo,sector,indiviso', '201,casa,Torre CSV,0.25', '202,invalido,NoExiste,0'].join('\n');
    const r422 = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades/importar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'text/csv' },
      body: csvMalo,
    });
    expect(r422.status).toBe(422);
    expect(await r422.json()).toMatchObject({ code: 'csv_con_errores' });

    const antes = (await (
      await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades`, {
        headers: { Authorization: `Bearer ${jwtAdmin}` },
      })
    ).json()) as { datos: { numero: string }[] };
    expect(antes.datos.some((u) => u.numero === '201')).toBe(false);

    const csvOk = ['numero,tipo,sector,indiviso', '201,departamento,Torre CSV,0.25', '202,casa,,0.25'].join('\n');
    const r201 = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades/importar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'text/csv' },
      body: csvOk,
    });
    expect(r201.status).toBe(201);
    expect(await r201.json()).toEqual({ creadas: 2 });
  });

  test('errores de Postgres (Prisma 7 + adapter-pg) llegan como Problem Details correctos', async () => {
    const jwtAdmin = await ctx.firmarJwt(ctx.usuarios.adminA1.authId, { aal: 'aal2' });

    const dup = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: '101' }),
    });
    expect(dup.status).toBe(409);
    expect(dup.headers.get('content-type')).toBe('application/problem+json');
    expect(await dup.json()).toMatchObject({ code: 'duplicado' });

    const crossFk = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/unidades`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwtAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: '999', sectorId: ctx.sectorB1 }),
    });
    expect(crossFk.status).toBe(422);
    expect(await crossFk.json()).toMatchObject({ code: 'referencia_invalida' });
  });

  test('despacho, soporte idempotente, directorio LFPDPPP y desactivación de miembro sin 500', async () => {
    const jwtOwner = await ctx.firmarJwt(ctx.usuarios.ownerA.authId, { aal: 'aal2' });
    const jwtComite = await ctx.firmarJwt(ctx.usuarios.comiteA1.authId, { aal: 'aal1' });
    const jwtProp = await ctx.firmarJwt(ctx.usuarios.propA1.authId, { aal: 'aal1' });

    const resumen = await ctx.app.request(`/api/v1/orgs/${ctx.orgA}/cotos`, {
      headers: { Authorization: `Bearer ${jwtOwner}` },
    });
    expect(resumen.status).toBe(200);
    expect(((await resumen.json()) as { datos: unknown[] }).datos.length).toBeGreaterThanOrEqual(2);

    const soporteIdem = crypto.randomUUID();
    const sop1 = await ctx.app.request(`/api/v1/orgs/${ctx.orgA}/soporte`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtOwner}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': soporteIdem,
      },
      body: JSON.stringify({ ticketRef: 'TICK-1', duracionHoras: 12 }),
    });
    expect(sop1.status).toBe(201);
    const sopDto = (await sop1.json()) as { id: string };

    const sop2 = await ctx.app.request(`/api/v1/orgs/${ctx.orgA}/soporte`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtOwner}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': soporteIdem,
      },
      body: JSON.stringify({ ticketRef: 'TICK-1', duracionHoras: 12 }),
    });
    expect(sop2.status).toBe(200);
    expect(await sop2.json()).toEqual(sopDto);

    expect(
      (
        await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/miembros`, {
          headers: { Authorization: `Bearer ${jwtProp}` },
        })
      ).status,
    ).toBe(403);

    // Comité ve miembros sin email ni teléfono (LFPDPPP)
    const dirComite = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/miembros`, {
      headers: { Authorization: `Bearer ${jwtComite}` },
    });
    expect(dirComite.status).toBe(200);
    const listaComite = (await dirComite.json()) as { datos: { email: string | null; telefono: string | null }[] };
    expect(listaComite.datos.length).toBeGreaterThan(0);
    for (const m of listaComite.datos) {
      expect(m.email).toBeNull();
      expect(m.telefono).toBeNull();
    }

    // Owner ve emails y puede desactivar un miembro sin romper GET/PATCH
    const dirOwner = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/miembros`, {
      headers: { Authorization: `Bearer ${jwtOwner}` },
    });
    expect(dirOwner.status).toBe(200);
    const listaOwner = (await dirOwner.json()) as { datos: { id: string; usuarioId: string; email: string | null }[] };
    const miembroComite = listaOwner.datos.find((m) => m.usuarioId === ctx.usuarios.comiteA1.id);
    expect(miembroComite?.email).toBe(ctx.usuarios.comiteA1.email);

    const desactivar = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/miembros/${miembroComite!.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwtOwner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activo: false }),
    });
    expect(desactivar.status).toBe(200);
    expect(await desactivar.json()).toMatchObject({ id: miembroComite!.id, activo: false });

    const dirDespues = await ctx.app.request(`/api/v1/cotos/${ctx.cotoA1}/miembros`, {
      headers: { Authorization: `Bearer ${jwtOwner}` },
    });
    expect(dirDespues.status).toBe(200);
    const listaDespues = (await dirDespues.json()) as { datos: { id: string }[] };
    expect(listaDespues.datos.some((m) => m.id === miembroComite!.id)).toBe(false);
  });
});
