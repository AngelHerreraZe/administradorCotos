-- ════════════════════════════════════════════════════════════════════
-- FASE 2 Y 3: FINANZAS, MORATORIOS, EGRESOS, PAGOS EN LÍNEA, AUTO-PAY Y CFDI
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. Columnas y restricciones en tablas existentes ────────────────
ALTER TABLE organizaciones
  ADD COLUMN stripe_subscription_id varchar(100),
  ADD COLUMN stripe_sub_item_id varchar(100);

ALTER TABLE cotos
  ADD COLUMN facturapi_org_id varchar(100),
  ADD COLUMN base_moratoria varchar(10) NOT NULL DEFAULT 'capital';

ALTER TABLE cotos
  ADD CONSTRAINT cotos_base_moratoria_ck CHECK (base_moratoria IN ('capital', 'saldo'));

-- Secretos por coto: CSD (Opción B o legado) y llave privada por organización en PAC (Opción A)
ALTER TABLE coto_secretos
  DROP CONSTRAINT coto_secretos_cifrado_ck,
  ALTER COLUMN csd_cert DROP NOT NULL,
  ALTER COLUMN csd_key DROP NOT NULL,
  ALTER COLUMN csd_password DROP NOT NULL,
  ADD COLUMN facturapi_api_key_enc bytea;

ALTER TABLE coto_secretos
  ADD CONSTRAINT coto_secretos_cifrado_ck CHECK (
        (csd_cert IS NULL OR get_byte(csd_cert, 0) = 1)
    AND (csd_key IS NULL OR get_byte(csd_key, 0) = 1)
    AND (csd_password IS NULL OR get_byte(csd_password, 0) = 1)
    AND (facturapi_api_key_enc IS NULL OR get_byte(facturapi_api_key_enc, 0) = 1)
  );

DROP TRIGGER IF EXISTS auditar ON coto_secretos;
CREATE TRIGGER auditar AFTER INSERT OR UPDATE OR DELETE ON coto_secretos
  FOR EACH ROW EXECUTE FUNCTION app.tg_auditar('csd_cert', 'csd_key', 'csd_password', 'facturapi_api_key_enc');

ALTER TABLE pagos
  ADD COLUMN clave_rastreo varchar(50),
  ADD COLUMN clave_idempotencia varchar(100),
  ADD COLUMN motivo_rechazo text,
  ADD COLUMN notas text,
  ADD COLUMN gateway_metadata jsonb;

CREATE UNIQUE INDEX pagos_coto_clave_rastreo_key ON pagos (coto_id, clave_rastreo);
CREATE UNIQUE INDEX pagos_clave_idempotencia_key ON pagos (clave_idempotencia);

ALTER TABLE autopay_config
  ADD COLUMN terminos_version varchar(30),
  ADD COLUMN terminos_aceptados_en timestamptz,
  ADD COLUMN activado_por uuid REFERENCES usuarios(id);

CREATE INDEX autopay_config_activado_por_idx ON autopay_config (activado_por);

ALTER TABLE autopay_config
  ADD CONSTRAINT autopay_config_consentimiento_ck
  CHECK (NOT activo OR (
    payment_method_id IS NOT NULL
    AND terminos_version IS NOT NULL
    AND terminos_aceptados_en IS NOT NULL
    AND activado_por IS NOT NULL
  ));

ALTER TABLE autopay_intentos
  ADD COLUMN clave_idempotencia varchar(100);

CREATE UNIQUE INDEX autopay_intentos_clave_idempotencia_key ON autopay_intentos (clave_idempotencia);
CREATE INDEX autopay_intentos_cargo_id_idx ON autopay_intentos (cargo_id);
CREATE INDEX autopay_intentos_pago_id_idx ON autopay_intentos (pago_id);

-- CFDI: permite estado pendiente/fallido e re-timbrado tras cancelación sobre el mismo pago
DROP INDEX IF EXISTS facturas_cfdi_pago_id_key;
CREATE INDEX facturas_cfdi_pago_id_idx ON facturas_cfdi (pago_id);

ALTER TABLE facturas_cfdi
  ADD COLUMN pac_invoice_id varchar(100),
  ADD COLUMN tipo_comprobante char(1) NOT NULL DEFAULT 'I',
  ADD COLUMN emisor_regimen varchar(5),
  ADD COLUMN receptor_regimen varchar(5),
  ADD COLUMN receptor_cp varchar(5),
  ADD COLUMN receptor_uso_cfdi varchar(5),
  ADD COLUMN moneda char(3) NOT NULL DEFAULT 'MXN',
  ADD COLUMN metodo_pago varchar(3),
  ADD COLUMN forma_pago varchar(2),
  ADD COLUMN pac_utilizado varchar(30) NOT NULL DEFAULT 'facturapi',
  ADD COLUMN motivo_cancelacion char(2),
  ADD COLUMN sustitucion_uuid varchar(36),
  ADD COLUMN cancelado_en timestamptz,
  ADD COLUMN clave_idempotencia varchar(100),
  ADD COLUMN paquete_timbre_id uuid REFERENCES paquetes_timbres(id);

CREATE UNIQUE INDEX facturas_cfdi_pago_activo_key ON facturas_cfdi (pago_id)
  WHERE pago_id IS NOT NULL AND estado NOT IN ('cancelado', 'fallido');
CREATE UNIQUE INDEX facturas_cfdi_pac_invoice_id_key ON facturas_cfdi (pac_invoice_id);
CREATE UNIQUE INDEX facturas_cfdi_clave_idempotencia_key ON facturas_cfdi (clave_idempotencia);

ALTER TABLE facturas_cfdi
  ADD CONSTRAINT facturas_cfdi_estado_ck CHECK (
    estado IN ('pendiente', 'timbrado', 'pendiente_cancelacion', 'cancelado', 'fallido')
  ),
  ADD CONSTRAINT facturas_cfdi_tipo_ck CHECK (tipo_comprobante IN ('I', 'P')),
  ADD CONSTRAINT facturas_cfdi_cancelacion_ck CHECK (
    motivo_cancelacion IS NULL OR motivo_cancelacion IN ('01', '02', '03', '04')
  );

ALTER TABLE paquetes_timbres
  ADD CONSTRAINT paquetes_timbres_estado_ck CHECK (estado IN ('activo', 'agotado', 'expirado'));

ALTER TABLE egresos
  ADD COLUMN categoria varchar(40) NOT NULL DEFAULT 'mantenimiento',
  ADD COLUMN solicitado_por uuid REFERENCES usuarios(id),
  ADD COLUMN aprobado_por uuid REFERENCES usuarios(id),
  ADD COLUMN aprobado_en timestamptz,
  ADD COLUMN rechazado_en timestamptz,
  ADD COLUMN motivo_rechazo text,
  ADD COLUMN tiene_factura boolean NOT NULL DEFAULT false,
  ADD COLUMN factura_uuid varchar(36),
  ADD COLUMN comprobante_url text,
  ADD COLUMN notas text,
  ADD COLUMN clave_idempotencia varchar(100),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX egresos_clave_idempotencia_key ON egresos (clave_idempotencia);
CREATE INDEX egresos_cuenta_bancaria_id_idx ON egresos (cuenta_bancaria_id);
CREATE INDEX egresos_proveedor_id_idx ON egresos (proveedor_id);
CREATE INDEX egresos_solicitado_por_idx ON egresos (solicitado_por);
CREATE INDEX egresos_aprobado_por_idx ON egresos (aprobado_por);

ALTER TABLE egresos
  ADD CONSTRAINT egresos_solicitante_ck
  CHECK (aprobado_por IS NULL OR solicitado_por IS NULL OR aprobado_por IS DISTINCT FROM solicitado_por);

-- ─── 2. Tablas moratorios_aplicados y aplicaciones_saldo_favor (§3.4) ───
CREATE TABLE moratorios_aplicados (
  cargo_id uuid NOT NULL REFERENCES cargos(id),
  coto_id uuid NOT NULL REFERENCES cotos(id),
  unidad_id uuid NOT NULL REFERENCES unidades(id),
  periodo varchar(7) NOT NULL CHECK (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fecha_corte date NOT NULL,
  monto numeric(12, 2) NOT NULL CHECK (monto > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cargo_id, periodo)
);

CREATE INDEX moratorios_aplicados_coto_periodo_idx ON moratorios_aplicados (coto_id, periodo);
CREATE INDEX moratorios_aplicados_unidad_id_idx ON moratorios_aplicados (unidad_id);

ALTER TABLE moratorios_aplicados ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker ON moratorios_aplicados TO app_worker USING (true) WITH CHECK (true);
CREATE POLICY coto_activo ON moratorios_aplicados AS RESTRICTIVE TO app_service
  USING ((SELECT app.coto_activo()) IS NULL OR coto_id = (SELECT app.coto_activo()));
CREATE POLICY sel ON moratorios_aplicados FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));

GRANT SELECT ON moratorios_aplicados TO app_service;
GRANT SELECT, INSERT ON moratorios_aplicados TO app_worker;

CREATE TRIGGER mismo_coto BEFORE INSERT OR UPDATE OF coto_id, cargo_id, unidad_id ON moratorios_aplicados
  FOR EACH ROW EXECUTE FUNCTION app.tg_mismo_coto('cargo_id', 'cargos', 'unidad_id', 'unidades');
CREATE TRIGGER solo_insercion BEFORE UPDATE OR DELETE ON moratorios_aplicados
  FOR EACH ROW EXECUTE FUNCTION app.tg_solo_insercion();
CREATE TRIGGER solo_insercion_truncate BEFORE TRUNCATE ON moratorios_aplicados
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_solo_insercion();
CREATE TRIGGER auditar AFTER INSERT ON moratorios_aplicados
  FOR EACH ROW EXECUTE FUNCTION app.tg_auditar();

-- Libro inmutable de aplicaciones de saldo a favor (conciliación FIFO por cargo)
CREATE TABLE aplicaciones_saldo_favor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coto_id uuid NOT NULL REFERENCES cotos(id),
  unidad_id uuid NOT NULL REFERENCES unidades(id),
  cargo_id uuid NOT NULL REFERENCES cargos(id),
  monto_aplicado numeric(12, 2) NOT NULL CHECK (monto_aplicado > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX aplicaciones_saldo_favor_coto_created_idx ON aplicaciones_saldo_favor (coto_id, created_at);
CREATE INDEX aplicaciones_saldo_favor_unidad_created_idx ON aplicaciones_saldo_favor (unidad_id, created_at);
CREATE INDEX aplicaciones_saldo_favor_cargo_idx ON aplicaciones_saldo_favor (cargo_id);

ALTER TABLE aplicaciones_saldo_favor ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker ON aplicaciones_saldo_favor TO app_worker USING (true) WITH CHECK (true);
CREATE POLICY coto_activo ON aplicaciones_saldo_favor AS RESTRICTIVE TO app_service
  USING ((SELECT app.coto_activo()) IS NULL OR coto_id = (SELECT app.coto_activo()));
CREATE POLICY sel ON aplicaciones_saldo_favor FOR SELECT TO app_service
  USING (coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]) OR unidad_id = ANY ((SELECT app.unidades_propias())::uuid[]));

GRANT SELECT ON aplicaciones_saldo_favor TO app_service;
GRANT SELECT, INSERT ON aplicaciones_saldo_favor TO app_worker;

CREATE TRIGGER mismo_coto BEFORE INSERT OR UPDATE OF coto_id, unidad_id, cargo_id ON aplicaciones_saldo_favor
  FOR EACH ROW EXECUTE FUNCTION app.tg_mismo_coto('unidad_id', 'unidades', 'cargo_id', 'cargos');
CREATE TRIGGER solo_insercion BEFORE UPDATE OR DELETE ON aplicaciones_saldo_favor
  FOR EACH ROW EXECUTE FUNCTION app.tg_solo_insercion();
CREATE TRIGGER solo_insercion_truncate BEFORE TRUNCATE ON aplicaciones_saldo_favor
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_solo_insercion();
CREATE TRIGGER auditar AFTER INSERT ON aplicaciones_saldo_favor
  FOR EACH ROW EXECUTE FUNCTION app.tg_auditar();

-- ─── 3. Triggers de integridad financiera y consentimiento ──────────
DROP TRIGGER IF EXISTS inmutable ON pagos;
CREATE FUNCTION app.tg_pagos_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coto_id IS DISTINCT FROM OLD.coto_id
     OR NEW.unidad_id IS DISTINCT FROM OLD.unidad_id
     OR NEW.monto IS DISTINCT FROM OLD.monto
     OR NEW.clave_idempotencia IS DISTINCT FROM OLD.clave_idempotencia THEN
    RAISE EXCEPTION 'Columna financiera inmutable en pagos' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.gateway_order_id IS NOT NULL AND NEW.gateway_order_id IS DISTINCT FROM OLD.gateway_order_id THEN
    RAISE EXCEPTION 'gateway_order_id de pagos no se puede modificar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.gateway_charge_id IS NOT NULL AND NEW.gateway_charge_id IS DISTINCT FROM OLD.gateway_charge_id THEN
    RAISE EXCEPTION 'gateway_charge_id de pagos no se puede modificar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.clave_rastreo IS NOT NULL AND NEW.clave_rastreo IS DISTINCT FROM OLD.clave_rastreo THEN
    RAISE EXCEPTION 'clave_rastreo de pagos no se puede modificar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.gateway_metadata IS NOT NULL AND NEW.gateway_metadata IS DISTINCT FROM OLD.gateway_metadata THEN
    RAISE EXCEPTION 'gateway_metadata de pagos no se puede modificar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inmutable BEFORE UPDATE ON pagos
  FOR EACH ROW EXECUTE FUNCTION app.tg_pagos_inmutable();

DROP TRIGGER IF EXISTS inmutable ON facturas_cfdi;
CREATE FUNCTION app.tg_facturas_cfdi_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coto_id IS DISTINCT FROM OLD.coto_id
     OR NEW.pago_id IS DISTINCT FROM OLD.pago_id
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.clave_idempotencia IS DISTINCT FROM OLD.clave_idempotencia THEN
    RAISE EXCEPTION 'Columna inmutable en facturas_cfdi' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.pac_invoice_id IS NOT NULL AND NEW.pac_invoice_id IS DISTINCT FROM OLD.pac_invoice_id THEN
    RAISE EXCEPTION 'pac_invoice_id de facturas_cfdi no se puede modificar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.uuid_cfdi IS NOT NULL AND NEW.uuid_cfdi IS DISTINCT FROM OLD.uuid_cfdi THEN
    RAISE EXCEPTION 'uuid_cfdi de facturas_cfdi no se puede modificar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.estado = 'cancelado' AND NEW.estado IS DISTINCT FROM 'cancelado' THEN
    RAISE EXCEPTION 'Una factura cancelada no puede reactivarse' USING ERRCODE = 'UA409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inmutable BEFORE UPDATE ON facturas_cfdi
  FOR EACH ROW EXECUTE FUNCTION app.tg_facturas_cfdi_inmutable();

-- En egresos: creación forzada a pendiente; cambios de estado e inmutabilidad post-aprobación en Postgres.
DROP TRIGGER IF EXISTS inmutable ON egresos;
CREATE FUNCTION app.tg_egresos_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'app_service' THEN
    NEW.solicitado_por := app.uid();
    NEW.aprobado_por := NULL;
    NEW.aprobado_en := NULL;
    NEW.rechazado_en := NULL;
    NEW.motivo_rechazo := NULL;
    NEW.estado := 'pendiente';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER egresos_defaults BEFORE INSERT ON egresos
  FOR EACH ROW EXECUTE FUNCTION app.tg_egresos_defaults();

CREATE FUNCTION app.tg_egresos_protegidos() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coto_id IS DISTINCT FROM OLD.coto_id
     OR NEW.solicitado_por IS DISTINCT FROM OLD.solicitado_por
     OR NEW.clave_idempotencia IS DISTINCT FROM OLD.clave_idempotencia THEN
    RAISE EXCEPTION 'Columna inmutable en egresos' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF current_user = 'app_service' THEN
    IF OLD.estado <> 'pendiente' THEN
      RAISE EXCEPTION 'Un egreso ya dictaminado solo cambia mediante funciones autorizadas' USING ERRCODE = 'UA403';
    END IF;
    IF NEW.estado IS DISTINCT FROM OLD.estado
       OR NEW.aprobado_por IS DISTINCT FROM OLD.aprobado_por
       OR NEW.aprobado_en IS DISTINCT FROM OLD.aprobado_en
       OR NEW.rechazado_en IS DISTINCT FROM OLD.rechazado_en
       OR NEW.motivo_rechazo IS DISTINCT FROM OLD.motivo_rechazo THEN
      RAISE EXCEPTION 'El dictamen de egresos solo puede ejecutarse mediante aprobar o rechazar' USING ERRCODE = 'UA403';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inmutable BEFORE UPDATE ON egresos
  FOR EACH ROW EXECUTE FUNCTION app.tg_egresos_protegidos();

-- Auto-Pay: solo la persona propietaria activa con términos aceptados; administración únicamente pausa.
CREATE FUNCTION app.tg_autopay_consentimiento() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_es_propietario boolean;
  v_activando boolean;
BEGIN
  IF current_user <> 'app_service' THEN
    RETURN NEW;
  END IF;

  v_es_propietario := NEW.unidad_id = ANY (app.unidades_propias());
  v_activando :=
    (TG_OP = 'INSERT' AND (NEW.activo OR NEW.estado = 'activo'))
    OR (
      TG_OP = 'UPDATE'
      AND (NOT OLD.activo OR OLD.estado <> 'activo')
      AND (NEW.activo OR NEW.estado = 'activo')
    );

  IF v_activando THEN
    IF NOT v_es_propietario THEN
      RAISE EXCEPTION 'Solo la persona propietaria de la unidad puede activar Auto-Pay' USING ERRCODE = 'UA403';
    END IF;
    IF NEW.terminos_version IS NULL OR length(trim(NEW.terminos_version)) = 0 THEN
      RAISE EXCEPTION 'Debes aceptar los términos vigentes de domiciliación' USING ERRCODE = 'UA422';
    END IF;
    IF NEW.payment_method_id IS NULL THEN
      RAISE EXCEPTION 'Selecciona un método de pago antes de activar Auto-Pay' USING ERRCODE = 'UA422';
    END IF;
    NEW.terminos_aceptados_en := coalesce(NEW.terminos_aceptados_en, now());
    NEW.activado_por := app.uid();
  END IF;

  IF NOT v_es_propietario THEN
    IF NEW.activo OR NEW.estado <> 'pausado' THEN
      RAISE EXCEPTION 'Administración únicamente puede pausar Auto-Pay' USING ERRCODE = 'UA403';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      NEW.payment_method_id IS DISTINCT FROM OLD.payment_method_id
      OR NEW.dia_cobro IS DISTINCT FROM OLD.dia_cobro
      OR NEW.terminos_version IS DISTINCT FROM OLD.terminos_version
      OR NEW.terminos_aceptados_en IS DISTINCT FROM OLD.terminos_aceptados_en
      OR NEW.activado_por IS DISTINCT FROM OLD.activado_por
    ) THEN
      RAISE EXCEPTION 'Administración no puede modificar términos ni método de pago' USING ERRCODE = 'UA403';
    END IF;
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER autopay_consentimiento BEFORE INSERT OR UPDATE ON autopay_config
  FOR EACH ROW EXECUTE FUNCTION app.tg_autopay_consentimiento();

-- ─── 4. Funciones financieras y timbrado ──────────────────────────
CREATE FUNCTION app.aplicar_moratorios(p_coto uuid, p_fecha date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_coto cotos%ROWTYPE;
  v_fecha date;
  v_periodo text;
  v_n integer := 0;
BEGIN
  SELECT * INTO v_coto FROM cotos WHERE id = p_coto;
  IF NOT FOUND OR NOT v_coto.activo OR v_coto.tipo_moratoria = 'ninguno' OR v_coto.tasa_moratoria <= 0 THEN
    RETURN 0;
  END IF;

  v_fecha := coalesce(p_fecha, (now() AT TIME ZONE v_coto.zona_horaria)::date);
  v_periodo := to_char(v_fecha, 'YYYY-MM');

  WITH elegibles AS (
    SELECT g.id AS cargo_id,
           g.coto_id,
           g.unidad_id,
           round(
             CASE WHEN v_coto.tipo_moratoria = 'porcentaje'
                  THEN (
                    CASE WHEN v_coto.base_moratoria = 'saldo'
                         THEN g.saldo_pendiente
                         ELSE least(g.saldo_pendiente, greatest(0, g.monto_original - g.monto_descuento))
                    END
                  ) * v_coto.tasa_moratoria / 100
                  ELSE v_coto.tasa_moratoria
             END,
             2
           ) AS monto_moratorio
      FROM cargos g
     WHERE g.coto_id = p_coto
       AND g.estado IN ('pendiente', 'parcial')
       AND g.saldo_pendiente > 0
       AND g.fecha_vencimiento + v_coto.dias_gracia < v_fecha
       AND NOT EXISTS (
         SELECT 1 FROM moratorios_aplicados ma WHERE ma.cargo_id = g.id AND ma.periodo = v_periodo
       )
     ORDER BY g.id
     FOR UPDATE OF g SKIP LOCKED
  ),
  insertados AS (
    INSERT INTO moratorios_aplicados (cargo_id, coto_id, unidad_id, periodo, fecha_corte, monto)
    SELECT e.cargo_id, e.coto_id, e.unidad_id, v_periodo, v_fecha, e.monto_moratorio
      FROM elegibles e
     WHERE e.monto_moratorio > 0
    ON CONFLICT (cargo_id, periodo) DO NOTHING
    RETURNING cargo_id, monto
  ),
  actualizados AS (
    UPDATE cargos g
       SET monto_moratoria = g.monto_moratoria + i.monto,
           saldo_pendiente = g.saldo_pendiente + i.monto,
           updated_at = now()
      FROM insertados i
     WHERE g.id = i.cargo_id
    RETURNING g.id
  )
  SELECT count(*) INTO v_n FROM actualizados;

  RETURN coalesce(v_n, 0);
END $$;

CREATE FUNCTION app.aplicar_saldo_a_favor(p_unidad uuid) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_es_service boolean := (current_setting('role', true) = 'app_service' OR session_user = 'app_service');
  v_unidad unidades%ROWTYPE;
  v_resto numeric;
  v_aplicado numeric := 0;
  v_aplicar numeric;
  r record;
BEGIN
  SELECT * INTO v_unidad
    FROM unidades
   WHERE id = p_unidad
     AND (NOT v_es_service OR coto_id = ANY (app.cotos_finanzas()) OR id = ANY (app.unidades_propias()));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unidad no encontrada' USING ERRCODE = 'UA404';
  END IF;
  IF v_es_service AND NOT (v_unidad.coto_id = ANY (app.cotos_admin())) THEN
    RAISE EXCEPTION 'Sin permiso para aplicar saldo a favor' USING ERRCODE = 'UA403';
  END IF;

  SELECT * INTO v_unidad FROM unidades WHERE id = p_unidad FOR UPDATE;
  IF v_unidad.saldo_a_favor <= 0 THEN
    RETURN 0;
  END IF;

  v_resto := v_unidad.saldo_a_favor;
  FOR r IN
    SELECT g.id, g.saldo_pendiente
      FROM cargos g
     WHERE g.unidad_id = p_unidad AND g.estado IN ('pendiente', 'parcial') AND g.saldo_pendiente > 0
     ORDER BY g.fecha_vencimiento, g.created_at, g.id
     FOR UPDATE
  LOOP
    EXIT WHEN v_resto <= 0;
    v_aplicar := least(v_resto, r.saldo_pendiente);
    INSERT INTO aplicaciones_saldo_favor (coto_id, unidad_id, cargo_id, monto_aplicado)
    VALUES (v_unidad.coto_id, p_unidad, r.id, v_aplicar);

    UPDATE cargos
       SET saldo_pendiente = saldo_pendiente - v_aplicar,
           estado = CASE WHEN saldo_pendiente - v_aplicar = 0 THEN 'pagado' ELSE 'parcial' END,
           updated_at = now()
     WHERE id = r.id;
    v_resto := v_resto - v_aplicar;
    v_aplicado := v_aplicado + v_aplicar;
  END LOOP;

  IF v_aplicado > 0 THEN
    UPDATE unidades SET saldo_a_favor = saldo_a_favor - v_aplicado, updated_at = now() WHERE id = p_unidad;
  END IF;
  RETURN v_aplicado;
END $$;

CREATE FUNCTION app.rechazar_pago(p_pago uuid, p_motivo text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_pago pagos%ROWTYPE;
BEGIN
  SELECT * INTO v_pago FROM pagos WHERE id = p_pago;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF current_user = 'app_service' AND NOT (v_pago.coto_id = ANY (app.cotos_admin())) THEN
    RAISE EXCEPTION 'Sin permiso para rechazar pagos' USING ERRCODE = 'UA403';
  END IF;
  SELECT * INTO v_pago FROM pagos WHERE id = p_pago FOR UPDATE;
  IF v_pago.estado NOT IN ('pendiente', 'en_revision') OR v_pago.aplicado_en IS NOT NULL THEN
    RAISE EXCEPTION 'Solo se pueden rechazar pagos pendientes o en revisión' USING ERRCODE = 'UA409';
  END IF;
  UPDATE pagos
     SET estado = 'rechazado',
         motivo_rechazo = nullif(trim(coalesce(p_motivo, '')), ''),
         updated_at = now()
   WHERE id = p_pago;
END $$;

CREATE FUNCTION app.condonar_cargo(p_cargo uuid, p_motivo text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_cargo cargos%ROWTYPE;
  v_motivo text := trim(coalesce(p_motivo, ''));
BEGIN
  IF v_motivo = '' THEN
    RAISE EXCEPTION 'Debes indicar el motivo de la condonación' USING ERRCODE = 'UA422';
  END IF;
  SELECT * INTO v_cargo FROM cargos WHERE id = p_cargo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cargo no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF current_user = 'app_service' AND NOT (v_cargo.coto_id = ANY (app.cotos_admin())) THEN
    RAISE EXCEPTION 'Sin permiso para condonar cargos' USING ERRCODE = 'UA403';
  END IF;
  SELECT * INTO v_cargo FROM cargos WHERE id = p_cargo FOR UPDATE;
  IF v_cargo.estado NOT IN ('pendiente', 'parcial') THEN
    RAISE EXCEPTION 'El cargo ya está liquidado, condonado o cancelado' USING ERRCODE = 'UA409';
  END IF;
  UPDATE cargos
     SET estado = 'condonado',
         monto_descuento = monto_descuento + saldo_pendiente,
         saldo_pendiente = 0,
         notas = CASE
           WHEN notas IS NULL OR length(trim(notas)) = 0 THEN '[CONDONADO] ' || v_motivo
           ELSE notas || E'\n[CONDONADO] ' || v_motivo
         END,
         updated_at = now()
   WHERE id = p_cargo;
END $$;

CREATE FUNCTION app.aprobar_egreso(p_egreso uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_es_service boolean := (current_setting('role', true) = 'app_service' OR session_user = 'app_service');
  v_uid uuid := app.uid();
  v_egr egresos%ROWTYPE;
BEGIN
  SELECT * INTO v_egr
    FROM egresos
   WHERE id = p_egreso
     AND (NOT v_es_service OR coto_id = ANY (app.cotos_staff()));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Egreso no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF v_es_service THEN
    IF NOT (v_egr.coto_id = ANY (app.cotos_tesoreria())) THEN
      RAISE EXCEPTION 'Sin permiso de tesorería' USING ERRCODE = 'UA403';
    END IF;
    IF v_uid IS NULL OR v_egr.solicitado_por = v_uid THEN
      RAISE EXCEPTION 'Quien solicita un egreso no puede aprobarlo' USING ERRCODE = 'UA403';
    END IF;
  END IF;
  SELECT * INTO v_egr FROM egresos WHERE id = p_egreso FOR UPDATE;
  IF v_egr.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'El egreso ya fue dictaminado' USING ERRCODE = 'UA409';
  END IF;
  UPDATE egresos
     SET estado = 'aprobado',
         aprobado_por = v_uid,
         aprobado_en = now(),
         updated_at = now()
   WHERE id = p_egreso;
END $$;

CREATE FUNCTION app.rechazar_egreso(p_egreso uuid, p_motivo text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_es_service boolean := (current_setting('role', true) = 'app_service' OR session_user = 'app_service');
  v_egr egresos%ROWTYPE;
BEGIN
  SELECT * INTO v_egr
    FROM egresos
   WHERE id = p_egreso
     AND (NOT v_es_service OR coto_id = ANY (app.cotos_staff()));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Egreso no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF v_es_service AND NOT (v_egr.coto_id = ANY (app.cotos_tesoreria())) THEN
    RAISE EXCEPTION 'Sin permiso de tesorería' USING ERRCODE = 'UA403';
  END IF;
  SELECT * INTO v_egr FROM egresos WHERE id = p_egreso FOR UPDATE;
  IF v_egr.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'El egreso ya fue dictaminado' USING ERRCODE = 'UA409';
  END IF;
  UPDATE egresos
     SET estado = 'rechazado',
         rechazado_en = now(),
         motivo_rechazo = nullif(trim(coalesce(p_motivo, '')), ''),
         updated_at = now()
   WHERE id = p_egreso;
END $$;

CREATE FUNCTION app.marcar_egreso_pagado(p_egreso uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_es_service boolean := (current_setting('role', true) = 'app_service' OR session_user = 'app_service');
  v_egr egresos%ROWTYPE;
BEGIN
  SELECT * INTO v_egr
    FROM egresos
   WHERE id = p_egreso
     AND (NOT v_es_service OR coto_id = ANY (app.cotos_staff()));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Egreso no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF v_es_service AND NOT (v_egr.coto_id = ANY (app.cotos_tesoreria())) THEN
    RAISE EXCEPTION 'Sin permiso de tesorería' USING ERRCODE = 'UA403';
  END IF;
  SELECT * INTO v_egr FROM egresos WHERE id = p_egreso FOR UPDATE;
  IF v_egr.estado <> 'aprobado' THEN
    RAISE EXCEPTION 'Solo un egreso aprobado puede marcarse como pagado' USING ERRCODE = 'UA409';
  END IF;
  UPDATE egresos
     SET estado = 'pagado',
         updated_at = now()
   WHERE id = p_egreso;
END $$;

CREATE FUNCTION app.consumir_timbre(p_org uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_id uuid;
BEGIN
  LOOP
    SELECT id INTO v_pkg
      FROM paquetes_timbres
     WHERE org_id = p_org AND estado = 'activo' AND usados < cantidad
     ORDER BY created_at, id
     LIMIT 1
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sin timbres fiscales disponibles' USING ERRCODE = 'UA409';
    END IF;

    UPDATE paquetes_timbres
       SET usados = usados + 1,
           estado = CASE WHEN usados + 1 >= cantidad THEN 'agotado' ELSE estado END
     WHERE id = v_pkg AND usados < cantidad
    RETURNING id INTO v_id;

    EXIT WHEN v_id IS NOT NULL;
  END LOOP;

  RETURN v_id;
END $$;

-- Rechazo definitivo del PAC: la fila pasa a 'fallido' y devuelve el timbre reservado al crearla.
-- Solo aplica a filas sin pac_invoice_id (nunca timbradas); idempotente.
CREATE FUNCTION app.marcar_cfdi_fallido(p_factura uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
BEGIN
  UPDATE facturas_cfdi
     SET estado = 'fallido'
   WHERE id = p_factura AND estado = 'pendiente' AND pac_invoice_id IS NULL
  RETURNING paquete_timbre_id INTO v_pkg;

  IF v_pkg IS NOT NULL THEN
    UPDATE paquetes_timbres
       SET usados = usados - 1,
           estado = CASE WHEN estado = 'agotado' THEN 'activo' ELSE estado END
     WHERE id = v_pkg AND usados > 0;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION
  app.aplicar_moratorios(uuid, date),
  app.aplicar_saldo_a_favor(uuid),
  app.rechazar_pago(uuid, text),
  app.condonar_cargo(uuid, text),
  app.aprobar_egreso(uuid),
  app.rechazar_egreso(uuid, text),
  app.marcar_egreso_pagado(uuid),
  app.consumir_timbre(uuid),
  app.marcar_cfdi_fallido(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.aplicar_moratorios(uuid, date) TO app_worker;
GRANT EXECUTE ON FUNCTION app.consumir_timbre(uuid), app.marcar_cfdi_fallido(uuid) TO app_worker;
GRANT EXECUTE ON FUNCTION
  app.aplicar_saldo_a_favor(uuid),
  app.rechazar_pago(uuid, text),
  app.condonar_cargo(uuid, text),
  app.aprobar_egreso(uuid),
  app.rechazar_egreso(uuid, text),
  app.marcar_egreso_pagado(uuid)
TO app_service, app_worker;
