-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateTable
CREATE TABLE "staff_plataforma" (
    "usuario_id" UUID NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_plataforma_pkey" PRIMARY KEY ("usuario_id")
);

-- CreateTable
CREATE TABLE "soporte_accesos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "otorgado_por" UUID NOT NULL,
    "ticket_ref" VARCHAR(50) NOT NULL,
    "desde" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hasta" TIMESTAMPTZ NOT NULL,
    "revocado_en" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "soporte_accesos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proveedor" VARCHAR(20) NOT NULL,
    "event_id" VARCHAR(200) NOT NULL,
    "tipo" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "recibido_en" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "procesado_en" TIMESTAMPTZ,
    "intentos" SMALLINT NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizaciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "rfc" VARCHAR(13),
    "razon_social" VARCHAR(300),
    "email_contacto" CITEXT NOT NULL,
    "telefono" VARCHAR(20),
    "custom_domain" VARCHAR(255),
    "logo_url" TEXT,
    "color_primario" VARCHAR(7) DEFAULT '#1E40AF',
    "color_secundario" VARCHAR(7) DEFAULT '#3B82F6',
    "favicon_url" TEXT,
    "stripe_customer_id" VARCHAR(100),
    "tier_mayoreo" VARCHAR(20) NOT NULL DEFAULT 'tier_1',
    "wallet_creditos" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "auto_recarga" BOOLEAN NOT NULL DEFAULT false,
    "monto_recarga_min" DECIMAL(12,2) NOT NULL DEFAULT 2000.00,
    "estado_suscripcion" VARCHAR(20) NOT NULL DEFAULT 'activo',
    "aviso_privacidad_url" TEXT,
    "aviso_version" INTEGER NOT NULL DEFAULT 1,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_miembros" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "rol" VARCHAR(20) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_miembros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['read']::TEXT[],
    "ip_whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ultimo_uso" TIMESTAMPTZ,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cotos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "zona_horaria" VARCHAR(50) NOT NULL DEFAULT 'America/Mexico_City',
    "direccion" TEXT,
    "colonia" VARCHAR(200),
    "ciudad" VARCHAR(100),
    "estado" VARCHAR(100),
    "cp" VARCHAR(5),
    "latitud" DECIMAL(10,8),
    "longitud" DECIMAL(11,8),
    "tipo" VARCHAR(30) NOT NULL DEFAULT 'coto',
    "regimen_legal" VARCHAR(50),
    "dia_corte" SMALLINT NOT NULL DEFAULT 1,
    "dia_limite_pago" SMALLINT NOT NULL DEFAULT 10,
    "tasa_moratoria" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "tipo_moratoria" VARCHAR(10) NOT NULL DEFAULT 'ninguno',
    "descuento_pronto_pago" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "dias_gracia" SMALLINT NOT NULL DEFAULT 0,
    "bloquear_amenidades_morosos" BOOLEAN NOT NULL DEFAULT true,
    "meses_morosidad_bloqueo" SMALLINT NOT NULL DEFAULT 2,
    "rfc_coto" VARCHAR(13),
    "razon_social_coto" VARCHAR(300),
    "regimen_fiscal" VARCHAR(5),
    "cp_fiscal" VARCHAR(5),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cotos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coto_secretos" (
    "coto_id" UUID NOT NULL,
    "csd_cert" BYTEA NOT NULL,
    "csd_key" BYTEA NOT NULL,
    "csd_password" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coto_secretos_pkey" PRIMARY KEY ("coto_id")
);

-- CreateTable
CREATE TABLE "sectores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "tipo" VARCHAR(30) NOT NULL DEFAULT 'seccion',
    "orden" SMALLINT NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sectores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unidades" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "sector_id" UUID,
    "numero" VARCHAR(20) NOT NULL,
    "tipo" VARCHAR(30) NOT NULL DEFAULT 'casa',
    "superficie_m2" DECIMAL(10,2),
    "indiviso" DECIMAL(8,6),
    "saldo_a_favor" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "ocupada" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_id" UUID NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "apellido_paterno" VARCHAR(100) NOT NULL,
    "apellido_materno" VARCHAR(100),
    "email" CITEXT NOT NULL,
    "telefono" VARCHAR(20),
    "telefono_verificado" BOOLEAN NOT NULL DEFAULT false,
    "mfa_activo" BOOLEAN NOT NULL DEFAULT false,
    "acepto_aviso_privacidad" BOOLEAN NOT NULL DEFAULT false,
    "fecha_aceptacion_aviso" TIMESTAMPTZ,
    "version_aviso_aceptado" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "miembros_coto" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID,
    "usuario_id" UUID NOT NULL,
    "rol" VARCHAR(30) NOT NULL,
    "vehiculos" JSONB DEFAULT '[]',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "miembros_coto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conceptos_cargo" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "tipo" VARCHAR(20) NOT NULL,
    "monto_default" DECIMAL(12,2),
    "usa_indiviso" BOOLEAN NOT NULL DEFAULT false,
    "es_recurrente" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conceptos_cargo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cargos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "concepto_id" UUID NOT NULL,
    "periodo" VARCHAR(7) NOT NULL,
    "monto_original" DECIMAL(12,2) NOT NULL,
    "monto_moratoria" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "monto_descuento" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "saldo_pendiente" DECIMAL(12,2) NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    "fecha_emision" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_vencimiento" DATE NOT NULL,
    "clave_idempotencia" VARCHAR(100),
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cargos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodo" VARCHAR(30) NOT NULL,
    "gateway" VARCHAR(20),
    "gateway_order_id" VARCHAR(100),
    "gateway_charge_id" VARCHAR(100),
    "comprobante_url" TEXT,
    "referencia_bancaria" VARCHAR(50),
    "estado" VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    "fecha_pago" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_confirmacion" TIMESTAMPTZ,
    "aplicado_en" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detalle_pagos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "pago_id" UUID NOT NULL,
    "cargo_id" UUID NOT NULL,
    "monto_aplicado" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detalle_pagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo" VARCHAR(20) NOT NULL,
    "gateway" VARCHAR(20) NOT NULL DEFAULT 'conekta',
    "gateway_customer_id" VARCHAR(100) NOT NULL,
    "gateway_source_id" VARCHAR(100),
    "label" VARCHAR(100),
    "ultimos_4" CHAR(4),
    "marca_tarjeta" VARCHAR(20),
    "fecha_expiracion" VARCHAR(7),
    "es_default" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autopay_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "payment_method_id" UUID,
    "activo" BOOLEAN NOT NULL DEFAULT false,
    "dia_cobro" SMALLINT NOT NULL DEFAULT 5,
    "max_reintentos" SMALLINT NOT NULL DEFAULT 3,
    "dias_entre_reintentos" INTEGER[] DEFAULT ARRAY[3, 7, 14]::INTEGER[],
    "intentos_fallidos" SMALLINT NOT NULL DEFAULT 0,
    "ultimo_cobro_exitoso" DATE,
    "proximo_cobro" DATE,
    "estado" VARCHAR(25) NOT NULL DEFAULT 'activo',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autopay_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autopay_intentos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "autopay_id" UUID NOT NULL,
    "coto_id" UUID NOT NULL,
    "cargo_id" UUID,
    "pago_id" UUID,
    "intento_num" SMALLINT NOT NULL,
    "monto_centavos" INTEGER NOT NULL,
    "gateway" VARCHAR(20) NOT NULL,
    "gateway_order_id" VARCHAR(100),
    "estado" VARCHAR(20) NOT NULL,
    "codigo_error" VARCHAR(50),
    "mensaje_error" TEXT,
    "programado_para" TIMESTAMPTZ NOT NULL,
    "ejecutado_en" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autopay_intentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facturas_cfdi" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "pago_id" UUID,
    "uuid_cfdi" VARCHAR(36),
    "serie" VARCHAR(10),
    "folio" VARCHAR(20),
    "emisor_rfc" VARCHAR(13) NOT NULL,
    "emisor_nombre" VARCHAR(300) NOT NULL,
    "receptor_rfc" VARCHAR(13) NOT NULL,
    "receptor_nombre" VARCHAR(300) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "xml_url" TEXT,
    "pdf_url" TEXT,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'timbrado',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facturas_cfdi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paquetes_timbres" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "usados" INTEGER NOT NULL DEFAULT 0,
    "precio_unitario" DECIMAL(6,2) NOT NULL,
    "total_pagado" DECIMAL(10,2) NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'activo',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paquetes_timbres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuentas_bancarias" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "banco" VARCHAR(100) NOT NULL,
    "titular" VARCHAR(200),
    "clabe" VARCHAR(18),
    "tipo" VARCHAR(30) NOT NULL DEFAULT 'operativa',
    "saldo_registrado" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cuentas_bancarias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proveedores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "rfc" VARCHAR(13),
    "telefono" VARCHAR(20),
    "categoria" VARCHAR(50),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proveedores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "egresos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "cuenta_bancaria_id" UUID,
    "proveedor_id" UUID,
    "concepto" VARCHAR(200) NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "fecha" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "egresos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitaciones_acceso" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "creado_por" UUID NOT NULL,
    "nombre_invitado" VARCHAR(200) NOT NULL,
    "tipo" VARCHAR(30) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "codigo_numerico" CHAR(6),
    "valido_desde" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valido_hasta" TIMESTAMPTZ,
    "max_usos" INTEGER DEFAULT 1,
    "usos_actuales" INTEGER NOT NULL DEFAULT 0,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'activo',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitaciones_acceso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registros_acceso" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "invitacion_id" UUID,
    "unidad_destino" UUID,
    "guardia_id" UUID,
    "tipo_persona" VARCHAR(20) NOT NULL,
    "nombre" VARCHAR(200),
    "placa" VARCHAR(15),
    "metodo" VARCHAR(20),
    "tipo_movimiento" VARCHAR(10) NOT NULL DEFAULT 'entrada',
    "autorizado" BOOLEAN NOT NULL,
    "fecha_hora" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registros_acceso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispositivos_iot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "tipo" VARCHAR(30) NOT NULL,
    "mac_address" VARCHAR(17),
    "api_key_hash" CHAR(64),
    "estado" VARCHAR(20) NOT NULL DEFAULT 'activo',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispositivos_iot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amenidades" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "tipo" VARCHAR(30),
    "capacidad_max" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amenidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservaciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "amenidad_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "hora_inicio" TIME NOT NULL,
    "hora_fin" TIME NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'confirmada',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comunicados" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "titulo" VARCHAR(200) NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "prioridad" VARCHAR(10) NOT NULL DEFAULT 'normal',
    "publicado" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comunicados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "unidad_id" UUID,
    "reportado_por" UUID NOT NULL,
    "numero" SERIAL NOT NULL,
    "titulo" VARCHAR(200) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "categoria" VARCHAR(30),
    "estado" VARCHAR(20) NOT NULL DEFAULT 'abierto',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comentarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "comentario" TEXT NOT NULL,
    "es_interno" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comentarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votaciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "titulo" VARCHAR(200) NOT NULL,
    "ponderada_por_indiviso" BOOLEAN NOT NULL DEFAULT false,
    "fecha_inicio" TIMESTAMPTZ NOT NULL,
    "fecha_fin" TIMESTAMPTZ NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'borrador',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opciones_voto" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coto_id" UUID NOT NULL,
    "votacion_id" UUID NOT NULL,
    "texto" VARCHAR(300) NOT NULL,

    CONSTRAINT "opciones_voto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "votacion_id" UUID NOT NULL,
    "coto_id" UUID NOT NULL,
    "opcion_id" UUID NOT NULL,
    "miembro_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "peso" DECIMAL(10,6) NOT NULL DEFAULT 1,
    "emitido_en" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_outbox" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "coto_id" UUID,
    "usuario_id" UUID,
    "accion" VARCHAR(60) NOT NULL,
    "recurso_tipo" VARCHAR(50) NOT NULL,
    "recurso_id" UUID,
    "datos_antes" JSONB,
    "datos_despues" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "coto_id" UUID,
    "usuario_id" UUID,
    "accion" VARCHAR(60) NOT NULL,
    "recurso_tipo" VARCHAR(50) NOT NULL,
    "recurso_id" UUID,
    "datos_antes" JSONB,
    "datos_despues" JSONB,
    "metadata" JSONB,
    "hash_anterior" CHAR(64) NOT NULL,
    "hash_integridad" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_head" (
    "org_id" UUID NOT NULL,
    "ultimo_hash" CHAR(64) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("org_id")
);

-- CreateIndex
CREATE INDEX "soporte_accesos_org_id_hasta_idx" ON "soporte_accesos"("org_id", "hasta");

-- CreateIndex
CREATE INDEX "webhook_events_procesado_en_recibido_en_idx" ON "webhook_events"("procesado_en", "recibido_en");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_proveedor_event_id_key" ON "webhook_events"("proveedor", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizaciones_slug_key" ON "organizaciones"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizaciones_custom_domain_key" ON "organizaciones"("custom_domain");

-- CreateIndex
CREATE INDEX "org_miembros_usuario_id_activo_idx" ON "org_miembros"("usuario_id", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "org_miembros_org_id_usuario_id_key" ON "org_miembros"("org_id", "usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_api_keys_key_hash_key" ON "partner_api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "partner_api_keys_org_id_idx" ON "partner_api_keys"("org_id");

-- CreateIndex
CREATE INDEX "cotos_org_id_activo_idx" ON "cotos"("org_id", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "cotos_org_id_slug_key" ON "cotos"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "sectores_coto_id_nombre_key" ON "sectores"("coto_id", "nombre");

-- CreateIndex
CREATE INDEX "unidades_coto_id_activo_ocupada_idx" ON "unidades"("coto_id", "activo", "ocupada");

-- CreateIndex
CREATE UNIQUE INDEX "unidades_coto_id_numero_key" ON "unidades"("coto_id", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_auth_id_key" ON "usuarios"("auth_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "usuarios_telefono_idx" ON "usuarios"("telefono");

-- CreateIndex
CREATE INDEX "miembros_coto_coto_id_unidad_id_rol_idx" ON "miembros_coto"("coto_id", "unidad_id", "rol");

-- CreateIndex
CREATE INDEX "miembros_coto_usuario_id_activo_idx" ON "miembros_coto"("usuario_id", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "miembros_coto_coto_id_usuario_id_rol_unidad_id_key" ON "miembros_coto"("coto_id", "usuario_id", "rol", "unidad_id");

-- CreateIndex
CREATE UNIQUE INDEX "conceptos_cargo_coto_id_nombre_key" ON "conceptos_cargo"("coto_id", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "cargos_clave_idempotencia_key" ON "cargos"("clave_idempotencia");

-- CreateIndex
CREATE INDEX "cargos_coto_id_periodo_idx" ON "cargos"("coto_id", "periodo");

-- CreateIndex
CREATE INDEX "cargos_coto_id_estado_fecha_vencimiento_idx" ON "cargos"("coto_id", "estado", "fecha_vencimiento");

-- CreateIndex
CREATE INDEX "cargos_unidad_id_estado_fecha_vencimiento_idx" ON "cargos"("unidad_id", "estado", "fecha_vencimiento");

-- CreateIndex
CREATE UNIQUE INDEX "pagos_gateway_order_id_key" ON "pagos"("gateway_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "pagos_gateway_charge_id_key" ON "pagos"("gateway_charge_id");

-- CreateIndex
CREATE INDEX "pagos_coto_id_estado_fecha_pago_idx" ON "pagos"("coto_id", "estado", "fecha_pago");

-- CreateIndex
CREATE INDEX "pagos_unidad_id_fecha_pago_idx" ON "pagos"("unidad_id", "fecha_pago");

-- CreateIndex
CREATE INDEX "detalle_pagos_cargo_id_idx" ON "detalle_pagos"("cargo_id");

-- CreateIndex
CREATE UNIQUE INDEX "detalle_pagos_pago_id_cargo_id_key" ON "detalle_pagos"("pago_id", "cargo_id");

-- CreateIndex
CREATE INDEX "payment_methods_unidad_id_activo_idx" ON "payment_methods"("unidad_id", "activo");

-- CreateIndex
CREATE INDEX "payment_methods_usuario_id_idx" ON "payment_methods"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "autopay_config_unidad_id_key" ON "autopay_config"("unidad_id");

-- CreateIndex
CREATE INDEX "autopay_config_estado_proximo_cobro_idx" ON "autopay_config"("estado", "proximo_cobro");

-- CreateIndex
CREATE INDEX "autopay_intentos_programado_para_estado_idx" ON "autopay_intentos"("programado_para", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "autopay_intentos_autopay_id_cargo_id_intento_num_key" ON "autopay_intentos"("autopay_id", "cargo_id", "intento_num");

-- CreateIndex
CREATE UNIQUE INDEX "facturas_cfdi_pago_id_key" ON "facturas_cfdi"("pago_id");

-- CreateIndex
CREATE UNIQUE INDEX "facturas_cfdi_uuid_cfdi_key" ON "facturas_cfdi"("uuid_cfdi");

-- CreateIndex
CREATE INDEX "facturas_cfdi_coto_id_created_at_idx" ON "facturas_cfdi"("coto_id", "created_at");

-- CreateIndex
CREATE INDEX "paquetes_timbres_org_id_idx" ON "paquetes_timbres"("org_id");

-- CreateIndex
CREATE INDEX "cuentas_bancarias_coto_id_idx" ON "cuentas_bancarias"("coto_id");

-- CreateIndex
CREATE INDEX "proveedores_coto_id_idx" ON "proveedores"("coto_id");

-- CreateIndex
CREATE INDEX "egresos_coto_id_fecha_idx" ON "egresos"("coto_id", "fecha");

-- CreateIndex
CREATE INDEX "egresos_coto_id_estado_idx" ON "egresos"("coto_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "invitaciones_acceso_token_hash_key" ON "invitaciones_acceso"("token_hash");

-- CreateIndex
CREATE INDEX "invitaciones_acceso_coto_id_estado_valido_hasta_idx" ON "invitaciones_acceso"("coto_id", "estado", "valido_hasta");

-- CreateIndex
CREATE INDEX "invitaciones_acceso_coto_id_codigo_numerico_idx" ON "invitaciones_acceso"("coto_id", "codigo_numerico");

-- CreateIndex
CREATE INDEX "invitaciones_acceso_unidad_id_estado_idx" ON "invitaciones_acceso"("unidad_id", "estado");

-- CreateIndex
CREATE INDEX "registros_acceso_coto_id_fecha_hora_idx" ON "registros_acceso"("coto_id", "fecha_hora");

-- CreateIndex
CREATE INDEX "registros_acceso_unidad_destino_fecha_hora_idx" ON "registros_acceso"("unidad_destino", "fecha_hora");

-- CreateIndex
CREATE UNIQUE INDEX "dispositivos_iot_api_key_hash_key" ON "dispositivos_iot"("api_key_hash");

-- CreateIndex
CREATE INDEX "dispositivos_iot_coto_id_idx" ON "dispositivos_iot"("coto_id");

-- CreateIndex
CREATE INDEX "amenidades_coto_id_idx" ON "amenidades"("coto_id");

-- CreateIndex
CREATE INDEX "reservaciones_amenidad_id_fecha_hora_inicio_idx" ON "reservaciones"("amenidad_id", "fecha", "hora_inicio");

-- CreateIndex
CREATE INDEX "reservaciones_unidad_id_fecha_idx" ON "reservaciones"("unidad_id", "fecha");

-- CreateIndex
CREATE INDEX "comunicados_coto_id_publicado_created_at_idx" ON "comunicados"("coto_id", "publicado", "created_at");

-- CreateIndex
CREATE INDEX "tickets_coto_id_estado_created_at_idx" ON "tickets"("coto_id", "estado", "created_at");

-- CreateIndex
CREATE INDEX "tickets_reportado_por_idx" ON "tickets"("reportado_por");

-- CreateIndex
CREATE INDEX "ticket_comentarios_ticket_id_created_at_idx" ON "ticket_comentarios"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "votaciones_coto_id_estado_idx" ON "votaciones"("coto_id", "estado");

-- CreateIndex
CREATE INDEX "opciones_voto_votacion_id_idx" ON "opciones_voto"("votacion_id");

-- CreateIndex
CREATE INDEX "votos_opcion_id_idx" ON "votos"("opcion_id");

-- CreateIndex
CREATE UNIQUE INDEX "votos_votacion_id_unidad_id_key" ON "votos"("votacion_id", "unidad_id");

-- CreateIndex
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_coto_id_created_at_idx" ON "audit_log"("coto_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_usuario_id_created_at_idx" ON "audit_log"("usuario_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "staff_plataforma" ADD CONSTRAINT "staff_plataforma_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "soporte_accesos" ADD CONSTRAINT "soporte_accesos_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "soporte_accesos" ADD CONSTRAINT "soporte_accesos_otorgado_por_fkey" FOREIGN KEY ("otorgado_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_miembros" ADD CONSTRAINT "org_miembros_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_miembros" ADD CONSTRAINT "org_miembros_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_api_keys" ADD CONSTRAINT "partner_api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotos" ADD CONSTRAINT "cotos_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coto_secretos" ADD CONSTRAINT "coto_secretos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sectores" ADD CONSTRAINT "sectores_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unidades" ADD CONSTRAINT "unidades_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unidades" ADD CONSTRAINT "unidades_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "miembros_coto" ADD CONSTRAINT "miembros_coto_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "miembros_coto" ADD CONSTRAINT "miembros_coto_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "miembros_coto" ADD CONSTRAINT "miembros_coto_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conceptos_cargo" ADD CONSTRAINT "conceptos_cargo_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargos" ADD CONSTRAINT "cargos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargos" ADD CONSTRAINT "cargos_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargos" ADD CONSTRAINT "cargos_concepto_id_fkey" FOREIGN KEY ("concepto_id") REFERENCES "conceptos_cargo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_pagos" ADD CONSTRAINT "detalle_pagos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_pagos" ADD CONSTRAINT "detalle_pagos_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_pagos" ADD CONSTRAINT "detalle_pagos_cargo_id_fkey" FOREIGN KEY ("cargo_id") REFERENCES "cargos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_config" ADD CONSTRAINT "autopay_config_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_config" ADD CONSTRAINT "autopay_config_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_config" ADD CONSTRAINT "autopay_config_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_intentos" ADD CONSTRAINT "autopay_intentos_autopay_id_fkey" FOREIGN KEY ("autopay_id") REFERENCES "autopay_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_intentos" ADD CONSTRAINT "autopay_intentos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_intentos" ADD CONSTRAINT "autopay_intentos_cargo_id_fkey" FOREIGN KEY ("cargo_id") REFERENCES "cargos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_intentos" ADD CONSTRAINT "autopay_intentos_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_cfdi" ADD CONSTRAINT "facturas_cfdi_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_cfdi" ADD CONSTRAINT "facturas_cfdi_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paquetes_timbres" ADD CONSTRAINT "paquetes_timbres_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas_bancarias" ADD CONSTRAINT "cuentas_bancarias_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "egresos" ADD CONSTRAINT "egresos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "egresos" ADD CONSTRAINT "egresos_cuenta_bancaria_id_fkey" FOREIGN KEY ("cuenta_bancaria_id") REFERENCES "cuentas_bancarias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "egresos" ADD CONSTRAINT "egresos_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitaciones_acceso" ADD CONSTRAINT "invitaciones_acceso_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitaciones_acceso" ADD CONSTRAINT "invitaciones_acceso_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitaciones_acceso" ADD CONSTRAINT "invitaciones_acceso_creado_por_fkey" FOREIGN KEY ("creado_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_acceso" ADD CONSTRAINT "registros_acceso_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_acceso" ADD CONSTRAINT "registros_acceso_invitacion_id_fkey" FOREIGN KEY ("invitacion_id") REFERENCES "invitaciones_acceso"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_acceso" ADD CONSTRAINT "registros_acceso_unidad_destino_fkey" FOREIGN KEY ("unidad_destino") REFERENCES "unidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_acceso" ADD CONSTRAINT "registros_acceso_guardia_id_fkey" FOREIGN KEY ("guardia_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispositivos_iot" ADD CONSTRAINT "dispositivos_iot_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amenidades" ADD CONSTRAINT "amenidades_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservaciones" ADD CONSTRAINT "reservaciones_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservaciones" ADD CONSTRAINT "reservaciones_amenidad_id_fkey" FOREIGN KEY ("amenidad_id") REFERENCES "amenidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservaciones" ADD CONSTRAINT "reservaciones_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservaciones" ADD CONSTRAINT "reservaciones_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comunicados" ADD CONSTRAINT "comunicados_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reportado_por_fkey" FOREIGN KEY ("reportado_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comentarios" ADD CONSTRAINT "ticket_comentarios_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comentarios" ADD CONSTRAINT "ticket_comentarios_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comentarios" ADD CONSTRAINT "ticket_comentarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votaciones" ADD CONSTRAINT "votaciones_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opciones_voto" ADD CONSTRAINT "opciones_voto_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opciones_voto" ADD CONSTRAINT "opciones_voto_votacion_id_fkey" FOREIGN KEY ("votacion_id") REFERENCES "votaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votos" ADD CONSTRAINT "votos_coto_id_fkey" FOREIGN KEY ("coto_id") REFERENCES "cotos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votos" ADD CONSTRAINT "votos_votacion_id_fkey" FOREIGN KEY ("votacion_id") REFERENCES "votaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votos" ADD CONSTRAINT "votos_opcion_id_fkey" FOREIGN KEY ("opcion_id") REFERENCES "opciones_voto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votos" ADD CONSTRAINT "votos_miembro_id_fkey" FOREIGN KEY ("miembro_id") REFERENCES "miembros_coto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votos" ADD CONSTRAINT "votos_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

