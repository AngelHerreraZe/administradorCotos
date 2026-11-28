-- Fase 4 — Comunicación, WhatsApp, IA, tickets y votaciones (plan_fases_backend.md §8).

-- ─── 4.1 Comunicados: segmentación, Markdown sin HTML y destinatarios materializados ───
ALTER TABLE comunicados
  ADD COLUMN dirigido_a varchar(20) NOT NULL DEFAULT 'todos',
  ADD COLUMN sector_id uuid REFERENCES sectores(id),
  ADD COLUMN unidades_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN publicado_en timestamptz,
  ADD COLUMN clave_idempotencia varchar(100);
CREATE UNIQUE INDEX comunicados_clave_idempotencia_key ON comunicados (clave_idempotencia);

ALTER TABLE comunicados
  ADD CONSTRAINT comunicados_prioridad_ck CHECK (prioridad IN ('normal', 'urgente')),
  ADD CONSTRAINT comunicados_dirigido_ck CHECK (
       dirigido_a IN ('todos', 'propietarios', 'morosos')
    OR (dirigido_a = 'sector' AND sector_id IS NOT NULL)
    OR (dirigido_a = 'unidades' AND cardinality(unidades_ids) BETWEEN 1 AND 1000)),
  -- El cuerpo es Markdown SIN HTML: el cliente lo renderiza sanitizado; correo y WhatsApp lo envían como texto.
  ADD CONSTRAINT comunicados_sin_html_ck CHECK (cuerpo !~ '<[A-Za-z/!?]' AND titulo !~ '<[A-Za-z/!?]');

CREATE TRIGGER mismo_coto BEFORE INSERT OR UPDATE OF coto_id, sector_id ON comunicados
  FOR EACH ROW EXECUTE FUNCTION app.tg_mismo_coto('sector_id', 'sectores');

-- Destinatarios y lectura. La fila existe desde la publicación (leido_en NULL) y es lo que
-- decide quién ve un comunicado: un segmento "morosos" nunca se publica como lista.
CREATE TABLE comunicados_lectura (
  comunicado_id uuid NOT NULL REFERENCES comunicados(id),
  usuario_id    uuid NOT NULL REFERENCES usuarios(id),
  coto_id       uuid NOT NULL REFERENCES cotos(id),
  leido_en      timestamptz,
  canal         varchar(20),
  notificado_en timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comunicado_id, usuario_id),
  CONSTRAINT comunicados_lectura_canal_ck CHECK (canal IS NULL OR canal IN ('app', 'correo', 'whatsapp'))
);
CREATE INDEX comunicados_lectura_usuario_idx ON comunicados_lectura (usuario_id, created_at);
CREATE INDEX comunicados_lectura_pendientes_idx ON comunicados_lectura (comunicado_id, usuario_id) WHERE notificado_en IS NULL;

ALTER TABLE comunicados_lectura ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker ON comunicados_lectura TO app_worker USING (true) WITH CHECK (true);
CREATE POLICY coto_activo ON comunicados_lectura AS RESTRICTIVE TO app_service
  USING ((SELECT app.coto_activo()) IS NULL OR coto_id = (SELECT app.coto_activo()));
-- Cada quien ve su fila; la lista completa (puede ser el segmento de morosos) solo administración/tesorería.
CREATE POLICY sel ON comunicados_lectura FOR SELECT TO app_service
  USING (usuario_id = (SELECT app.uid()) OR coto_id = ANY ((SELECT app.cotos_finanzas())::uuid[]));
CREATE POLICY ins ON comunicados_lectura FOR INSERT TO app_service
  WITH CHECK (coto_id = ANY ((SELECT app.cotos_admin())::uuid[]));
CREATE POLICY upd ON comunicados_lectura FOR UPDATE TO app_service USING (usuario_id = (SELECT app.uid()));
GRANT SELECT, INSERT ON comunicados_lectura TO app_service;
GRANT UPDATE (leido_en, canal) ON comunicados_lectura TO app_service;
GRANT SELECT, INSERT, UPDATE ON comunicados_lectura TO app_worker;
CREATE TRIGGER mismo_coto BEFORE INSERT OR UPDATE OF coto_id, comunicado_id ON comunicados_lectura
  FOR EACH ROW EXECUTE FUNCTION app.tg_mismo_coto('comunicado_id', 'comunicados');
CREATE TRIGGER inmutable BEFORE UPDATE ON comunicados_lectura
  FOR EACH ROW EXECUTE FUNCTION app.tg_inmutable('coto_id', 'comunicado_id', 'usuario_id');

DROP POLICY sel ON comunicados;
CREATE POLICY sel ON comunicados FOR SELECT TO app_service USING (
     coto_id = ANY ((SELECT app.cotos_staff())::uuid[])
  OR (publicado AND EXISTS (SELECT 1 FROM comunicados_lectura l
                             WHERE l.comunicado_id = comunicados.id AND l.usuario_id = (SELECT app.uid()))));

-- Publica y materializa destinatarios en una sola transacción. INVOKER: solo administración
-- (RLS de comunicados, miembros, unidades y cargos); "morosos" sale de app.morosidad.
CREATE FUNCTION app.publicar_comunicado(p_comunicado uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  c comunicados%ROWTYPE;
  n integer;
BEGIN
  SELECT * INTO c FROM comunicados WHERE id = p_comunicado FOR UPDATE;
  IF NOT FOUND OR NOT (c.coto_id = ANY (app.cotos_admin())) THEN
    RAISE EXCEPTION 'Comunicado no encontrado' USING ERRCODE = 'UA404';
  END IF;
  IF c.publicado THEN
    RAISE EXCEPTION 'El comunicado ya fue publicado' USING ERRCODE = 'UA409';
  END IF;

  INSERT INTO comunicados_lectura (comunicado_id, usuario_id, coto_id)
  SELECT DISTINCT c.id, m.usuario_id, c.coto_id
    FROM miembros_coto m
    LEFT JOIN unidades u ON u.id = m.unidad_id
   WHERE m.coto_id = c.coto_id AND m.activo
     AND CASE c.dirigido_a
           WHEN 'todos'        THEN true
           WHEN 'propietarios' THEN m.rol = 'residente_propietario'
           WHEN 'sector'       THEN u.sector_id = c.sector_id
           WHEN 'unidades'     THEN m.unidad_id = ANY (c.unidades_ids)
           WHEN 'morosos'      THEN m.rol = 'residente_propietario'
                                    AND m.unidad_id IN (SELECT x.unidad_id FROM app.morosidad(c.coto_id) x)
           ELSE false
         END;
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE comunicados SET publicado = true, publicado_en = now() WHERE id = c.id;
  RETURN n;
END $$;

-- Preferencias de notificación (el horario de silencio 22:00–07:00 es fijo, en la zona del coto).
ALTER TABLE usuarios
  ADD COLUMN notif_correo boolean NOT NULL DEFAULT true,
  ADD COLUMN notif_whatsapp boolean NOT NULL DEFAULT true;
GRANT UPDATE (notif_correo, notif_whatsapp) ON usuarios TO app_service;

-- ─── 4.2 Bot de WhatsApp ───
-- Una instancia Evolution por coto. El nombre queda atado al coto por constraint.
CREATE TABLE evolution_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coto_id          uuid NOT NULL UNIQUE REFERENCES cotos(id),
  instance_name    varchar(60) NOT NULL UNIQUE,
  chip_activado_en date NOT NULL DEFAULT current_date,
  activo           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evolution_instances_nombre_ck CHECK (instance_name = 'coto_' || coto_id::text)
);
ALTER TABLE evolution_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker ON evolution_instances TO app_worker USING (true) WITH CHECK (true);
CREATE POLICY coto_activo ON evolution_instances AS RESTRICTIVE TO app_service
  USING ((SELECT app.coto_activo()) IS NULL OR coto_id = (SELECT app.coto_activo()));
CREATE POLICY sel ON evolution_instances FOR SELECT TO app_service USING (coto_id = ANY ((SELECT app.cotos_staff())::uuid[]));
-- Alta y baja de instancias: solo operaciones de plataforma (app_worker / dueño).
GRANT SELECT ON evolution_instances TO app_service;
GRANT SELECT, INSERT, UPDATE ON evolution_instances TO app_worker;
CREATE TRIGGER inmutable BEFORE UPDATE ON evolution_instances
  FOR EACH ROW EXECUTE FUNCTION app.tg_inmutable('coto_id', 'instance_name');

-- Instancia → coto y teléfono → residente. Solo teléfonos VERIFICADOS de miembros activos de ese coto;
-- si el teléfono es ambiguo (dos personas), no resuelve. Devuelve solo identificadores.
-- ponytail: compara los últimos 10 dígitos (numeración MX, absorbe el "521" de WhatsApp); filtra por coto primero.
CREATE FUNCTION app.bot_resolver(p_instancia text, p_telefono text)
RETURNS TABLE (coto_id uuid, usuario_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ei.coto_id, (array_agg(DISTINCT us.id))[1]
    FROM evolution_instances ei
    JOIN miembros_coto m ON m.coto_id = ei.coto_id AND m.activo
    JOIN usuarios us ON us.id = m.usuario_id AND us.activo AND us.telefono_verificado
   WHERE ei.instance_name = p_instancia AND ei.activo
     AND length(regexp_replace(p_telefono, '\D', '', 'g')) >= 10
     AND right(regexp_replace(us.telefono, '\D', '', 'g'), 10) = right(regexp_replace(p_telefono, '\D', '', 'g'), 10)
   GROUP BY ei.coto_id
  HAVING count(DISTINCT us.id) = 1
$$;

-- ─── 4.4 Tickets: adjuntos, SLA e idempotencia ───
ALTER TABLE tickets
  ADD COLUMN adjuntos text[] NOT NULL DEFAULT '{}',
  ADD COLUMN sla_vence_en timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  ADD COLUMN sla_vencido boolean NOT NULL DEFAULT false,
  ADD COLUMN clave_idempotencia varchar(100),
  ADD CONSTRAINT tickets_adjuntos_ck CHECK (cardinality(adjuntos) <= 5);
CREATE UNIQUE INDEX tickets_clave_idempotencia_key ON tickets (clave_idempotencia);
CREATE INDEX tickets_sla_idx ON tickets (sla_vence_en) WHERE NOT sla_vencido AND estado IN ('abierto', 'en_proceso');

-- Quien reporta no fija su propio SLA.
CREATE FUNCTION app.tg_tickets_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sla_vence_en := now() + interval '72 hours';
  NEW.sla_vencido := false;
  RETURN NEW;
END $$;
CREATE TRIGGER defaults BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION app.tg_tickets_defaults();

ALTER TABLE ticket_comentarios ADD COLUMN clave_idempotencia varchar(100);
CREATE UNIQUE INDEX ticket_comentarios_clave_idempotencia_key ON ticket_comentarios (clave_idempotencia);

-- ─── 4.4 Votaciones: estado programada, idempotencia y resultados agregados ───
ALTER TABLE votaciones DROP CONSTRAINT votaciones_ck;
ALTER TABLE votaciones
  ADD CONSTRAINT votaciones_ck CHECK (
    fecha_fin > fecha_inicio AND estado IN ('borrador', 'programada', 'activa', 'cerrada', 'cancelada')),
  ADD COLUMN clave_idempotencia varchar(100);
CREATE UNIQUE INDEX votaciones_clave_idempotencia_key ON votaciones (clave_idempotencia);
CREATE INDEX votaciones_programadas_idx ON votaciones (estado, fecha_inicio, fecha_fin) WHERE estado IN ('programada', 'activa');

-- Solo staff, solo agregados: votos y peso por opción, participación y quórum por indiviso.
CREATE FUNCTION app.resultados_votacion(p_votacion uuid)
RETURNS TABLE (opcion_id uuid, opcion text, votos integer, peso numeric,
               unidades_votantes integer, unidades_totales integer, indiviso_votante numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH v AS (
    SELECT v.id, v.coto_id FROM votaciones v
     WHERE v.id = p_votacion
       AND v.coto_id = ANY (app.cotos_staff())
       AND ((SELECT app.coto_activo()) IS NULL OR v.coto_id = (SELECT app.coto_activo()))
  ),
  tot AS (
    SELECT count(*)::int AS votantes, coalesce(sum(u.indiviso), 0) AS indiviso
      FROM v JOIN votos x ON x.votacion_id = v.id JOIN unidades u ON u.id = x.unidad_id
  )
  SELECT o.id, o.texto::text, count(vo.id)::int, coalesce(sum(vo.peso), 0),
         tot.votantes,
         (SELECT count(*)::int FROM unidades u WHERE u.coto_id = v.coto_id AND u.activo),
         tot.indiviso
    FROM v
    CROSS JOIN tot
    JOIN opciones_voto o ON o.votacion_id = v.id
    LEFT JOIN votos vo ON vo.opcion_id = o.id
   GROUP BY v.coto_id, o.id, o.texto, tot.votantes, tot.indiviso
   ORDER BY o.texto, o.id
$$;

REVOKE EXECUTE ON FUNCTION
  app.publicar_comunicado(uuid),
  app.bot_resolver(text, text),
  app.resultados_votacion(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.publicar_comunicado(uuid), app.resultados_votacion(uuid) TO app_service;
GRANT EXECUTE ON FUNCTION app.bot_resolver(text, text) TO app_service;
