-- ════════════════════════════════════════════════════════════════════
-- SEGURIDAD MULTI-TENANT · roles, contexto firmado, RLS, integridad,
-- auditoría y consultas de alto tráfico.
--
-- Modelo (detalle en plan_backend_mayoreo_seguridad_extrema.md §9):
--  · La API se conecta como app_service: no es dueña de tablas, no tiene
--    BYPASSRLS. Por transacción fija app.ctx = "<usuario>.<exp>.<hmac>".
--    Solo app.uid() valida esa firma; sin firma válida RLS no devuelve filas.
--  · Los roles NUNCA vienen del JWT ni de la app: se derivan en cada
--    consulta de miembros_coto / org_miembros / soporte_accesos.
--  · app.coto_id (opcional) solo ACOTA la vista a un coto; nunca amplía.
--  · Los workers usan app_worker (multi-tenant por política explícita).
--  · Sin FORCE RLS a propósito: el dueño de las tablas es solo el rol de
--    migraciones (sin credenciales en runtime) y las funciones SECURITY
--    DEFINER necesitan leer membresías sin recursión. La API verifica al
--    arrancar que su rol no puede saltarse RLS (assertRestrictedRole).
-- ════════════════════════════════════════════════════════════════════

-- ─── 0. Esquemas, roles y límites ───────────────────────────────────
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN CREATE ROLE app_service NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker')  THEN CREATE ROLE app_worker  NOLOGIN; END IF;
END $$;
-- Operaciones asigna LOGIN + contraseña fuera de git:
--   ALTER ROLE app_service LOGIN PASSWORD '...';  ALTER ROLE app_worker LOGIN PASSWORD '...';

-- Una consulta lenta o una transacción olvidada no puede tumbar a todos los tenants.
ALTER ROLE app_service SET statement_timeout = '8s';
ALTER ROLE app_service SET lock_timeout = '3s';
ALTER ROLE app_service SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE app_worker  SET statement_timeout = '120s';
ALTER ROLE app_worker  SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public, app TO app_service, app_worker;

-- Supabase/PostgREST: la Data API (llave anon pública) no debe tocar tablas de negocio.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Secreto con el que se firma app.ctx. Operaciones lo inserta (mismo valor que DB_CTX_SECRET):
--   INSERT INTO app_private.ctx_secret (secret) VALUES (decode('<hex 64>', 'hex'));
-- Vacío = nadie ve nada (falla cerrado).
CREATE TABLE app_private.ctx_secret (
  id     boolean PRIMARY KEY DEFAULT true CHECK (id),
  secret bytea   NOT NULL CHECK (octet_length(secret) >= 32)
);

-- ─── 1. Identidad de la petición ────────────────────────────────────
CREATE FUNCTION app.uid() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp AS $$
DECLARE
  v text := current_setting('app.ctx', true);
  p text[];
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9]{10}\.[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  p := string_to_array(v, '.');
  IF p[2]::bigint < extract(epoch FROM now()) THEN
    RETURN NULL;                                          -- firma expirada
  END IF;
  IF encode(hmac(convert_to(p[1] || '.' || p[2], 'UTF8'), (SELECT s.secret FROM app_private.ctx_secret s), 'sha256'), 'hex')
     IS DISTINCT FROM p[3] THEN
    RETURN NULL;                                          -- firma inválida o sin secreto
  END IF;
  RETURN p[1]::uuid;
END $$;

CREATE FUNCTION app.coto_activo() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN s ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN s::uuid END
    FROM (SELECT current_setting('app.coto_id', true) AS s) x
$$;

-- ─── 2. Conjuntos de permisos (se evalúan UNA vez por consulta) ─────
-- Las políticas los usan como `col = ANY ((SELECT app.f())::uuid[])`: el SELECT
-- envolvente los vuelve InitPlan (no se recalculan por fila) y el `= ANY`
-- usa los índices por coto_id / unidad_id.
CREATE FUNCTION app._cotos(p_roles text[], p_org_roles text[], p_soporte boolean, p_escritura boolean)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  WITH me AS (SELECT app.uid() AS id),
  fuentes AS (
    SELECT m.coto_id, 'coto'::text AS via
      FROM me JOIN miembros_coto m ON m.usuario_id = me.id
     WHERE m.activo AND m.rol = ANY (p_roles)
    UNION ALL
    SELECT c.id, 'org'
      FROM me JOIN org_miembros om ON om.usuario_id = me.id
      JOIN cotos c ON c.org_id = om.org_id
     WHERE om.activo AND om.rol = ANY (p_org_roles)
    UNION ALL
    SELECT c.id, 'soporte'
      FROM me JOIN staff_plataforma sp ON sp.usuario_id = me.id AND sp.activo
      JOIN soporte_accesos s ON s.revocado_en IS NULL AND now() >= s.desde AND now() < s.hasta
      JOIN cotos c ON c.org_id = s.org_id
     WHERE p_soporte
  )
  SELECT coalesce(array_agg(DISTINCT f.coto_id), '{}')
    FROM fuentes f
    JOIN cotos c ON c.id = f.coto_id
    JOIN organizaciones o ON o.id = c.org_id
   WHERE CASE WHEN p_escritura THEN o.estado_suscripcion = 'activo'           -- corte suave: sin escrituras de staff
              ELSE NOT (f.via = 'org' AND o.estado_suscripcion = 'suspendido') -- portal del despacho suspendido
         END
$$;

CREATE FUNCTION app.cotos_miembro() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._cotos('{coto_admin,coto_tesorero,coto_comite,residente_propietario,residente_inquilino,guardia,proveedor}', '{org_owner,org_admin}', true, false) $$;
CREATE FUNCTION app.cotos_staff() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._cotos('{coto_admin,coto_tesorero,coto_comite}', '{org_owner,org_admin}', true, false) $$;
CREATE FUNCTION app.cotos_finanzas() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._cotos('{coto_admin,coto_tesorero}', '{org_owner,org_admin}', true, false) $$;
CREATE FUNCTION app.cotos_admin() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._cotos('{coto_admin}', '{org_owner,org_admin}', false, true) $$;
CREATE FUNCTION app.cotos_tesoreria() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._cotos('{coto_admin,coto_tesorero}', '{org_owner,org_admin}', false, true) $$;
-- Caseta nunca se bloquea por adeudos del despacho (plan mayoreo §2.2).
CREATE FUNCTION app.cotos_guardia() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._cotos('{guardia,coto_admin}', '{org_owner,org_admin}', false, false) $$;

CREATE FUNCTION app._unidades(p_roles text[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT m.unidad_id), '{}')
    FROM miembros_coto m
   WHERE m.usuario_id = (SELECT app.uid()) AND m.activo AND m.unidad_id IS NOT NULL AND m.rol = ANY (p_roles)
$$;
CREATE FUNCTION app.unidades_mias() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._unidades('{residente_propietario,residente_inquilino}') $$;
CREATE FUNCTION app.unidades_propias() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT app._unidades('{residente_propietario}') $$;

CREATE FUNCTION app._orgs(p_roles text[], p_soporte boolean, p_escritura boolean) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH me AS (SELECT app.uid() AS id)
  SELECT coalesce(array_agg(DISTINCT x.org_id), '{}')
    FROM (
      SELECT om.org_id FROM me JOIN org_miembros om ON om.usuario_id = me.id
       WHERE om.activo AND om.rol = ANY (p_roles)
      UNION ALL
      SELECT s.org_id FROM me JOIN staff_plataforma sp ON sp.usuario_id = me.id AND sp.activo
        JOIN soporte_accesos s ON s.revocado_en IS NULL AND now() >= s.desde AND now() < s.hasta
       WHERE p_soporte
    ) x
    JOIN organizaciones o ON o.id = x.org_id
   WHERE NOT p_escritura OR o.estado_suscripcion = 'activo'
$$;
CREATE FUNCTION app.orgs_lectura() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT app._orgs('{org_owner,org_admin}', true, false) $$;
CREATE FUNCTION app.orgs_admin()   RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT app._orgs('{org_owner,org_admin}', false, true) $$;
CREATE FUNCTION app.orgs_owner()   RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT app._orgs('{org_owner}', false, false) $$;

-- ─── 3. Integridad que la app no puede saltarse ─────────────────────

-- 3a. Una FK simple no impide apuntar a filas de OTRO coto (las FKs ignoran RLS).
--     Este trigger exige que cada referencia pertenezca al mismo coto_id.
CREATE FUNCTION app.tg_mismo_coto() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n jsonb := to_jsonb(NEW);
  v_ref uuid;
  v_coto uuid;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 BY 2 LOOP
    v_ref := (n ->> TG_ARGV[i])::uuid;
    CONTINUE WHEN v_ref IS NULL;
    EXECUTE format('SELECT coto_id FROM public.%I WHERE id = $1', TG_ARGV[i + 1]) INTO v_coto USING v_ref;
    IF v_coto IS DISTINCT FROM NEW.coto_id THEN   -- mismo mensaje si no existe: sin oráculo de UUIDs
      RAISE EXCEPTION 'Referencia inválida en %.%', TG_TABLE_NAME, TG_ARGV[i] USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('unidades',            ARRAY['sector_id','sectores']),
    ('miembros_coto',       ARRAY['unidad_id','unidades']),
    ('cargos',              ARRAY['unidad_id','unidades','concepto_id','conceptos_cargo']),
    ('pagos',               ARRAY['unidad_id','unidades']),
    ('detalle_pagos',       ARRAY['pago_id','pagos','cargo_id','cargos']),
    ('payment_methods',     ARRAY['unidad_id','unidades']),
    ('autopay_config',      ARRAY['unidad_id','unidades','payment_method_id','payment_methods']),
    ('autopay_intentos',    ARRAY['autopay_id','autopay_config','cargo_id','cargos','pago_id','pagos']),
    ('facturas_cfdi',       ARRAY['pago_id','pagos']),
    ('egresos',             ARRAY['cuenta_bancaria_id','cuentas_bancarias','proveedor_id','proveedores']),
    ('invitaciones_acceso', ARRAY['unidad_id','unidades']),
    ('registros_acceso',    ARRAY['invitacion_id','invitaciones_acceso','unidad_destino','unidades']),
    ('reservaciones',       ARRAY['amenidad_id','amenidades','unidad_id','unidades']),
    ('tickets',             ARRAY['unidad_id','unidades']),
    ('ticket_comentarios',  ARRAY['ticket_id','tickets']),
    ('opciones_voto',       ARRAY['votacion_id','votaciones']),
    ('votos',               ARRAY['votacion_id','votaciones','opcion_id','opciones_voto','miembro_id','miembros_coto','unidad_id','unidades'])
  ) v(tabla, refs) LOOP
    EXECUTE format(
      'CREATE TRIGGER mismo_coto BEFORE INSERT OR UPDATE OF coto_id, %s ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_mismo_coto(%s)',
      (SELECT string_agg(quote_ident(r.refs[i]), ', ') FROM generate_subscripts(r.refs, 1) i WHERE i % 2 = 1),
      r.tabla,
      (SELECT string_agg(quote_literal(x), ', ') FROM unnest(r.refs) x));
  END LOOP;
END $$;

-- 3b. Columnas que no cambian después de crearse (mover filas entre tenants,
--     reescribir montos confirmados, reasignar membresías a otra persona).
CREATE FUNCTION app.tg_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c text;
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    IF o -> c IS DISTINCT FROM n -> c THEN
      RAISE EXCEPTION 'La columna %.% no se puede modificar', TG_TABLE_NAME, c USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('org_miembros',        ARRAY['org_id','usuario_id']),
    ('partner_api_keys',    ARRAY['org_id','key_hash']),
    ('soporte_accesos',     ARRAY['org_id','otorgado_por','desde']),
    ('cotos',               ARRAY['org_id']),
    ('sectores',            ARRAY['coto_id']),
    ('unidades',            ARRAY['coto_id']),
    ('miembros_coto',       ARRAY['coto_id','usuario_id']),
    ('conceptos_cargo',     ARRAY['coto_id']),
    ('cargos',              ARRAY['coto_id','unidad_id','concepto_id','periodo','monto_original','clave_idempotencia']),
    ('pagos',               ARRAY['coto_id','unidad_id','monto','gateway_order_id','gateway_charge_id']),
    ('payment_methods',     ARRAY['coto_id','unidad_id','usuario_id','gateway','gateway_customer_id','gateway_source_id']),
    ('autopay_config',      ARRAY['coto_id','unidad_id']),
    ('autopay_intentos',    ARRAY['coto_id','autopay_id','cargo_id','intento_num','monto_centavos']),
    ('facturas_cfdi',       ARRAY['coto_id','pago_id','uuid_cfdi','total']),
    ('cuentas_bancarias',   ARRAY['coto_id']),
    ('proveedores',         ARRAY['coto_id']),
    ('egresos',             ARRAY['coto_id']),
    ('invitaciones_acceso', ARRAY['coto_id','unidad_id','creado_por','token_hash']),
    ('dispositivos_iot',    ARRAY['coto_id']),
    ('amenidades',          ARRAY['coto_id']),
    ('reservaciones',       ARRAY['coto_id','amenidad_id','unidad_id','usuario_id']),
    ('comunicados',         ARRAY['coto_id']),
    ('tickets',             ARRAY['coto_id','reportado_por']),
    ('votaciones',          ARRAY['coto_id','ponderada_por_indiviso']),
    ('opciones_voto',       ARRAY['coto_id','votacion_id'])
  ) v(tabla, cols) LOOP
    EXECUTE format('CREATE TRIGGER inmutable BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_inmutable(%s)',
      r.tabla, (SELECT string_agg(quote_literal(x), ', ') FROM unnest(r.cols) x));
  END LOOP;
END $$;

-- 3c. Libros de solo inserción: ni el dueño de las tablas los edita sin dejar rastro
--     (desactivar el trigger exige superusuario y rompe la cadena HMAC).
CREATE FUNCTION app.tg_solo_insercion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (% bloqueado)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log', 'votos', 'registros_acceso', 'detalle_pagos'] LOOP
    EXECUTE format('CREATE TRIGGER solo_insercion BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_solo_insercion()', t);
    EXECUTE format('CREATE TRIGGER solo_insercion_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.tg_solo_insercion()', t);
  END LOOP;
END $$;

-- 3d. Cambiar el teléfono invalida su verificación (el bot de WhatsApp solo confía en verificados).
CREATE FUNCTION app.tg_telefono_sin_verificar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.telefono_verificado := false;
  RETURN NEW;
END $$;
CREATE TRIGGER telefono_sin_verificar BEFORE UPDATE OF telefono ON usuarios
  FOR EACH ROW WHEN (NEW.telefono IS DISTINCT FROM OLD.telefono) EXECUTE FUNCTION app.tg_telefono_sin_verificar();

-- 3e. Reglas de dominio como constraints (no dependen de que la API valide).
ALTER TABLE organizaciones
  ADD CONSTRAINT organizaciones_estado_ck CHECK (estado_suscripcion IN ('activo','solo_lectura','suspendido')),
  ADD CONSTRAINT organizaciones_tier_ck   CHECK (tier_mayoreo IN ('tier_1','tier_2','tier_3','enterprise')),
  -- Marca blanca = HTML que ven residentes de ese despacho: nada de XSS almacenado.
  ADD CONSTRAINT organizaciones_marca_ck  CHECK (
        (color_primario IS NULL OR color_primario ~ '^#[0-9A-Fa-f]{6}$')
    AND (color_secundario IS NULL OR color_secundario ~ '^#[0-9A-Fa-f]{6}$')
    AND (logo_url IS NULL OR logo_url ~ '^https://[^\s"''<>]+$')
    AND (favicon_url IS NULL OR favicon_url ~ '^https://[^\s"''<>]+$')
    AND (custom_domain IS NULL OR custom_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'));
ALTER TABLE org_miembros  ADD CONSTRAINT org_miembros_rol_ck CHECK (rol IN ('org_owner','org_admin'));
ALTER TABLE miembros_coto
  ADD CONSTRAINT miembros_coto_rol_ck CHECK (rol IN ('coto_admin','coto_tesorero','coto_comite','residente_propietario','residente_inquilino','guardia','proveedor')),
  ADD CONSTRAINT miembros_coto_residente_ck CHECK (rol NOT IN ('residente_propietario','residente_inquilino') OR unidad_id IS NOT NULL);
ALTER TABLE cotos
  ADD CONSTRAINT cotos_dias_ck       CHECK (dia_corte BETWEEN 1 AND 28 AND dia_limite_pago BETWEEN 1 AND 28 AND dias_gracia BETWEEN 0 AND 60),
  ADD CONSTRAINT cotos_moratoria_ck  CHECK (tipo_moratoria IN ('ninguno','porcentaje','fijo') AND tasa_moratoria >= 0 AND descuento_pronto_pago >= 0);
ALTER TABLE coto_secretos  -- formato v1 de encryptField: rechaza CSD guardado en claro por error
  ADD CONSTRAINT coto_secretos_cifrado_ck CHECK (get_byte(csd_cert, 0) = 1 AND get_byte(csd_key, 0) = 1 AND get_byte(csd_password, 0) = 1);
ALTER TABLE unidades ADD CONSTRAINT unidades_montos_ck CHECK (saldo_a_favor >= 0 AND (indiviso IS NULL OR (indiviso > 0 AND indiviso <= 1)));
ALTER TABLE conceptos_cargo ADD CONSTRAINT conceptos_cargo_ck CHECK (
  tipo IN ('ordinario','extraordinario','multa','cuota_especial','reserva') AND (monto_default IS NULL OR monto_default >= 0));
ALTER TABLE cargos
  ADD CONSTRAINT cargos_estado_ck  CHECK (estado IN ('pendiente','parcial','pagado','condonado','cancelado')),
  ADD CONSTRAINT cargos_periodo_ck CHECK (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT cargos_montos_ck  CHECK (monto_original >= 0 AND monto_moratoria >= 0 AND monto_descuento >= 0
                                          AND saldo_pendiente >= 0 AND saldo_pendiente <= monto_original + monto_moratoria - monto_descuento),
  ADD CONSTRAINT cargos_saldo_estado_ck CHECK (estado IN ('condonado','cancelado') OR (estado = 'pagado') = (saldo_pendiente = 0));
ALTER TABLE pagos
  ADD CONSTRAINT pagos_estado_ck   CHECK (estado IN ('pendiente','en_revision','confirmado','rechazado','reembolsado')),
  ADD CONSTRAINT pagos_metodo_ck   CHECK (metodo IN ('tarjeta','spei','oxxo','efectivo','cheque','transferencia_manual','autopay_tarjeta','autopay_clabe')),
  ADD CONSTRAINT pagos_monto_ck    CHECK (monto > 0),
  ADD CONSTRAINT pagos_aplicado_ck CHECK (aplicado_en IS NULL OR estado IN ('confirmado','reembolsado'));
ALTER TABLE detalle_pagos    ADD CONSTRAINT detalle_pagos_monto_ck CHECK (monto_aplicado > 0);
ALTER TABLE payment_methods  ADD CONSTRAINT payment_methods_tipo_ck CHECK (tipo IN ('card','clabe','spei_mandate') AND (ultimos_4 IS NULL OR ultimos_4 ~ '^\d{4}$'));
ALTER TABLE autopay_config   ADD CONSTRAINT autopay_config_ck CHECK (dia_cobro BETWEEN 1 AND 28 AND max_reintentos BETWEEN 0 AND 10
  AND estado IN ('activo','pausado','suspendido_por_fallos','cancelado_por_usuario'));
ALTER TABLE autopay_intentos ADD CONSTRAINT autopay_intentos_ck CHECK (monto_centavos > 0 AND estado IN ('pendiente','exitoso','fallido','reembolsado'));
ALTER TABLE egresos          ADD CONSTRAINT egresos_ck CHECK (monto > 0 AND estado IN ('pendiente','aprobado','rechazado','pagado'));
ALTER TABLE invitaciones_acceso ADD CONSTRAINT invitaciones_ck CHECK (
      estado IN ('activo','usado','expirado','revocado')
  AND tipo IN ('unico','temporal','frecuente','evento','proveedor','paqueteria')
  AND token_hash ~ '^[0-9a-f]{64}$'
  AND (max_usos IS NULL OR max_usos > 0) AND usos_actuales >= 0
  AND (valido_hasta IS NULL OR valido_hasta > valido_desde)
  -- 6 dígitos = 1M combinaciones: solo para pases cortos, nunca permanentes.
  AND (codigo_numerico IS NULL OR (codigo_numerico ~ '^\d{6}$' AND valido_hasta IS NOT NULL AND valido_hasta <= valido_desde + interval '7 days')));
ALTER TABLE registros_acceso ADD CONSTRAINT registros_acceso_ck CHECK (
      tipo_movimiento IN ('entrada','salida')
  AND tipo_persona IN ('residente','visitante','proveedor','paqueteria','emergencia','desconocido')
  AND (metodo IS NULL OR metodo IN ('qr','codigo','rfid','lpr','manual')));
ALTER TABLE reservaciones
  ADD CONSTRAINT reservaciones_ck CHECK (hora_fin > hora_inicio AND estado IN ('pendiente','confirmada','cancelada','completada','no_show')),
  -- Doble reservación imposible aunque dos vecinos aparten al mismo segundo.
  ADD CONSTRAINT reservaciones_sin_traslape EXCLUDE USING gist (
    amenidad_id WITH =, tsrange(fecha + hora_inicio, fecha + hora_fin) WITH &&
  ) WHERE (estado IN ('pendiente','confirmada'));
ALTER TABLE tickets     ADD CONSTRAINT tickets_estado_ck CHECK (estado IN ('abierto','en_proceso','esperando_residente','resuelto','cerrado','cancelado'));
ALTER TABLE votaciones  ADD CONSTRAINT votaciones_ck CHECK (fecha_fin > fecha_inicio AND estado IN ('borrador','activa','cerrada','cancelada'));
ALTER TABLE votos       ADD CONSTRAINT votos_peso_ck CHECK (peso > 0);
ALTER TABLE soporte_accesos ADD CONSTRAINT soporte_ventana_ck CHECK (hasta > desde AND hasta <= desde + interval '72 hours');
ALTER TABLE partner_api_keys ADD CONSTRAINT partner_api_keys_hash_ck CHECK (key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE dispositivos_iot ADD CONSTRAINT dispositivos_iot_hash_ck CHECK (api_key_hash IS NULL OR api_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE paquetes_timbres ADD CONSTRAINT paquetes_timbres_ck CHECK (cantidad > 0 AND usados BETWEEN 0 AND cantidad);

-- ─── 4. Auditoría automática (outbox transaccional) ─────────────────
-- Cada cambio sensible deja rastro en la MISMA transacción, aunque el
-- desarrollador olvide auditar. El worker único (drainAuditOutbox) lo
-- encadena con HMAC hacia audit_log; la llave HMAC nunca toca la BD.
CREATE FUNCTION app.tg_auditar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_excluir text[] := coalesce(TG_ARGV::text[], '{}');      -- columnas que nunca se copian (secretos, hashes)
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - v_excluir END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - v_excluir END;
  v_fila jsonb := coalesce(v_new, v_old);
  v_coto uuid := CASE WHEN TG_TABLE_NAME = 'cotos' THEN (v_fila ->> 'id')::uuid ELSE (v_fila ->> 'coto_id')::uuid END;
  v_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NULL;
  END IF;
  v_org := coalesce(
    CASE WHEN TG_TABLE_NAME = 'organizaciones' THEN (v_fila ->> 'id')::uuid END,
    (v_fila ->> 'org_id')::uuid,
    (SELECT c.org_id FROM cotos c WHERE c.id = v_coto),
    '00000000-0000-0000-0000-000000000000');                -- eventos de plataforma
  INSERT INTO audit_outbox (org_id, coto_id, usuario_id, accion, recurso_tipo, recurso_id, datos_antes, datos_despues, metadata)
  VALUES (v_org, v_coto, app.uid(), TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
          coalesce(v_fila ->> 'id', v_fila ->> 'coto_id', v_fila ->> 'usuario_id')::uuid,
          v_old, v_new,
          jsonb_strip_nulls(jsonb_build_object('rol_bd', session_user, 'req', nullif(current_setting('app.req', true), ''))));
  RETURN NULL;
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('organizaciones', '{}'::text[]), ('org_miembros', '{}'), ('partner_api_keys', '{key_hash}'),
    ('soporte_accesos', '{}'), ('staff_plataforma', '{}'), ('cotos', '{}'),
    ('coto_secretos', '{csd_cert,csd_key,csd_password}'), ('unidades', '{}'), ('miembros_coto', '{}'),
    ('conceptos_cargo', '{}'), ('cargos', '{}'), ('pagos', '{}'), ('cuentas_bancarias', '{}'),
    ('proveedores', '{}'), ('egresos', '{}'), ('payment_methods', '{gateway_customer_id,gateway_source_id}'),
    ('autopay_config', '{}'), ('votaciones', '{}'), ('dispositivos_iot', '{api_key_hash}')
  ) v(tabla, excluir) LOOP
    EXECUTE format('CREATE TRIGGER auditar AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_auditar(%s)',
      r.tabla, coalesce((SELECT string_agg(quote_literal(x), ', ') FROM unnest(r.excluir) x), ''));
  END LOOP;
END $$;

-- ─── 5. Row Level Security ──────────────────────────────────────────
-- 5a. RLS en TODAS las tablas de negocio: sin política explícita = sin acceso.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY worker ON public.%I TO app_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- 5b. app.coto_id acota (RESTRICTIVE): con un coto activo no se ve ni escribe otro.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
             JOIN pg_tables p ON p.schemaname = 'public' AND p.tablename = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'coto_id' LOOP
    EXECUTE format('CREATE POLICY coto_activo ON public.%I AS RESTRICTIVE TO app_service
                    USING ((SELECT app.coto_activo()) IS NULL OR coto_id = (SELECT app.coto_activo()))', t);
  END LOOP;
END $$;
CREATE POLICY coto_activo ON cotos AS RESTRICTIVE TO app_service
  USING ((SELECT app.coto_activo()) IS NULL OR id = (SELECT app.coto_activo()));

-- 5c. Políticas por tabla. Notación de los conjuntos (todos uuid[]):
--   miembro   cualquier rol en el coto (+ despacho, + soporte con ventana)
--   staff     admin · tesorero · comité (+ despacho, + soporte)
--   finanzas  admin · tesorero (+ despacho, + soporte)     ← detalle de adeudos (LFPDPPP)
--   admin     admin (+ despacho) y org al corriente        ← escrituras
--   guardia   guardia · admin (+ despacho), nunca bloqueado
--   mias / propias   unidades del residente (propietario+inquilino / solo propietario)

-- Plataforma y organización
CREATE POLICY sel ON organizaciones FOR SELECT TO app_service USING (id = ANY ((SELECT app.orgs_lectura())::uuid[]));
CREATE POLICY upd ON organizaciones FOR UPDATE TO app_service USING (id = ANY ((SELECT app.orgs_owner())::uuid[]));

CREATE POLICY sel ON org_miembros FOR SELECT TO app_service
  USING (org_id = ANY ((SELECT app.orgs_lectura())::uuid[]) OR usuario_id = (SELECT app.uid()));
CREATE POLICY ins ON org_miembros FOR INSERT TO app_service WITH CHECK (org_id = ANY ((SELECT app.orgs_owner())::uuid[]));
CREATE POLICY upd ON org_miembros FOR UPDATE TO app_service USING (org_id = ANY ((SELECT app.orgs_owner())::uuid[]));

CREATE POLICY todo ON partner_api_keys TO app_service USING (org_id = ANY ((SELECT app.orgs_owner())::uuid[]));
CREATE POLICY sel ON paquetes_timbres FOR SELECT TO app_service USING (org_id = ANY ((SELECT app.orgs_lectura())::uuid[]));

CREATE POLICY sel ON soporte_accesos FOR SELECT TO app_service USING (org_id = ANY ((SELECT app.orgs_lectura())::uuid[]));
CREATE POLICY ins ON soporte_accesos FOR INSERT TO app_service
  WITH CHECK (org_id = ANY ((SELECT app.orgs_owner())::uuid[]) AND otorgado_por = (SELECT app.uid()));
CREATE POLICY upd ON soporte_accesos FOR UPDATE TO app_service USING (org_id = ANY ((SELECT app.orgs_owner())::uuid[]));

-- Personas: cada quien se ve a sí mismo; staff/caseta ven a los miembros de sus cotos;
-- el despacho ve a su equipo; un residente ve a quienes comparten su unidad.
CREATE POLICY sel ON usuarios FOR SELECT TO app_service USING (
     id = (SELECT app.uid())
  OR EXISTS (SELECT 1 FROM miembros_coto m
              WHERE m.usuario_id = usuarios.id AND m.activo
                AND (m.coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR m.coto_id = ANY ((SELECT app.cotos_guardia())::uuid[])
                     OR m.unidad_id = ANY ((SELECT app.unidades_mias())::uuid[])))
  OR EXISTS (SELECT 1 FROM org_miembros om
              WHERE om.usuario_id = usuarios.id AND om.org_id = ANY ((SELECT app.orgs_lectura())::uuid[])));
CREATE POLICY upd ON usuarios FOR UPDATE TO app_service USING (id = (SELECT app.uid()));

-- Cotos
CREATE POLICY sel ON cotos FOR SELECT TO app_service
  USING (id = ANY ((SELECT app.cotos_miembro())::uuid[]) OR org_id = ANY ((SELECT app.orgs_lectura())::uuid[]));
CREATE POLICY ins ON cotos FOR INSERT TO app_service WITH CHECK (org_id = ANY ((SELECT app.orgs_admin())::uuid[]));
CREATE POLICY upd ON cotos FOR UPDATE TO app_service USING (id = ANY ((SELECT app.cotos_admin())::uuid[]));

-- Catálogos del coto: los ve cualquier miembro, los edita administración
CREATE POLICY sel ON sectores        FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_miembro())::uuid[]));
CREATE POLICY ins ON sectores        FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON sectores        FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY sel ON conceptos_cargo FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_miembro())::uuid[]));
CREATE POLICY ins ON conceptos_cargo FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON conceptos_cargo FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY sel ON amenidades      FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_miembro())::uuid[]));
CREATE POLICY ins ON amenidades      FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON amenidades      FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

-- Unidades (saldo a favor incluido): staff y caseta todas; residente solo la suya
CREATE POLICY sel ON unidades FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_guardia())::uuid[]) OR id = ANY ((SELECT app.unidades_mias())::uuid[]));
CREATE POLICY ins ON unidades FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON unidades FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON miembros_coto FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_guardia())::uuid[])
  OR usuario_id = (SELECT app.uid()) OR unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]));
CREATE POLICY ins ON miembros_coto FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON miembros_coto FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

-- Finanzas: el detalle por unidad solo lo ven administración/tesorería y el propietario.
-- El comité recibe agregados (app.resumen_cotos / app.balance_mensual).
CREATE POLICY sel ON cargos FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));
CREATE POLICY ins ON cargos FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON cargos FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON pagos FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));
CREATE POLICY ins ON pagos FOR INSERT TO app_service WITH CHECK (
     coto_id = ANY ((SELECT app.cotos_admin())::uuid[])
  OR (unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]) AND estado IN ('pendiente','en_revision') AND aplicado_en IS NULL));
CREATE POLICY upd ON pagos FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON detalle_pagos FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR EXISTS (SELECT 1 FROM pagos p WHERE p.id = detalle_pagos.pago_id));
CREATE POLICY ins ON detalle_pagos FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON payment_methods FOR SELECT TO app_service
  USING (usuario_id = (SELECT app.uid()) OR coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]));
CREATE POLICY ins ON payment_methods FOR INSERT TO app_service
  WITH CHECK (usuario_id = (SELECT app.uid()) AND unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));
CREATE POLICY upd ON payment_methods FOR UPDATE TO app_service USING (usuario_id = (SELECT app.uid()));

-- Domiciliación: solo el propietario la activa; administración puede pausarla.
-- El método de pago debe ser de esa misma unidad (y visible para quien escribe).
CREATE POLICY sel ON autopay_config FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));
CREATE POLICY ins ON autopay_config FOR INSERT TO app_service WITH CHECK (
  unidad_id = ANY ((SELECT app.unidades_propias())::uuid[])
  AND (payment_method_id IS NULL OR EXISTS (SELECT 1 FROM payment_methods pm
        WHERE pm.id = autopay_config.payment_method_id AND pm.unidad_id = autopay_config.unidad_id AND pm.activo)));
CREATE POLICY upd ON autopay_config FOR UPDATE TO app_service
  USING (unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[]))
  WITH CHECK (
    (unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[]))
    AND (payment_method_id IS NULL OR EXISTS (SELECT 1 FROM payment_methods pm
          WHERE pm.id = autopay_config.payment_method_id AND pm.unidad_id = autopay_config.unidad_id AND pm.activo)));

CREATE POLICY sel ON autopay_intentos FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR EXISTS (SELECT 1 FROM autopay_config a WHERE a.id = autopay_intentos.autopay_id));
CREATE POLICY sel ON facturas_cfdi FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR EXISTS (SELECT 1 FROM pagos p WHERE p.id = facturas_cfdi.pago_id));

CREATE POLICY sel ON cuentas_bancarias FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_staff())::uuid[]));
CREATE POLICY ins ON cuentas_bancarias FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON cuentas_bancarias FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY sel ON proveedores FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_staff())::uuid[]));
CREATE POLICY ins ON proveedores FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON proveedores FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY sel ON egresos FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_staff())::uuid[]));
CREATE POLICY ins ON egresos FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_tesoreria())::uuid[]));
CREATE POLICY upd ON egresos FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_tesoreria())::uuid[]));

-- Accesos. Validar/consumir un QR es app.validar_acceso() (la caseta no edita invitaciones).
CREATE POLICY sel ON invitaciones_acceso FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_guardia())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]));
CREATE POLICY ins ON invitaciones_acceso FOR INSERT TO app_service WITH CHECK (
  creado_por = (SELECT app.uid())
  AND (unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[]))
  AND estado = 'activo' AND usos_actuales = 0);
CREATE POLICY upd ON invitaciones_acceso FOR UPDATE TO app_service
  USING (unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON registros_acceso FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_guardia())::uuid[]) OR unidad_destino = ANY ((SELECT app.unidades_mias())::uuid[]));
CREATE POLICY ins ON registros_acceso FOR INSERT TO app_service
  WITH CHECK (coto_id = ANY ((SELECT app.cotos_guardia())::uuid[]) AND guardia_id = (SELECT app.uid()));

CREATE POLICY sel ON dispositivos_iot FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_guardia())::uuid[]));
CREATE POLICY ins ON dispositivos_iot FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON dispositivos_iot FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

-- Amenidades: el residente solo ve SUS reservaciones; la ocupación ajena sale de
-- app.ocupacion_amenidad() sin nombres ni unidades.
CREATE POLICY sel ON reservaciones FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]));
CREATE POLICY ins ON reservaciones FOR INSERT TO app_service WITH CHECK (
     (unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]) AND usuario_id = (SELECT app.uid()))
  OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON reservaciones FOR UPDATE TO app_service
  USING (unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

-- Comunicación y tickets
CREATE POLICY sel ON comunicados FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR (publicado AND coto_id = ANY ((SELECT app.cotos_miembro())::uuid[])));
CREATE POLICY ins ON comunicados FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON comunicados FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON tickets FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_guardia())::uuid[])
  OR reportado_por = (SELECT app.uid()) OR unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]));
CREATE POLICY ins ON tickets FOR INSERT TO app_service WITH CHECK (
  reportado_por = (SELECT app.uid()) AND coto_id = ANY ((SELECT app.cotos_miembro())::uuid[])
  AND (unidad_id IS NULL OR unidad_id = ANY ((SELECT app.unidades_mias())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_admin())::uuid[])));
CREATE POLICY upd ON tickets FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));

CREATE POLICY sel ON ticket_comentarios FOR SELECT TO app_service USING (
  EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comentarios.ticket_id)
  AND (NOT es_interno OR coto_id = ANY ((SELECT app.cotos_staff())::uuid[])));
CREATE POLICY ins ON ticket_comentarios FOR INSERT TO app_service WITH CHECK (
  usuario_id = (SELECT app.uid())
  AND EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comentarios.ticket_id)
  AND (NOT es_interno OR coto_id = ANY ((SELECT app.cotos_staff())::uuid[])));

-- Gobernanza: los votos se emiten solo con app.votar(); son inmutables.
CREATE POLICY sel ON votaciones FOR SELECT TO app_service USING (
  coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR (estado <> 'borrador' AND coto_id = ANY ((SELECT app.cotos_miembro())::uuid[])));
CREATE POLICY ins ON votaciones FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON votaciones FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY sel ON opciones_voto FOR SELECT TO app_service USING (EXISTS (SELECT 1 FROM votaciones v WHERE v.id = opciones_voto.votacion_id));
CREATE POLICY ins ON opciones_voto FOR INSERT TO app_service WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON opciones_voto FOR UPDATE TO app_service USING (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY sel ON votos FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_staff())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));

-- Auditoría (lectura) y webhooks (la API solo inserta; nunca lee payloads)
CREATE POLICY sel ON audit_log FOR SELECT TO app_service
  USING (org_id = ANY ((SELECT app.orgs_lectura())::uuid[]) OR coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]));
CREATE POLICY ins ON webhook_events FOR INSERT TO app_service WITH CHECK (true);

-- 5d. Privilegios. Sin GRANT no hay acceso aunque exista política (y viceversa).
--     Sin DELETE en nada de negocio: se desactiva (activo=false) o cambia de estado.
GRANT SELECT ON
  organizaciones, org_miembros, partner_api_keys, paquetes_timbres, soporte_accesos, usuarios,
  cotos, sectores, unidades, miembros_coto, conceptos_cargo, cargos, pagos, detalle_pagos,
  payment_methods, autopay_config, autopay_intentos, facturas_cfdi, cuentas_bancarias, proveedores,
  egresos, invitaciones_acceso, registros_acceso, dispositivos_iot, amenidades, reservaciones,
  comunicados, tickets, ticket_comentarios, votaciones, opciones_voto, votos, audit_log
TO app_service;
GRANT INSERT ON
  org_miembros, partner_api_keys, soporte_accesos, cotos, sectores, unidades, miembros_coto,
  conceptos_cargo, cargos, pagos, detalle_pagos, payment_methods, autopay_config, cuentas_bancarias,
  proveedores, egresos, invitaciones_acceso, registros_acceso, dispositivos_iot, amenidades,
  reservaciones, comunicados, tickets, ticket_comentarios, votaciones, opciones_voto, webhook_events
TO app_service;
GRANT UPDATE ON
  org_miembros, partner_api_keys, soporte_accesos, cotos, sectores, unidades, miembros_coto,
  conceptos_cargo, cargos, pagos, payment_methods, autopay_config, cuentas_bancarias, proveedores,
  egresos, invitaciones_acceso, dispositivos_iot, amenidades, reservaciones, comunicados, tickets,
  votaciones, opciones_voto
TO app_service;
-- Billing, tier, wallet y estado de suscripción solo los cambia el back-office (app_worker).
GRANT UPDATE (nombre, razon_social, rfc, email_contacto, telefono, custom_domain, logo_url, color_primario,
              color_secundario, favicon_url, aviso_privacidad_url, aviso_version, updated_at)
  ON organizaciones TO app_service;
-- Email, auth_id, MFA y verificación de teléfono solo cambian por el flujo de autenticación.
GRANT UPDATE (nombre, apellido_paterno, apellido_materno, telefono, acepto_aviso_privacidad,
              fecha_aceptacion_aviso, version_aviso_aceptado, updated_at)
  ON usuarios TO app_service;
GRANT USAGE ON SEQUENCE tickets_numero_seq TO app_service;

DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO app_worker', t);
  END LOOP;
END $$;
REVOKE UPDATE ON audit_log, votos, registros_acceso, detalle_pagos FROM app_worker;
GRANT DELETE ON audit_outbox, webhook_events TO app_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_worker;

-- ─── 6. Consultas de alto tráfico (una ida y vuelta, índices verificados) ──
-- INVOKER = respetan RLS. Las SECURITY DEFINER validan permisos explícitamente
-- y solo devuelven agregados o lo mínimo necesario.

-- Residente · "¿Cuánto debo?"  → índice cargos(unidad_id, estado, fecha_vencimiento)
CREATE FUNCTION app.estado_cuenta(p_unidad uuid)
RETURNS TABLE (cargo_id uuid, concepto text, periodo text, vence date, saldo numeric, vencido boolean, total_pendiente numeric)
LANGUAGE sql STABLE AS $$
  SELECT g.id, cc.nombre::text, g.periodo::text, g.fecha_vencimiento, g.saldo_pendiente,
         g.fecha_vencimiento < (now() AT TIME ZONE co.zona_horaria)::date,
         sum(g.saldo_pendiente) OVER ()
    FROM cargos g
    JOIN conceptos_cargo cc ON cc.id = g.concepto_id
    JOIN cotos co ON co.id = g.coto_id
   WHERE g.unidad_id = p_unidad AND g.estado IN ('pendiente','parcial')
   ORDER BY g.fecha_vencimiento, g.created_at
$$;

-- Administración / mesa directiva / despacho · KPIs de 1..N cotos en UNA consulta
-- (sin N+1 para despachos con cientos de cotos). Llamar con p_cotos o con p_org.
-- Cada LATERAL entra por su índice exacto del coto: el costo crece con los cotos
-- consultados, no con el tamaño total de la plataforma.
CREATE FUNCTION app.resumen_cotos(p_cotos uuid[] DEFAULT NULL, p_org uuid DEFAULT NULL)
RETURNS TABLE (coto_id uuid, coto text, unidades integer, emitido_mes numeric, cobrado_mes numeric, pct_cobrado numeric,
               adeudo_vencido numeric, unidades_morosas integer, pagos_por_revisar integer, tickets_abiertos integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH cs AS (
    SELECT c.id, c.nombre, c.dias_gracia, (now() AT TIME ZONE c.zona_horaria)::date AS hoy
      FROM cotos c
     WHERE (c.id = ANY (p_cotos) OR (c.org_id = p_org AND c.activo))
       AND c.id = ANY ((SELECT app.cotos_staff())::uuid[])
       AND ((SELECT app.coto_activo()) IS NULL OR c.id = (SELECT app.coto_activo()))
  )
  SELECT cs.id, cs.nombre::text, un.n::int,
         coalesce(mes.emitido, 0), coalesce(mes.cobrado, 0), round(100 * mes.cobrado / nullif(mes.emitido, 0), 1),
         coalesce(ven.vencido, 0), ven.morosas::int, pg.n::int, tk.n::int
    FROM cs
   CROSS JOIN LATERAL (SELECT count(*) AS n FROM unidades u WHERE u.coto_id = cs.id AND u.activo) un
   CROSS JOIN LATERAL (                                   -- índice cargos(coto_id, periodo)
     SELECT sum(g.monto_original + g.monto_moratoria - g.monto_descuento) AS emitido,
            sum(g.monto_original + g.monto_moratoria - g.monto_descuento - g.saldo_pendiente) AS cobrado
       FROM cargos g
      WHERE g.coto_id = cs.id AND g.periodo = to_char(cs.hoy, 'YYYY-MM') AND g.estado NOT IN ('cancelado','condonado')) mes
   CROSS JOIN LATERAL (                                   -- índice cargos(coto_id, estado, fecha_vencimiento)
     SELECT sum(g.saldo_pendiente) AS vencido, count(DISTINCT g.unidad_id) AS morosas
       FROM cargos g
      WHERE g.coto_id = cs.id AND g.estado IN ('pendiente','parcial') AND g.fecha_vencimiento < cs.hoy - cs.dias_gracia) ven
   CROSS JOIN LATERAL (SELECT count(*) AS n FROM pagos p WHERE p.coto_id = cs.id AND p.estado IN ('pendiente','en_revision')) pg
   CROSS JOIN LATERAL (SELECT count(*) AS n FROM tickets t WHERE t.coto_id = cs.id AND t.estado IN ('abierto','en_proceso','esperando_residente')) tk
   ORDER BY coalesce(ven.vencido, 0) DESC, cs.nombre
$$;

-- Tesorería · morosos por unidad (INVOKER: el comité no la ve, RLS de cargos)
CREATE FUNCTION app.morosidad(p_coto uuid)
RETURNS TABLE (unidad_id uuid, unidad text, adeudo numeric, cargos_vencidos integer, vencido_desde date, meses_atraso integer)
LANGUAGE sql STABLE AS $$
  WITH h AS (SELECT (now() AT TIME ZONE c.zona_horaria)::date AS hoy, c.dias_gracia FROM cotos c WHERE c.id = p_coto)
  SELECT u.id, u.numero::text, sum(g.saldo_pendiente), count(*)::int, min(g.fecha_vencimiento),
         (extract(year FROM age(h.hoy, min(g.fecha_vencimiento))) * 12 + extract(month FROM age(h.hoy, min(g.fecha_vencimiento))))::int
    FROM h
    JOIN cargos g ON g.coto_id = p_coto AND g.estado IN ('pendiente','parcial') AND g.fecha_vencimiento < h.hoy - h.dias_gracia
    JOIN unidades u ON u.id = g.unidad_id
   GROUP BY u.id, u.numero, h.hoy
   ORDER BY 3 DESC
$$;

-- Mesa directiva · ingresos vs egresos por mes (agregado; hora local del coto)
CREATE FUNCTION app.balance_mensual(p_coto uuid, p_meses integer DEFAULT 12)
RETURNS TABLE (mes date, ingresos numeric, egresos numeric, neto numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH co AS (
    SELECT c.id, c.zona_horaria,
           (date_trunc('month', now() AT TIME ZONE c.zona_horaria)
             - make_interval(months => least(greatest(p_meses, 1), 36) - 1))::date AS desde
      FROM cotos c
     WHERE c.id = p_coto AND c.id = ANY ((SELECT app.cotos_staff())::uuid[])
  ),
  meses AS (SELECT generate_series(co.desde, (now() AT TIME ZONE co.zona_horaria)::date, interval '1 month')::date AS mes FROM co),
  ing AS (
    SELECT date_trunc('month', p.fecha_pago AT TIME ZONE co.zona_horaria)::date AS mes, sum(p.monto) AS total
      FROM co JOIN pagos p ON p.coto_id = co.id AND p.estado = 'confirmado'
                          AND p.fecha_pago >= (co.desde::timestamp AT TIME ZONE co.zona_horaria)
     GROUP BY 1),
  egr AS (
    SELECT date_trunc('month', e.fecha)::date AS mes, sum(e.monto) AS total
      FROM co JOIN egresos e ON e.coto_id = co.id AND e.estado IN ('aprobado','pagado') AND e.fecha >= co.desde
     GROUP BY 1)
  SELECT m.mes, coalesce(i.total, 0), coalesce(e.total, 0), coalesce(i.total, 0) - coalesce(e.total, 0)
    FROM meses m
    LEFT JOIN ing i ON i.mes = m.mes
    LEFT JOIN egr e ON e.mes = m.mes
   ORDER BY m.mes
$$;

-- Administración · cargos del mes para todas las unidades. Idempotente: repetirla
-- (doble clic, reintento, cron duplicado) no duplica cargos. RLS: solo admin.
CREATE FUNCTION app.generar_cargos(p_coto uuid, p_concepto uuid, p_periodo text,
                                   p_monto numeric DEFAULT NULL, p_vencimiento date DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  cc conceptos_cargo%ROWTYPE;
  v_monto numeric;
  v_vence date;
  v_n integer;
BEGIN
  IF p_periodo !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Periodo inválido (AAAA-MM)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO cc FROM conceptos_cargo WHERE id = p_concepto AND coto_id = p_coto AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concepto no encontrado en este coto' USING ERRCODE = 'no_data_found';
  END IF;
  v_monto := coalesce(p_monto, cc.monto_default);            -- con indiviso: monto TOTAL a repartir
  IF v_monto IS NULL OR v_monto <= 0 THEN
    RAISE EXCEPTION 'Falta el monto' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cc.usa_indiviso AND EXISTS (SELECT 1 FROM unidades WHERE coto_id = p_coto AND activo AND indiviso IS NULL) THEN
    RAISE EXCEPTION 'Hay unidades activas sin indiviso' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(p_vencimiento, make_date(split_part(p_periodo, '-', 1)::int, split_part(p_periodo, '-', 2)::int, c.dia_limite_pago))
    INTO v_vence FROM cotos c WHERE c.id = p_coto;

  INSERT INTO cargos (coto_id, unidad_id, concepto_id, periodo, monto_original, saldo_pendiente, fecha_vencimiento, clave_idempotencia)
  SELECT u.coto_id, u.id, cc.id, p_periodo, m.monto, m.monto, v_vence, format('m:%s:%s:%s', cc.id, p_periodo, u.id)
    FROM unidades u
   CROSS JOIN LATERAL (SELECT round(CASE WHEN cc.usa_indiviso THEN v_monto * u.indiviso ELSE v_monto END, 2) AS monto) m
   WHERE u.coto_id = p_coto AND u.activo AND m.monto > 0
  ON CONFLICT (clave_idempotencia) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Administración / worker · aplica un pago confirmado a los cargos más antiguos.
-- Bloquea pago y cargos en orden fijo (sin deadlocks) y es idempotente (aplicado_en).
-- Devuelve el remanente que pasó a saldo a favor.
CREATE FUNCTION app.aplicar_pago(p_pago uuid) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
  v_pago pagos%ROWTYPE;
  v_resto numeric;
  v_aplicar numeric;
  r record;
BEGIN
  SELECT * INTO v_pago FROM pagos WHERE id = p_pago FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_pago.estado <> 'confirmado' THEN
    RAISE EXCEPTION 'El pago no está confirmado' USING ERRCODE = 'check_violation';
  END IF;
  IF v_pago.aplicado_en IS NOT NULL THEN
    RETURN 0;
  END IF;
  v_resto := v_pago.monto;
  FOR r IN SELECT g.id, g.saldo_pendiente FROM cargos g
            WHERE g.unidad_id = v_pago.unidad_id AND g.estado IN ('pendiente','parcial')
            ORDER BY g.fecha_vencimiento, g.created_at, g.id
            FOR UPDATE LOOP
    EXIT WHEN v_resto <= 0;
    v_aplicar := least(v_resto, r.saldo_pendiente);
    INSERT INTO detalle_pagos (coto_id, pago_id, cargo_id, monto_aplicado) VALUES (v_pago.coto_id, p_pago, r.id, v_aplicar);
    UPDATE cargos SET saldo_pendiente = saldo_pendiente - v_aplicar,
                      estado = CASE WHEN saldo_pendiente - v_aplicar = 0 THEN 'pagado' ELSE 'parcial' END
     WHERE id = r.id;
    v_resto := v_resto - v_aplicar;
  END LOOP;
  IF v_resto > 0 THEN
    UPDATE unidades SET saldo_a_favor = saldo_a_favor + v_resto WHERE id = v_pago.unidad_id;
  END IF;
  UPDATE pagos SET aplicado_en = now() WHERE id = p_pago;
  RETURN v_resto;
END $$;

-- Caseta · "¿Lo dejo pasar?" Valida y consume el pase en una sola operación
-- atómica (un QR de un uso no entra dos veces aunque dos guardias escaneen a la vez),
-- registra el intento (también los fallidos) y frena la fuerza bruta de códigos.
-- Recibe el SHA-256 del token: el QR en claro nunca llega a la BD ni a sus logs.
CREATE FUNCTION app.validar_acceso(p_coto uuid, p_token_hash text DEFAULT NULL, p_codigo text DEFAULT NULL)
RETURNS TABLE (autorizado boolean, motivo text, invitado text, unidad text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_guardia uuid := app.uid();
  v_metodo text := CASE WHEN p_token_hash IS NOT NULL THEN 'qr' ELSE 'codigo' END;
  v_inv invitaciones_acceso%ROWTYPE;
  v_ok boolean;
BEGIN
  IF v_guardia IS NULL OR NOT (p_coto = ANY (app.cotos_guardia())) THEN
    RAISE EXCEPTION 'Sin permiso de caseta en este coto' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL AND p_codigo IS NULL THEN
    RAISE EXCEPTION 'Falta el QR o el código' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- ponytail: freno por coto (20 fallos / 10 min); por dispositivo si una caseta grande lo pide
  IF v_metodo = 'codigo' AND (SELECT count(*) FROM registros_acceso r
       WHERE r.coto_id = p_coto AND r.metodo = 'codigo' AND NOT r.autorizado
         AND r.fecha_hora > now() - interval '10 minutes') >= 20 THEN
    RETURN QUERY SELECT false, 'Demasiados códigos incorrectos. Espera 10 minutos o llama al residente.'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_metodo = 'qr' THEN
    SELECT i.* INTO v_inv FROM invitaciones_acceso i
     WHERE i.token_hash = p_token_hash AND i.coto_id = p_coto AND i.estado = 'activo'
       AND now() >= i.valido_desde AND (i.valido_hasta IS NULL OR now() < i.valido_hasta)
       AND (i.max_usos IS NULL OR i.usos_actuales < i.max_usos)
     FOR UPDATE;
  ELSE
    SELECT i.* INTO v_inv FROM invitaciones_acceso i
     WHERE i.coto_id = p_coto AND i.codigo_numerico = p_codigo AND i.estado = 'activo'
       AND now() >= i.valido_desde AND now() < i.valido_hasta
       AND (i.max_usos IS NULL OR i.usos_actuales < i.max_usos)
     ORDER BY i.created_at DESC LIMIT 1
     FOR UPDATE;
  END IF;
  v_ok := FOUND;

  IF v_ok THEN
    UPDATE invitaciones_acceso
       SET usos_actuales = usos_actuales + 1,
           estado = CASE WHEN max_usos IS NOT NULL AND usos_actuales + 1 >= max_usos THEN 'usado' ELSE estado END
     WHERE id = v_inv.id;
  END IF;

  INSERT INTO registros_acceso (coto_id, invitacion_id, unidad_destino, guardia_id, tipo_persona, nombre, metodo, tipo_movimiento, autorizado)
  VALUES (p_coto, v_inv.id, v_inv.unidad_id, v_guardia, 'visitante', v_inv.nombre_invitado, v_metodo, 'entrada', v_ok);

  RETURN QUERY
  SELECT v_ok,
         CASE WHEN v_ok THEN 'Adelante' ELSE 'Código no válido o vencido' END,
         split_part(v_inv.nombre_invitado, ' ', 1),                -- solo nombre de pila en pantalla
         (SELECT u.numero::text FROM unidades u WHERE u.id = v_inv.unidad_id);
END $$;

-- Residente · horarios ocupados de una amenidad, sin decir quién los apartó.
CREATE FUNCTION app.ocupacion_amenidad(p_amenidad uuid, p_desde date, p_hasta date)
RETURNS TABLE (fecha date, hora_inicio time, hora_fin time)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.fecha, r.hora_inicio, r.hora_fin
    FROM amenidades a
    JOIN reservaciones r ON r.amenidad_id = a.id
                        AND r.fecha BETWEEN p_desde AND least(p_hasta, p_desde + 62)
                        AND r.estado IN ('pendiente','confirmada')
   WHERE a.id = p_amenidad AND a.coto_id = ANY ((SELECT app.cotos_miembro())::uuid[])
   ORDER BY r.fecha, r.hora_inicio
$$;

-- ¿La unidad está al corriente? (para apartar amenidades). Solo su gente o staff:
-- un vecino no puede averiguar si otro debe (LFPDPPP).
CREATE FUNCTION app.unidad_al_corriente(p_unidad uuid)
RETURNS TABLE (al_corriente boolean, meses_atraso integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT min(g.fecha_vencimiento) IS NULL,
         coalesce((extract(year FROM age(h.hoy, min(g.fecha_vencimiento))) * 12
                 + extract(month FROM age(h.hoy, min(g.fecha_vencimiento))))::int, 0)
    FROM unidades u
    JOIN cotos c ON c.id = u.coto_id
   CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE c.zona_horaria)::date AS hoy) h
    LEFT JOIN cargos g ON g.unidad_id = u.id AND g.estado IN ('pendiente','parcial') AND g.fecha_vencimiento < h.hoy - c.dias_gracia
   WHERE u.id = p_unidad
     AND (u.id = ANY ((SELECT app.unidades_mias())::uuid[]) OR u.coto_id = ANY ((SELECT app.cotos_staff())::uuid[]))
   GROUP BY h.hoy
$$;

-- Propietario · emite su voto. La unidad, el peso y la membresía los decide la BD,
-- no el cliente. Un voto por unidad (UNIQUE) e inmutable (trigger).
CREATE FUNCTION app.votar(p_votacion uuid, p_opcion uuid, p_unidad uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_miembro miembros_coto%ROWTYPE;
  v_votacion votaciones%ROWTYPE;
  v_peso numeric := 1;
  v_id uuid;
BEGIN
  SELECT m.* INTO v_miembro FROM miembros_coto m
   WHERE m.usuario_id = app.uid() AND m.unidad_id = p_unidad AND m.rol = 'residente_propietario' AND m.activo
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solo la persona propietaria de la unidad puede votar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT v.* INTO v_votacion FROM votaciones v
   WHERE v.id = p_votacion AND v.coto_id = v_miembro.coto_id AND v.estado = 'activa'
     AND now() >= v.fecha_inicio AND now() < v.fecha_fin
     AND EXISTS (SELECT 1 FROM opciones_voto o WHERE o.id = p_opcion AND o.votacion_id = v.id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La votación no está abierta o la opción no existe' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_votacion.ponderada_por_indiviso THEN
    SELECT u.indiviso INTO v_peso FROM unidades u WHERE u.id = p_unidad;
    IF v_peso IS NULL THEN
      RAISE EXCEPTION 'La unidad no tiene indiviso registrado' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO votos (votacion_id, coto_id, opcion_id, miembro_id, unidad_id, peso)
  VALUES (p_votacion, v_miembro.coto_id, p_opcion, v_miembro.id, p_unidad, v_peso)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Esta unidad ya votó' USING ERRCODE = 'unique_violation';
END $$;

-- Administración · guarda el CSD ya cifrado (encryptField). Nadie en la API puede
-- leerlo de vuelta; solo el worker de timbrado (app_worker).
CREATE FUNCTION app.guardar_csd(p_coto uuid, p_cert bytea, p_key bytea, p_password bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (p_coto = ANY (app.cotos_admin())) THEN
    RAISE EXCEPTION 'Sin permiso' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO coto_secretos (coto_id, csd_cert, csd_key, csd_password, updated_at)
  VALUES (p_coto, p_cert, p_key, p_password, now())
  ON CONFLICT (coto_id) DO UPDATE
    SET csd_cert = EXCLUDED.csd_cert, csd_key = EXCLUDED.csd_key, csd_password = EXCLUDED.csd_password, updated_at = now();
END $$;

-- Marca blanca antes del login (middleware por Host). Solo datos públicos de marca.
-- La app decide si el host es dominio propio o subdominio "<slug>.<BASE_DOMAIN>".
CREATE FUNCTION app.marca(p_dominio text DEFAULT NULL, p_slug text DEFAULT NULL)
RETURNS TABLE (org_id uuid, nombre text, logo_url text, color_primario text, color_secundario text, favicon_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT o.id, o.nombre::text, o.logo_url, o.color_primario::text, o.color_secundario::text, o.favicon_url
    FROM organizaciones o
   WHERE o.activo AND (o.custom_domain = lower(p_dominio) OR o.slug = lower(p_slug))
   ORDER BY (o.custom_domain = lower(p_dominio)) DESC NULLS LAST
   LIMIT 1
$$;

-- ─── 7. Ejecución de funciones ──────────────────────────────────────
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_service, app_worker;
