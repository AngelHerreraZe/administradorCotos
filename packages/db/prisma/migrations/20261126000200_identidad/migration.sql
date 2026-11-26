-- ════════════════════════════════════════════════════════════════════
-- FASE 1: IDENTIDAD, MFA (aal2), INVITACIONES, IDEMPOTENCIA Y UA4xx
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. Contexto v2 con nivel de autenticación (MFA) y pre-auth ─────
ALTER TABLE "organizaciones" ADD COLUMN "exigir_mfa" BOOLEAN NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION app.uid() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp AS $$
DECLARE
  v text := current_setting('app.ctx', true);
  p text[];
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.aal[12]\.[0-9]{10}\.[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  p := string_to_array(v, '.');
  IF p[3]::bigint < extract(epoch FROM now()) THEN
    RETURN NULL;
  END IF;
  IF encode(hmac(convert_to(p[1] || '.' || p[2] || '.' || p[3], 'UTF8'), (SELECT s.secret FROM app_private.ctx_secret s), 'sha256'), 'hex')
     IS DISTINCT FROM p[4] THEN
    RETURN NULL;
  END IF;
  RETURN p[1]::uuid;
END $$;

-- Devuelve auth_id firmado tanto en contexto pre-registro (`auth.<auth_id>...`) como en sesión normal (`app.uid()`).
CREATE FUNCTION app.auth_uid() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp AS $$
DECLARE
  v text := current_setting('app.ctx', true);
  p text[];
  v_uid uuid;
BEGIN
  IF v ~ '^auth\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.aal[12]\.[0-9]{10}\.[0-9a-f]{64}$' THEN
    p := string_to_array(v, '.');
    IF p[4]::bigint < extract(epoch FROM now()) THEN
      RETURN NULL;
    END IF;
    IF encode(hmac(convert_to(p[1] || '.' || p[2] || '.' || p[3] || '.' || p[4], 'UTF8'), (SELECT s.secret FROM app_private.ctx_secret s), 'sha256'), 'hex')
       IS DISTINCT FROM p[5] THEN
      RETURN NULL;
    END IF;
    RETURN p[2]::uuid;
  END IF;

  v_uid := app.uid();
  IF v_uid IS NOT NULL THEN
    RETURN (SELECT u.auth_id FROM usuarios u WHERE u.id = v_uid AND u.activo);
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION app.auth_uid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_uid() TO app_service, app_worker;

CREATE FUNCTION app.aal() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
           WHEN app.uid() IS NOT NULL THEN split_part(current_setting('app.ctx', true), '.', 2)
           WHEN app.auth_uid() IS NOT NULL THEN split_part(current_setting('app.ctx', true), '.', 3)
         END
$$;
REVOKE EXECUTE ON FUNCTION app.aal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aal() TO app_service, app_worker;

CREATE OR REPLACE FUNCTION app._cotos(p_roles text[], p_org_roles text[], p_soporte boolean, p_escritura boolean)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  WITH me AS (SELECT u.id FROM usuarios u WHERE u.id = app.uid() AND u.activo),
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
   WHERE CASE WHEN p_escritura THEN o.estado_suscripcion = 'activo'
                                AND (NOT o.exigir_mfa OR app.aal() = 'aal2')
              ELSE NOT (f.via = 'org' AND o.estado_suscripcion = 'suspendido')
         END
$$;

CREATE OR REPLACE FUNCTION app._unidades(p_roles text[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT m.unidad_id), '{}')
    FROM miembros_coto m
    JOIN usuarios u ON u.id = m.usuario_id AND u.activo
   WHERE m.usuario_id = (SELECT app.uid()) AND m.activo AND m.unidad_id IS NOT NULL AND m.rol = ANY (p_roles)
$$;

CREATE OR REPLACE FUNCTION app._orgs(p_roles text[], p_soporte boolean, p_escritura boolean) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH me AS (SELECT u.id FROM usuarios u WHERE u.id = app.uid() AND u.activo)
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
   WHERE NOT p_escritura
      OR (o.estado_suscripcion = 'activo' AND (NOT o.exigir_mfa OR app.aal() = 'aal2'))
$$;

CREATE OR REPLACE FUNCTION app.orgs_owner() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(o.id), '{}')
    FROM organizaciones o
   WHERE o.id = ANY (app._orgs('{org_owner}', false, false))
     AND (NOT o.exigir_mfa OR app.aal() = 'aal2')
$$;

-- ─── 2. Resolución auth_id -> usuario_id e idempotencia soporte ─────
CREATE FUNCTION app.usuario_por_auth(p_auth uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT id FROM usuarios WHERE auth_id = p_auth AND activo
$$;
REVOKE EXECUTE ON FUNCTION app.usuario_por_auth(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.usuario_por_auth(uuid) TO app_service, app_worker;

ALTER TABLE "soporte_accesos" ADD COLUMN "clave_idempotencia" VARCHAR(100);
CREATE UNIQUE INDEX "soporte_accesos_clave_idempotencia_key" ON "soporte_accesos"("clave_idempotencia");
DROP TRIGGER inmutable ON public.soporte_accesos;
CREATE TRIGGER inmutable BEFORE UPDATE ON public.soporte_accesos
  FOR EACH ROW EXECUTE FUNCTION app.tg_inmutable('org_id', 'otorgado_por', 'desde', 'clave_idempotencia');

-- ─── 3. Invitaciones de ingreso ─────────────────────────────────────
CREATE TABLE "invitaciones_miembro" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "coto_id" UUID,
    "unidad_id" UUID,
    "email" CITEXT NOT NULL,
    "rol" VARCHAR(30) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "clave_idempotencia" VARCHAR(100),
    "expira_en" TIMESTAMPTZ NOT NULL,
    "aceptada_en" TIMESTAMPTZ,
    "revocada_en" TIMESTAMPTZ,
    "creada_por" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitaciones_miembro_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitaciones_miembro_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitaciones_miembro_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitaciones_miembro_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "invitaciones_miembro_creada_por_fkey" FOREIGN KEY ("creada_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "invitaciones_miembro_token_hash_key" ON "invitaciones_miembro"("token_hash");
CREATE UNIQUE INDEX "invitaciones_miembro_clave_idempotencia_key" ON "invitaciones_miembro"("clave_idempotencia");
CREATE INDEX "invitaciones_miembro_coto_id_created_at_idx" ON "invitaciones_miembro"("coto_id", "created_at" DESC);
CREATE INDEX "invitaciones_miembro_org_id_email_idx" ON "invitaciones_miembro"("org_id", "email");
CREATE INDEX "invitaciones_miembro_unidad_id_idx" ON "invitaciones_miembro"("unidad_id");
CREATE INDEX "invitaciones_miembro_creada_por_idx" ON "invitaciones_miembro"("creada_por");

-- Seguridad de invitaciones_miembro
ALTER TABLE invitaciones_miembro ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker ON invitaciones_miembro TO app_worker USING (true) WITH CHECK (true);
CREATE POLICY coto_activo ON invitaciones_miembro AS RESTRICTIVE TO app_service
  USING ((SELECT app.coto_activo()) IS NULL OR coto_id = (SELECT app.coto_activo()));
CREATE POLICY sel ON invitaciones_miembro FOR SELECT TO app_service
  USING ((coto_id IS NOT NULL AND coto_id = ANY ((SELECT app.cotos_admin())::uuid[]))
      OR (coto_id IS NULL AND org_id = ANY ((SELECT app.orgs_owner())::uuid[])));
CREATE POLICY ins ON invitaciones_miembro FOR INSERT TO app_service
  WITH CHECK (
    creada_por = (SELECT app.uid())
    AND aceptada_en IS NULL
    AND revocada_en IS NULL
    AND (
      (coto_id IS NOT NULL AND coto_id = ANY ((SELECT app.cotos_admin())::uuid[]) AND rol NOT IN ('org_owner', 'org_admin'))
      OR (coto_id IS NULL AND org_id = ANY ((SELECT app.orgs_owner())::uuid[]) AND rol IN ('org_owner', 'org_admin'))
    )
  );
CREATE POLICY upd ON invitaciones_miembro FOR UPDATE TO app_service
  USING (
    aceptada_en IS NULL
    AND revocada_en IS NULL
    AND (
      (coto_id IS NOT NULL AND coto_id = ANY ((SELECT app.cotos_admin())::uuid[]))
      OR (coto_id IS NULL AND org_id = ANY ((SELECT app.orgs_owner())::uuid[]))
    )
  )
  WITH CHECK (
    revocada_en IS NOT NULL
    AND (
      (coto_id IS NOT NULL AND coto_id = ANY ((SELECT app.cotos_admin())::uuid[]))
      OR (coto_id IS NULL AND org_id = ANY ((SELECT app.orgs_owner())::uuid[]))
    )
  );

GRANT SELECT, INSERT ON invitaciones_miembro TO app_service;
GRANT UPDATE (revocada_en) ON invitaciones_miembro TO app_service;
GRANT SELECT, INSERT, UPDATE ON invitaciones_miembro TO app_worker;

ALTER TABLE invitaciones_miembro
  ADD CONSTRAINT invitaciones_miembro_exp_ck CHECK (expira_en > created_at AND expira_en <= created_at + interval '7 days'),
  ADD CONSTRAINT invitaciones_miembro_scope_ck CHECK ((coto_id IS NULL) = (rol IN ('org_owner', 'org_admin'))),
  ADD CONSTRAINT invitaciones_miembro_unidad_org_ck CHECK (coto_id IS NOT NULL OR unidad_id IS NULL),
  ADD CONSTRAINT invitaciones_miembro_rol_ck CHECK (
    rol IN ('org_owner', 'org_admin', 'coto_admin', 'coto_tesorero', 'coto_comite', 'residente_propietario', 'residente_inquilino', 'guardia', 'proveedor')
  ),
  ADD CONSTRAINT invitaciones_miembro_residente_ck CHECK (
    rol NOT IN ('residente_propietario', 'residente_inquilino') OR unidad_id IS NOT NULL
  ),
  ADD CONSTRAINT invitaciones_miembro_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$');

CREATE FUNCTION app.tg_invitacion_defaults() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  IF TG_OP = 'INSERT'
     AND coalesce(nullif(current_setting('role', true), 'none'), session_user) = 'app_service' THEN
    NEW.created_at := now();
  END IF;
  IF NEW.coto_id IS NOT NULL THEN
    SELECT org_id INTO v_org FROM cotos WHERE id = NEW.coto_id;
    IF v_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'Referencia inválida en invitaciones_miembro.coto_id' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION app.tg_invitacion_defaults() FROM PUBLIC;

CREATE TRIGGER invitacion_org_coto BEFORE INSERT OR UPDATE OF org_id, coto_id ON public.invitaciones_miembro
  FOR EACH ROW EXECUTE FUNCTION app.tg_invitacion_defaults();
CREATE TRIGGER mismo_coto BEFORE INSERT OR UPDATE OF coto_id, unidad_id ON public.invitaciones_miembro
  FOR EACH ROW EXECUTE FUNCTION app.tg_mismo_coto('unidad_id', 'unidades');
CREATE TRIGGER inmutable BEFORE UPDATE ON public.invitaciones_miembro
  FOR EACH ROW EXECUTE FUNCTION app.tg_inmutable('org_id', 'coto_id', 'unidad_id', 'email', 'rol', 'token_hash', 'expira_en', 'creada_por', 'created_at', 'clave_idempotencia');
CREATE TRIGGER auditar AFTER INSERT OR UPDATE OR DELETE ON public.invitaciones_miembro
  FOR EACH ROW EXECUTE FUNCTION app.tg_auditar('token_hash');

CREATE FUNCTION app.aceptar_invitacion(p_token_hash text, p_auth uuid, p_email citext, p_nombre text, p_apellido text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp AS $$
DECLARE
  v_auth_ctx uuid := app.auth_uid();
  v_aal text := coalesce(app.aal(), 'aal1');
  v_inv invitaciones_miembro%ROWTYPE;
  v_usuario usuarios%ROWTYPE;
  v_usuario_id uuid;
  v_nombre text := nullif(btrim(p_nombre), '');
  v_apellido text := nullif(btrim(p_apellido), '');
  v_exp text;
  v_payload text;
  v_ctx text;
BEGIN
  IF v_auth_ctx IS NULL OR v_auth_ctx IS DISTINCT FROM p_auth THEN
    RAISE EXCEPTION 'Sesión inválida para aceptar invitación' USING ERRCODE = 'UA403';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'La invitación no existe o ya venció' USING ERRCODE = 'UA404';
  END IF;

  SELECT * INTO v_inv FROM invitaciones_miembro WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La invitación no existe o ya venció' USING ERRCODE = 'UA404';
  END IF;

  IF p_email IS NULL OR v_inv.email IS DISTINCT FROM p_email THEN
    RAISE EXCEPTION 'El correo de tu sesión no coincide con la invitación' USING ERRCODE = 'UA403';
  END IF;

  IF v_inv.aceptada_en IS NOT NULL THEN
    SELECT * INTO v_usuario FROM usuarios WHERE auth_id = p_auth AND email = v_inv.email AND activo;
    IF FOUND THEN
      RETURN v_usuario.id;
    END IF;
    RAISE EXCEPTION 'Esta invitación ya fue utilizada' USING ERRCODE = 'UA409';
  END IF;

  IF v_inv.revocada_en IS NOT NULL OR v_inv.expira_en <= now() THEN
    RAISE EXCEPTION 'La invitación no existe o ya venció' USING ERRCODE = 'UA404';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE email = v_inv.email;
  IF FOUND THEN
    IF v_usuario.auth_id IS DISTINCT FROM p_auth THEN
      RAISE EXCEPTION 'Este correo ya está vinculado a otra cuenta' USING ERRCODE = 'UA409';
    END IF;
    IF NOT v_usuario.activo THEN
      RAISE EXCEPTION 'Tu cuenta está desactivada' USING ERRCODE = 'UA403';
    END IF;
    v_usuario_id := v_usuario.id;
  ELSE
    IF EXISTS (SELECT 1 FROM usuarios WHERE auth_id = p_auth) THEN
      RAISE EXCEPTION 'Tu cuenta ya está registrada con otro correo' USING ERRCODE = 'UA409';
    END IF;
    IF v_nombre IS NULL OR v_apellido IS NULL THEN
      RAISE EXCEPTION 'Faltan tu nombre y apellido para completar el registro' USING ERRCODE = 'UA422';
    END IF;
    INSERT INTO usuarios (auth_id, nombre, apellido_paterno, email)
    VALUES (p_auth, v_nombre, v_apellido, v_inv.email)
    RETURNING id INTO v_usuario_id;
  END IF;

  -- Firma app.ctx con el usuarios.id real para que tg_auditar registre al actor correcto en audit_outbox.
  v_exp := (floor(extract(epoch FROM now()))::bigint + 300)::text;
  v_payload := v_usuario_id::text || '.' || v_aal || '.' || v_exp;
  v_ctx := v_payload || '.' || encode(
    hmac(convert_to(v_payload, 'UTF8'), (SELECT s.secret FROM app_private.ctx_secret s), 'sha256'),
    'hex'
  );
  PERFORM set_config('app.ctx', v_ctx, true);

  IF v_inv.coto_id IS NULL THEN
    INSERT INTO org_miembros (org_id, usuario_id, rol, activo)
    VALUES (v_inv.org_id, v_usuario_id, v_inv.rol, true)
    ON CONFLICT (org_id, usuario_id) DO UPDATE SET rol = EXCLUDED.rol, activo = true;
  ELSE
    UPDATE miembros_coto
       SET activo = true
     WHERE coto_id = v_inv.coto_id
       AND usuario_id = v_usuario_id
       AND rol = v_inv.rol
       AND unidad_id IS NOT DISTINCT FROM v_inv.unidad_id;
    IF NOT FOUND THEN
      INSERT INTO miembros_coto (coto_id, unidad_id, usuario_id, rol, activo)
      VALUES (v_inv.coto_id, v_inv.unidad_id, v_usuario_id, v_inv.rol, true);
    END IF;
  END IF;

  UPDATE invitaciones_miembro SET aceptada_en = now() WHERE id = v_inv.id;
  RETURN v_usuario_id;
END $$;
REVOKE EXECUTE ON FUNCTION app.aceptar_invitacion(text, uuid, citext, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aceptar_invitacion(text, uuid, citext, text, text) TO app_service, app_worker;

-- ─── 4. Perfil de membresías y directorio acotado por LFPDPPP ────────
-- Comité (sin cotos_finanzas) no ve filas de otros miembros en `usuarios` ni email/teléfono en el directorio.
DROP POLICY sel ON usuarios;
CREATE POLICY sel ON usuarios FOR SELECT TO app_service USING (
     id = (SELECT app.uid())
  OR EXISTS (SELECT 1 FROM miembros_coto m
              WHERE m.usuario_id = usuarios.id AND m.activo
                AND (m.coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[])
                     OR m.unidad_id = ANY ((SELECT app.unidades_mias())::uuid[])))
  OR EXISTS (SELECT 1 FROM org_miembros om
              WHERE om.usuario_id = usuarios.id AND om.org_id = ANY ((SELECT app.orgs_lectura())::uuid[])));

CREATE FUNCTION app.directorio_coto(p_coto uuid, p_limite integer DEFAULT 20, p_cursor uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  coto_id uuid,
  unidad_id uuid,
  unidad_numero text,
  usuario_id uuid,
  nombre text,
  apellido_paterno text,
  apellido_materno text,
  email text,
  telefono text,
  rol text,
  activo boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_contacto boolean;
  v_coto_activo uuid := app.coto_activo();
  v_cur_created timestamptz;
  v_cur_id uuid;
  v_lim integer := least(greatest(coalesce(p_limite, 20), 1), 100);
BEGIN
  IF NOT (p_coto = ANY ((SELECT app.cotos_staff())::uuid[])) THEN
    RAISE EXCEPTION 'Sin permiso para ver el directorio de este coto' USING ERRCODE = 'UA403';
  END IF;
  IF v_coto_activo IS NOT NULL AND p_coto IS DISTINCT FROM v_coto_activo THEN
    RETURN;
  END IF;
  IF p_cursor IS NOT NULL THEN
    SELECT mc.created_at, mc.id INTO v_cur_created, v_cur_id
      FROM miembros_coto mc
     WHERE mc.id = p_cursor AND mc.coto_id = p_coto AND mc.activo;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  v_contacto := p_coto = ANY ((SELECT app.cotos_finanzas())::uuid[]);

  RETURN QUERY
  SELECT m.id,
         m.coto_id,
         m.unidad_id,
         un.numero::text AS unidad_numero,
         m.usuario_id,
         u.nombre::text,
         u.apellido_paterno::text,
         u.apellido_materno::text,
         CASE WHEN v_contacto THEN u.email::text ELSE NULL END AS email,
         CASE WHEN v_contacto THEN u.telefono::text ELSE NULL END AS telefono,
         m.rol::text,
         m.activo
    FROM miembros_coto m
    JOIN usuarios u ON u.id = m.usuario_id
    LEFT JOIN unidades un ON un.id = m.unidad_id
   WHERE m.coto_id = p_coto
     AND m.activo
     AND u.activo
     AND (v_cur_created IS NULL OR (m.created_at, m.id) > (v_cur_created, v_cur_id))
   ORDER BY m.created_at ASC, m.id ASC
   LIMIT v_lim + 1;
END $$;
REVOKE EXECUTE ON FUNCTION app.directorio_coto(uuid, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.directorio_coto(uuid, integer, uuid) TO app_service, app_worker;

CREATE FUNCTION app.mis_membresias()
RETURNS TABLE (coto_id uuid, coto text, org_id uuid, rol text, unidad_id uuid, unidad text)
LANGUAGE sql STABLE AS $$
  SELECT m.coto_id, c.nombre::text, c.org_id, m.rol::text, m.unidad_id, u.numero::text
    FROM miembros_coto m
    JOIN cotos c ON c.id = m.coto_id
    LEFT JOIN unidades u ON u.id = m.unidad_id
   WHERE m.usuario_id = (SELECT app.uid())
     AND m.activo
     AND c.activo
   ORDER BY c.nombre, m.rol, u.numero
$$;
REVOKE EXECUTE ON FUNCTION app.mis_membresias() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mis_membresias() TO app_service, app_worker;

-- ─── 5. Convención UA4xx en funciones existentes ────────────────────
CREATE OR REPLACE FUNCTION app.generar_cargos(p_coto uuid, p_concepto uuid, p_periodo text,
                                              p_monto numeric DEFAULT NULL, p_vencimiento date DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  cc conceptos_cargo%ROWTYPE;
  v_monto numeric;
  v_vence date;
  v_n integer;
BEGIN
  IF p_periodo !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Periodo inválido (AAAA-MM)' USING ERRCODE = 'UA422';
  END IF;
  SELECT * INTO cc FROM conceptos_cargo WHERE id = p_concepto AND coto_id = p_coto AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concepto no encontrado en este coto' USING ERRCODE = 'UA404';
  END IF;
  v_monto := coalesce(p_monto, cc.monto_default);
  IF v_monto IS NULL OR v_monto <= 0 THEN
    RAISE EXCEPTION 'Falta el monto' USING ERRCODE = 'UA422';
  END IF;
  IF cc.usa_indiviso AND EXISTS (SELECT 1 FROM unidades WHERE coto_id = p_coto AND activo AND indiviso IS NULL) THEN
    RAISE EXCEPTION 'Hay unidades activas sin indiviso' USING ERRCODE = 'UA422';
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

CREATE OR REPLACE FUNCTION app.aplicar_pago(p_pago uuid) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
  v_pago pagos%ROWTYPE;
  v_resto numeric;
  v_aplicar numeric;
  r record;
BEGIN
  SELECT * INTO v_pago FROM pagos WHERE id = p_pago FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF v_pago.estado <> 'confirmado' THEN
    RAISE EXCEPTION 'El pago no está confirmado' USING ERRCODE = 'UA409';
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

CREATE OR REPLACE FUNCTION app.validar_acceso(p_coto uuid, p_token_hash text DEFAULT NULL, p_codigo text DEFAULT NULL)
RETURNS TABLE (autorizado boolean, motivo text, invitado text, unidad text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_guardia uuid := app.uid();
  v_metodo text := CASE WHEN p_token_hash IS NOT NULL THEN 'qr' ELSE 'codigo' END;
  v_inv invitaciones_acceso%ROWTYPE;
  v_ok boolean;
BEGIN
  IF v_guardia IS NULL OR NOT (p_coto = ANY (app.cotos_guardia())) THEN
    RAISE EXCEPTION 'Sin permiso de caseta en este coto' USING ERRCODE = 'UA403';
  END IF;
  IF p_token_hash IS NULL AND p_codigo IS NULL THEN
    RAISE EXCEPTION 'Falta el QR o el código' USING ERRCODE = 'UA422';
  END IF;
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
         split_part(v_inv.nombre_invitado, ' ', 1),
         (SELECT u.numero::text FROM unidades u WHERE u.id = v_inv.unidad_id);
END $$;

CREATE OR REPLACE FUNCTION app.votar(p_votacion uuid, p_opcion uuid, p_unidad uuid) RETURNS uuid
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
    RAISE EXCEPTION 'Solo la persona propietaria de la unidad puede votar' USING ERRCODE = 'UA403';
  END IF;
  SELECT v.* INTO v_votacion FROM votaciones v
   WHERE v.id = p_votacion AND v.coto_id = v_miembro.coto_id AND v.estado = 'activa'
     AND now() >= v.fecha_inicio AND now() < v.fecha_fin
     AND EXISTS (SELECT 1 FROM opciones_voto o WHERE o.id = p_opcion AND o.votacion_id = v.id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La votación no está abierta o la opción no existe' USING ERRCODE = 'UA422';
  END IF;
  IF v_votacion.ponderada_por_indiviso THEN
    SELECT u.indiviso INTO v_peso FROM unidades u WHERE u.id = p_unidad;
    IF v_peso IS NULL THEN
      RAISE EXCEPTION 'La unidad no tiene indiviso registrado' USING ERRCODE = 'UA422';
    END IF;
  END IF;
  INSERT INTO votos (votacion_id, coto_id, opcion_id, miembro_id, unidad_id, peso)
  VALUES (p_votacion, v_miembro.coto_id, p_opcion, v_miembro.id, p_unidad, v_peso)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Esta unidad ya votó' USING ERRCODE = 'UA409';
END $$;

CREATE OR REPLACE FUNCTION app.guardar_csd(p_coto uuid, p_cert bytea, p_key bytea, p_password bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (p_coto = ANY (app.cotos_admin())) THEN
    RAISE EXCEPTION 'Sin permiso' USING ERRCODE = 'UA403';
  END IF;
  INSERT INTO coto_secretos (coto_id, csd_cert, csd_key, csd_password, updated_at)
  VALUES (p_coto, p_cert, p_key, p_password, now())
  ON CONFLICT (coto_id) DO UPDATE
    SET csd_cert = EXCLUDED.csd_cert, csd_key = EXCLUDED.csd_key, csd_password = EXCLUDED.csd_password, updated_at = now();
END $$;
