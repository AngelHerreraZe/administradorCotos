# Plan Backend Full: Administrador de Cotos

> **Versión:** 1.0 — Noviembre 2026
> **Objetivo:** Documento maestro de arquitectura, seguridad, esquema de base de datos, módulos API, infraestructura y hoja de ruta para un backend SaaS multi-inquilino de clase empresarial listo para venta al por mayor a administradores de condominios, despachos inmobiliarios y desarrolladores de vivienda en México y LATAM.

> [!CAUTION]
> **Seguridad como requisito #1.** Este sistema procesa datos personales protegidos por la LFPDPPP (México), datos financieros bancarios (tokens PCI-DSS), registros de acceso físico con datos biométricos y comunicaciones privadas vecinales. Cada decisión arquitectónica prioriza la protección de datos por encima de la velocidad de desarrollo.

---

## Tabla de Contenidos

1. [Visión del Producto y Modelo de Negocio](#1-visión-del-producto-y-modelo-de-negocio)
2. [Principios Arquitectónicos](#2-principios-arquitectónicos)
3. [Arquitectura de Alto Nivel](#3-arquitectura-de-alto-nivel)
4. [Modelo de Seguridad Integral](#4-modelo-de-seguridad-integral)
5. [Esquema de Base de Datos Completo](#5-esquema-de-base-de-datos-completo)
6. [Módulos del Sistema y API Endpoints](#6-módulos-del-sistema-y-api-endpoints)
7. [Motor de Pagos y Auto-Pay](#7-motor-de-pagos-y-auto-pay)
8. [Motor de IA y WhatsApp](#8-motor-de-ia-y-whatsapp)
9. [Motor de Accesos e IoT](#9-motor-de-accesos-e-iot)
10. [Infraestructura, DevOps y Observabilidad](#10-infraestructura-devops-y-observabilidad)
11. [Cumplimiento Legal y Privacidad (LFPDPPP / PCI-DSS)](#11-cumplimiento-legal-y-privacidad)
12. [Plan de Disaster Recovery y Backups](#12-disaster-recovery-y-backups)
13. [Hoja de Ruta de Implementación](#13-hoja-de-ruta-de-implementación)
14. [Métricas de Éxito y KPIs](#14-métricas-de-éxito-y-kpis)

---

## 1. Visión del Producto y Modelo de Negocio

### 1.1 Propuesta de Valor
**Administrador de Cotos** es una plataforma SaaS B2B2C que permite a administradores de condominios, empresas inmobiliarias y mesas directivas de fraccionamientos cerrados en México y LATAM gestionar integralmente finanzas, cobranza, accesos, comunicación y gobernanza condominal, con:
- **Cero fricción vecinal** (WhatsApp primero, cero apps obligatorias).
- **Cobros automáticos** (domiciliación, tarjeta y OXXO).
- **Transparencia financiera total** (estados de cuenta en tiempo real).
- **Seguridad de datos de clase bancaria** (encriptación, RLS, auditoría completa).

### 1.2 Modelo de Venta al Por Mayor

| Canal | Precio Sugerido | Margen |
| :--- | :--- | :--- |
| **Directo (por coto)** | $299-499 MXN / coto / mes | 100% |
| **Mayoreo a Administradores Profesionales** (10+ cotos) | $199 MXN / coto / mes | Volumen |
| **White Label para Desarrolladores de Vivienda** | $149 MXN / coto / mes + Setup $5,000 | Alto volumen |
| **Enterprise (100+ cotos)** | Precio negociado | Custom |

**Ingresos adicionales:**
- Comisión por transacción de pago en línea (0.5-1.5% sobre monto cobrado).
- Venta de paquetes de timbres CFDI ($1.50-$3.00 MXN por timbre).
- Módulos premium: IoT/RFID, reconocimiento de placas, IA avanzada.

---

## 2. Principios Arquitectónicos

| # | Principio | Implicación |
| :--- | :--- | :--- |
| P1 | **Security by Default** | Todo dato en reposo cifrado (AES-256). Todo dato en tránsito sobre TLS 1.3. Nunca almacenar datos raw de tarjetas. |
| P2 | **Multi-Tenant Isolation** | Row-Level Security (RLS) en PostgreSQL. Aislamiento total entre cotos y entre organizaciones. |
| P3 | **Defense in Depth** | Validación en 4 capas: CDN/WAF → API Gateway → Middleware Auth → Postgres RLS. |
| P4 | **Least Privilege** | Cada rol (residente, admin, guardia, superadmin) accede solo a lo que necesita. |
| P5 | **Auditabilidad Total** | Cada acción sensible (pagos, accesos, cambios de permisos) genera un registro inmutable en `audit_log`. |
| P6 | **API-First** | Backend 100% API REST/GraphQL. Cualquier interfaz (web, app, bot, IoT) consume la misma API. |
| P7 | **Event-Driven** | Pagos, accesos y notificaciones se procesan mediante eventos asincrónicos (colas BullMQ). |
| P8 | **Modular Monolith → Microservicios** | Iniciar como monolito modular bien separado; extraer servicios solo cuando la escala lo justifique. |
| P9 | **Zero Trust** | No confiar en ningún input externo. Validar, sanitizar y verificar firmas en cada boundary. |
| P10 | **Observabilidad Nativa** | Logs estructurados, métricas, trazas distribuidas y alertas desde el día 1. |

---

## 3. Arquitectura de Alto Nivel

```mermaid
graph TB
    subgraph Clients["🌐 Clientes"]
        WEB["Portal Web Admin\n(Next.js SSR)"]
        RAPP["App Móvil Residente\n(React Native / Expo)"]
        GAPP["App Caseta / Guardia\n(React Native Kiosk)"]
        WABOT["WhatsApp Bot\n(Meta Cloud API)"]
        IOT["Dispositivos IoT\n(RFID / LPR / Plumas)"]
    end

    subgraph Edge["🛡️ Capa de Seguridad Perimetral"]
        CDN["Cloudflare CDN + WAF\nDDoS Protection\nBot Management"]
        RATELIMIT["Rate Limiter\n(Token Bucket per Tenant)"]
    end

    subgraph API["⚙️ Capa de Aplicación"]
        GATEWAY["API Gateway\n(Next.js API Routes / NestJS)"]
        AUTH["Auth Service\n(Supabase Auth + Custom RBAC)"]
        MIDDLEWARE["Middleware Pipeline\n- JWT Validation\n- Tenant Context Injection\n- Request Sanitization\n- Rate Limiting\n- Audit Logging"]
    end

    subgraph Modules["📦 Módulos de Negocio"]
        MOD_ORG["🏢 Organizaciones & Cotos"]
        MOD_FIN["💰 Finanzas & Contabilidad"]
        MOD_PAY["💳 Pagos & Auto-Pay"]
        MOD_FAC["🧾 Facturación CFDI"]
        MOD_ACC["🚪 Control de Accesos"]
        MOD_COM["📢 Comunicación"]
        MOD_AME["🏊 Amenidades"]
        MOD_GOV["🗳️ Gobernanza & Votaciones"]
        MOD_TKT["🎫 Tickets & Soporte"]
        MOD_RPT["📊 Reportes & Analytics"]
        MOD_AI["🤖 Motor IA"]
    end

    subgraph Workers["⏰ Workers Asincrónicos"]
        W_AUTOPAY["Worker Auto-Pay\n(Cobros Programados)"]
        W_NOTIFY["Worker Notificaciones\n(Push + Email + WhatsApp)"]
        W_CFDI["Worker Timbrado CFDI"]
        W_OCR["Worker OCR Comprobantes"]
        W_SYNC["Worker Conciliación Bancaria"]
        W_AUDIT["Worker Audit Log Writer"]
    end

    subgraph Data["🗄️ Capa de Datos"]
        PG[("PostgreSQL 16\n(Supabase)\nRLS Multi-Tenant\nEncrypted at Rest")]
        REDIS[("Redis (Upstash)\nSesiones · Colas\nCache · Rate Limits")]
        S3[("Object Storage\n(Supabase Storage)\nComprobantes · Docs\nFotos Acceso")]
        VAULT[("Secrets Manager\nAPI Keys · CSD SAT\nTokens Pasarela")]
    end

    subgraph External["🔌 Servicios Externos"]
        CONEKTA["Conekta\nTarjeta · CLABE · OXXO"]
        SAT["SAT / PAC Timbrador\nCFDI 4.0"]
        META["Meta Cloud API\nWhatsApp Business"]
        GEMINI["Gemini Flash API\nOCR · NLP"]
        RESEND["Resend\nEmails Transaccionales"]
        PUSH["Expo Push / OneSignal"]
    end

    Clients --> Edge
    Edge --> API
    API --> Modules
    Modules --> Data
    Modules --> Workers
    Workers --> Data
    Workers --> External
    Modules --> External
```

### 3.1 Decisión: Modular Monolith (Fase 1-2) → Microservicios (Fase 3+)

```mermaid
flowchart LR
    subgraph Phase1["Fase 1-2: Monolito Modular"]
        A["Un solo deploy Next.js/NestJS"] --> B["Módulos como carpetas con interfaces limpias"]
        B --> C["Comunicación síncrona via imports"]
        C --> D["Workers BullMQ en proceso separado"]
    end
    subgraph Phase3["Fase 3+: Extracción Selectiva"]
        E["Servicio de Pagos independiente"] --> F["Servicio de Accesos/IoT independiente"]
        F --> G["Servicio de IA/OCR independiente"]
        G --> H["Comunicación via eventos (Redis Streams / NATS)"]
    end
    Phase1 -->|"Cuando >500 cotos\no equipo >6 devs"| Phase3
```

---

## 4. Modelo de Seguridad Integral

> [!WARNING]
> Esta sección es de lectura obligatoria para todo desarrollador que toque el codebase. Cualquier violación a estos controles es un **stop-the-line** inmediato.

### 4.1 Capas de Defensa (Defense in Depth)

```mermaid
flowchart TD
    REQ["Request Entrante"] --> L1
    subgraph L1["Capa 1: Red y Perímetro"]
        WAF["Cloudflare WAF\nBloquea SQLi, XSS, bots"]
        DDOS["DDoS Mitigation\nRate limit global"]
        TLS["TLS 1.3 obligatorio\nHSTS, Certificate Pinning en apps"]
    end
    L1 --> L2
    subgraph L2["Capa 2: Autenticación"]
        JWT["JWT con RS256\n(firmado con clave asimétrica)"]
        MFA["MFA obligatorio para Admins\n(TOTP / SMS OTP)"]
        SESSION["Sesiones: HttpOnly + Secure + SameSite=Strict\nRotación de refresh tokens"]
    end
    L2 --> L3
    subgraph L3["Capa 3: Autorización"]
        RBAC["RBAC Granular\n(Roles + Permisos por Módulo)"]
        TENANT["Tenant Context Injection\nset_config app.current_tenant, true"]
        SCOPE["API Scope Validation\nCada endpoint valida rol + permisos"]
    end
    L3 --> L4
    subgraph L4["Capa 4: Datos"]
        RLS["PostgreSQL RLS\nAislamiento a nivel fila"]
        ENC["Encryption at Rest\nAES-256 (Supabase managed)"]
        MASK["PII Masking en logs\nNunca loguear tokens, contraseñas, datos financieros"]
        AUDIT["Audit Log inmutable\nQuién, qué, cuándo, desde dónde"]
    end
```

### 4.2 Sistema RBAC (Role-Based Access Control)

#### Roles del Sistema

| Rol | Scope | Descripción |
| :--- | :--- | :--- |
| `platform_admin` | Global | Superadministrador de la plataforma SaaS (nosotros). Acceso total para soporte técnico. Acciones logueadas siempre. |
| `org_owner` | Organización | Dueño de una empresa administradora. Puede crear/eliminar cotos, usuarios admin, configurar facturación y marca blanca. |
| `org_admin` | Organización | Administrador de la empresa. Gestiona cotos asignados, no puede eliminar la organización ni cambiar billing. |
| `coto_admin` | Coto | Administrador operativo de un coto específico. Gestión financiera, comunicados, aprobación de tickets. |
| `coto_tesorero` | Coto | Solo lectura financiera + aprobación de egresos. No puede configurar cuotas ni eliminar datos. |
| `coto_comite` | Coto | Mesa directiva. Lectura de reportes financieros, votaciones. Sin edición operativa. |
| `residente_propietario` | Unidad | Propietario de lote/departamento. Paga cuotas, genera QR, vota en asambleas, reserva amenidades. |
| `residente_inquilino` | Unidad | Inquilino/arrendatario. Puede generar QR, reportar tickets y reservar amenidades. No vota. |
| `guardia` | Coto | Personal de caseta. Solo accede al módulo de control de accesos. Sin datos financieros. |
| `proveedor` | Coto | Proveedor de servicios (jardinería, limpieza). Solo ve sus órdenes de trabajo asignadas. |

#### Matriz de Permisos por Módulo

```
                        platform  org    org    coto   coto     coto    residente  residente
Módulo                  _admin    _owner _admin _admin _tesorero _comite _prop      _inquilino  guardia
─────────────────────── ───────── ────── ────── ────── ──────── ─────── ────────── ──────────── ───────
Org CRUD                 CRUD      CRUD   R      —      —        —       —          —            —
Cotos CRUD               CRUD      CRUD   CRUD   R      R        R       R          R            R
Unidades CRUD            CRUD      CRUD   CRUD   CRUD   R        R       R-own      R-own        —
Usuarios/Miembros        CRUD      CRUD   CRUD   CRUD   R        R       R-own      R-own        —
Cargos/Cuotas            CRUD      CRUD   CRUD   CRUD   R        R       R-own      —            —
Pagos                    CRUD      CRUD   CRUD   CRUD   R        R       CR-own     —            —
Auto-Pay Config          CRUD      CRUD   CRUD   CRUD   —        —       CRUD-own   —            —
Egresos                  CRUD      CRUD   CRUD   CRUD   CR       R       —          —            —
Facturación CFDI         CRUD      CRUD   CRUD   CRUD   R        R       R-own      —            —
Control de Accesos       CRUD      CRUD   CRUD   CRUD   —        —       CR-own     CR-own       CRUD
Amenidades               CRUD      CRUD   CRUD   CRUD   —        R       CR-own     CR-own       —
Comunicados              CRUD      CRUD   CRUD   CRUD   —        R       R          R            R
Tickets                  CRUD      CRUD   CRUD   CRUD   —        R       CR-own     CR-own       R
Votaciones               CRUD      CRUD   CRUD   CRUD   —        CR      CR-own     R            —
Reportes                 R         R      R      R      R        R       R-own      —            —
Audit Log                R         R      R      R      —        —       —          —            —
Configuración Global     CRUD      —      —      —      —        —       —          —            —

Leyenda: C=Create, R=Read, U=Update, D=Delete, own=solo sus registros, —=sin acceso
```

### 4.3 Implementación RLS Multi-Tenant

> [!IMPORTANT]
> **REGLA CRÍTICA:** Nunca usar `SET` para inyectar tenant context. Siempre usar `SET LOCAL` o `set_config(..., true)` dentro de una transacción para evitar fugas de contexto en connection pooling.

```sql
-- ═══════════════════════════════════════════════════════════
-- INFRAESTRUCTURA DE AISLAMIENTO MULTI-TENANT
-- ═══════════════════════════════════════════════════════════

-- 1. Rol de aplicación SIN privilegios de owner
CREATE ROLE app_service NOLOGIN;
COMMENT ON ROLE app_service IS 'Rol restringido para la app. No es owner de tablas. RLS se aplica.';

-- 2. Función helper para extraer tenant del JWT de Supabase
CREATE OR REPLACE FUNCTION current_org_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_coto_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_coto_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_user_role() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_user_role', true), '');
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- 3. Política RESTRICTIVE en tabla de cargos (ejemplo)
ALTER TABLE cargos ENABLE ROW LEVEL SECURITY;
ALTER TABLE cargos FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON cargos
  AS RESTRICTIVE
  FOR ALL
  USING (coto_id = current_coto_id())
  WITH CHECK (coto_id = current_coto_id());

-- Los residentes solo ven sus propios cargos
CREATE POLICY "residente_own_cargos" ON cargos
  AS PERMISSIVE
  FOR SELECT
  USING (
    current_user_role() IN ('coto_admin', 'coto_tesorero', 'coto_comite', 'org_owner', 'org_admin', 'platform_admin')
    OR (
      current_user_role() IN ('residente_propietario', 'residente_inquilino')
      AND unidad_id IN (
        SELECT unidad_id FROM miembros_coto
        WHERE usuario_id = auth.uid()
        AND coto_id = current_coto_id()
      )
    )
  );
```

### 4.4 Middleware de Seguridad (Pipeline de Request)

```typescript
// /middleware/security-pipeline.ts

export const securityPipeline = [
  // 1. Validar y parsear JWT (RS256)
  verifyJWT,
  
  // 2. Extraer tenant context del JWT claims
  extractTenantContext,  // org_id, coto_id, user_role
  
  // 3. Inyectar tenant en PostgreSQL (SET LOCAL)
  injectPostgresTenantContext,
  
  // 4. Validar permisos RBAC contra la ruta/acción
  enforceRBAC,
  
  // 5. Rate limiting por tenant (token bucket)
  rateLimitByTenant,  // 100 req/min por tenant, 1000 req/min org
  
  // 6. Sanitizar input (prevenir SQLi, XSS, path traversal)
  sanitizeInput,
  
  // 7. Validar schema del body (Zod)
  validateRequestSchema,
  
  // 8. Registrar en audit log (async, no bloquea)
  auditLogRequest,
];

// Inyección de contexto en cada transacción PostgreSQL
async function injectPostgresTenantContext(req, res, next) {
  const { orgId, cotoId, userId, role } = req.auth;
  
  // SIEMPRE usar set_config con is_local = true (3er parámetro)
  // Esto limita el scope a la transacción actual y previene
  // fugas de contexto en connection pooling (PgBouncer)
  await db.$executeRaw`
    SELECT 
      set_config('app.current_org_id', ${orgId}, true),
      set_config('app.current_coto_id', ${cotoId}, true),
      set_config('app.current_user_id', ${userId}, true),
      set_config('app.current_user_role', ${role}, true)
  `;
  
  next();
}
```

### 4.5 Audit Log Inmutable

Cada acción sensible genera un registro de auditoría que **nunca se elimina ni modifica**:

```sql
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    -- Contexto
    org_id          UUID NOT NULL,
    coto_id         UUID,
    usuario_id      UUID NOT NULL,
    usuario_email   TEXT NOT NULL,
    usuario_rol     VARCHAR(30) NOT NULL,
    -- Acción
    accion          VARCHAR(50) NOT NULL,  -- 'pago.crear', 'usuario.eliminar', etc.
    recurso_tipo    VARCHAR(50) NOT NULL,  -- 'cargo', 'pago', 'usuario', etc.
    recurso_id      UUID,
    -- Datos
    datos_antes     JSONB,  -- Estado previo (para updates/deletes)
    datos_despues   JSONB,  -- Estado nuevo (para creates/updates)
    metadata        JSONB,  -- IP, User-Agent, coordenadas GPS si aplica
    -- Inmutabilidad
    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    -- Hash de integridad (SHA-256 del registro anterior + este)
    hash_integridad VARCHAR(64) NOT NULL
);

-- Tabla append-only: nadie puede UPDATE ni DELETE
REVOKE UPDATE, DELETE ON audit_log FROM app_service;
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- Índices para consultas de auditoría
CREATE INDEX idx_audit_org ON audit_log(org_id, created_at DESC);
CREATE INDEX idx_audit_coto ON audit_log(coto_id, created_at DESC);
CREATE INDEX idx_audit_usuario ON audit_log(usuario_id, created_at DESC);
CREATE INDEX idx_audit_accion ON audit_log(accion, created_at DESC);
```

### 4.6 Encriptación y Manejo de Secretos

| Dato | En Tránsito | En Reposo | Acceso |
| :--- | :--- | :--- | :--- |
| Datos de tarjeta | TLS 1.3 → Conekta (nunca toca nuestros servidores) | Token opaco en nuestra DB | Solo sistema de pagos |
| CSD del SAT (.cer, .key) | TLS 1.3 | AES-256 en Vault (no en DB) | Solo worker de timbrado |
| Contraseñas de usuarios | Argon2id (hash, nunca reversible) | Hash en DB | Solo auth service |
| Datos personales (PII) | TLS 1.3 | AES-256 columnar en campos sensibles | Según RBAC + RLS |
| Tokens de API (Conekta, SAT, Meta) | — | Env vars en Vault | Solo workers autorizados |
| Registros de acceso (fotos, placas) | TLS 1.3 | AES-256 en Storage | Solo módulo de accesos |

---

## 5. Esquema de Base de Datos Completo

> [!NOTE]
> Esquema PostgreSQL 16 con extensiones: `uuid-ossp`, `pgcrypto`, `citext`. Todas las tablas con `coto_id` tienen RLS activo y forzado.

### 5.1 Diagrama ER Maestro

```mermaid
erDiagram
    %% === NÚCLEO ===
    organizaciones ||--o{ cotos : administra
    organizaciones ||--o{ org_miembros : tiene
    usuarios ||--o{ org_miembros : pertenece
    
    cotos ||--o{ sectores : subdivide
    cotos ||--o{ miembros_coto : tiene
    sectores ||--o{ unidades : agrupa
    
    usuarios ||--o{ miembros_coto : pertenece
    unidades ||--o{ miembros_coto : asigna
    
    %% === FINANZAS ===
    cotos ||--o{ conceptos_cargo : configura
    cotos ||--o{ cuentas_bancarias : posee
    unidades ||--o{ cargos : adeuda
    cargos ||--o{ detalle_pagos : liquida
    pagos ||--o{ detalle_pagos : contiene
    unidades ||--o{ pagos : realiza
    pagos ||--o| facturas_cfdi : timbra
    cotos ||--o{ egresos : registra
    egresos }o--|| proveedores : beneficia
    
    %% === AUTO-PAY ===
    unidades ||--o{ payment_methods : registra
    unidades ||--o| autopay_config : configura
    autopay_config ||--o{ autopay_intentos : genera
    
    %% === ACCESOS ===
    unidades ||--o{ invitaciones_acceso : emite
    invitaciones_acceso ||--o{ registros_acceso : valida
    cotos ||--o{ dispositivos_iot : instala
    
    %% === AMENIDADES ===
    cotos ||--o{ amenidades : ofrece
    amenidades ||--o{ reservaciones : agenda
    unidades ||--o{ reservaciones : solicita
    
    %% === COMUNICACIÓN ===
    cotos ||--o{ comunicados : publica
    unidades ||--o{ tickets : levanta
    cotos ||--o{ votaciones : convoca
    votaciones ||--o{ opciones_voto : define
    miembros_coto ||--o{ votos : emite
    
    %% === AUDITORÍA ===
    organizaciones ||--o{ audit_log : registra
```

### 5.2 DDL Completo por Dominio

#### A. Núcleo: Organizaciones, Cotos, Unidades, Usuarios

```sql
-- ═══════════════════════════════════════════════════════════
-- DOMINIO: NÚCLEO ORGANIZACIONAL
-- ═══════════════════════════════════════════════════════════

-- Organizaciones (empresas administradoras, despachos)
CREATE TABLE organizaciones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre          VARCHAR(200) NOT NULL,
    slug            VARCHAR(100) UNIQUE NOT NULL,  -- subdominio: "miraflores.admcotos.mx"
    rfc             VARCHAR(13),
    razon_social    VARCHAR(300),
    email_contacto  CITEXT NOT NULL,
    telefono        VARCHAR(20),
    -- Configuración de marca blanca
    logo_url        TEXT,
    color_primario  VARCHAR(7) DEFAULT '#1E40AF',
    color_secundario VARCHAR(7) DEFAULT '#3B82F6',
    -- Billing de la plataforma
    stripe_customer_id VARCHAR(100),
    plan             VARCHAR(30) DEFAULT 'basico' CHECK (plan IN ('basico','profesional','enterprise','white_label')),
    plan_max_cotos   INTEGER DEFAULT 5,
    plan_vence_en    DATE,
    -- Configuración de privacidad (LFPDPPP)
    aviso_privacidad_url TEXT,
    aviso_privacidad_version INTEGER DEFAULT 1,
    -- Timestamps
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Usuarios del sistema (identidad global, no depende de un coto)
CREATE TABLE usuarios (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Auth (Supabase Auth ID)
    auth_id         UUID UNIQUE NOT NULL,  -- FK a auth.users de Supabase
    -- Datos personales (PII - sujetos a LFPDPPP)
    nombre          VARCHAR(100) NOT NULL,
    apellido_paterno VARCHAR(100) NOT NULL,
    apellido_materno VARCHAR(100),
    email           CITEXT UNIQUE NOT NULL,
    telefono        VARCHAR(20),
    telefono_verificado BOOLEAN DEFAULT FALSE,
    -- Seguridad
    mfa_activo      BOOLEAN DEFAULT FALSE,
    ultimo_login    TIMESTAMPTZ,
    login_fallidos  SMALLINT DEFAULT 0,
    bloqueado_hasta TIMESTAMPTZ,
    -- Preferencias
    idioma          VARCHAR(5) DEFAULT 'es-MX',
    timezone        VARCHAR(50) DEFAULT 'America/Mexico_City',
    notif_push      BOOLEAN DEFAULT TRUE,
    notif_email     BOOLEAN DEFAULT TRUE,
    notif_whatsapp  BOOLEAN DEFAULT TRUE,
    -- Consentimiento LFPDPPP
    acepto_aviso_privacidad BOOLEAN DEFAULT FALSE,
    fecha_aceptacion_aviso  TIMESTAMPTZ,
    version_aviso_aceptado  INTEGER,
    -- Timestamps
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Membresía de usuarios en organizaciones
CREATE TABLE org_miembros (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
    usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    rol             VARCHAR(20) NOT NULL CHECK (rol IN ('org_owner','org_admin')),
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, usuario_id)
);

-- Cotos / Condominios / Fraccionamientos
CREATE TABLE cotos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizaciones(id) ON DELETE RESTRICT,
    nombre          VARCHAR(200) NOT NULL,
    slug            VARCHAR(100) NOT NULL,
    -- Ubicación
    direccion       TEXT,
    colonia         VARCHAR(200),
    ciudad          VARCHAR(100),
    estado          VARCHAR(100),
    cp              VARCHAR(5),
    latitud         DECIMAL(10, 8),
    longitud        DECIMAL(11, 8),
    -- Configuración legal
    tipo            VARCHAR(30) DEFAULT 'coto' CHECK (tipo IN ('coto','condominio_vertical','condominio_horizontal','mixto','parque_industrial','plaza_comercial')),
    regimen_legal   VARCHAR(50),  -- "Asociación Civil", "Condominio", etc.
    fecha_constitucion DATE,
    num_escritura   VARCHAR(50),
    -- Configuración financiera
    moneda          CHAR(3) DEFAULT 'MXN',
    dia_corte       SMALLINT DEFAULT 1 CHECK (dia_corte BETWEEN 1 AND 28),
    dia_limite_pago SMALLINT DEFAULT 10 CHECK (dia_limite_pago BETWEEN 1 AND 28),
    tasa_moratoria  DECIMAL(5,2) DEFAULT 0,  -- % mensual
    monto_moratoria_fijo DECIMAL(12,2) DEFAULT 0,  -- Monto fijo alternativo
    tipo_moratoria  VARCHAR(10) DEFAULT 'ninguno' CHECK (tipo_moratoria IN ('ninguno','porcentaje','fijo')),
    descuento_pronto_pago DECIMAL(5,2) DEFAULT 0,
    dias_gracia     SMALLINT DEFAULT 0,
    -- Configuración de accesos
    requiere_qr_visitas BOOLEAN DEFAULT TRUE,
    permite_acceso_frecuente BOOLEAN DEFAULT TRUE,
    bloquear_acceso_morosos BOOLEAN DEFAULT FALSE,
    -- Configuración de amenidades
    bloquear_amenidades_morosos BOOLEAN DEFAULT TRUE,
    meses_morosidad_bloqueo SMALLINT DEFAULT 2,
    -- Datos fiscales del coto (para facturación)
    rfc_coto        VARCHAR(13),
    razon_social_coto VARCHAR(300),
    regimen_fiscal  VARCHAR(5),  -- Código SAT
    cp_fiscal       VARCHAR(5),
    csd_cert_encrypted BYTEA,  -- Certificado .cer (encriptado AES-256)
    csd_key_encrypted  BYTEA,  -- Llave .key (encriptada AES-256)
    csd_password_encrypted BYTEA,
    -- Estado
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, slug)
);

-- Sectores / Torres / Privadas / Edificios
CREATE TABLE sectores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    nombre          VARCHAR(100) NOT NULL,  -- "Torre A", "Privada Norte", "Edificio 3"
    tipo            VARCHAR(30) DEFAULT 'seccion' CHECK (tipo IN ('torre','privada','edificio','seccion','manzana','bloque')),
    orden           SMALLINT DEFAULT 0,
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(coto_id, nombre)
);

-- Unidades (casas, departamentos, locales, bodegas)
CREATE TABLE unidades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    sector_id       UUID REFERENCES sectores(id) ON DELETE SET NULL,
    numero          VARCHAR(20) NOT NULL,  -- "101", "Casa 23", "Local B-5"
    tipo            VARCHAR(30) DEFAULT 'casa' CHECK (tipo IN ('casa','departamento','local','bodega','oficina','terreno')),
    -- Datos de propiedad
    superficie_m2   DECIMAL(10,2),
    indiviso        DECIMAL(8,6),  -- Porcentaje de indiviso (ej. 0.034500 = 3.45%)
    -- Estado de cuenta
    saldo_a_favor   DECIMAL(12,2) DEFAULT 0,
    -- Estado
    ocupada         BOOLEAN DEFAULT TRUE,
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(coto_id, numero)
);

-- Membresía de usuarios en cotos (vincula usuario ↔ unidad ↔ coto)
CREATE TABLE miembros_coto (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    unidad_id       UUID REFERENCES unidades(id) ON DELETE SET NULL,  -- NULL para guardias/proveedores
    usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    rol             VARCHAR(30) NOT NULL CHECK (rol IN (
        'coto_admin','coto_tesorero','coto_comite',
        'residente_propietario','residente_inquilino',
        'guardia','proveedor'
    )),
    -- Contacto de emergencia
    contacto_emergencia_nombre VARCHAR(200),
    contacto_emergencia_tel VARCHAR(20),
    -- Vehículos registrados
    vehiculos       JSONB DEFAULT '[]',  -- [{placa, marca, modelo, color, tag_rfid}]
    -- Estado
    activo          BOOLEAN DEFAULT TRUE,
    fecha_ingreso   DATE DEFAULT CURRENT_DATE,
    fecha_baja      DATE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(coto_id, usuario_id, rol)
);
```

#### B. Finanzas: Cargos, Pagos, Egresos

```sql
-- ═══════════════════════════════════════════════════════════
-- DOMINIO: FINANZAS Y CONTABILIDAD CONDOMINAL
-- ═══════════════════════════════════════════════════════════

-- Catálogo de conceptos de cargo
CREATE TABLE conceptos_cargo (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    nombre          VARCHAR(100) NOT NULL,  -- "Mantenimiento", "Agua", "Seguro"
    tipo            VARCHAR(20) NOT NULL CHECK (tipo IN ('ordinario','extraordinario','multa','cuota_especial','reserva')),
    monto_default   DECIMAL(12,2),
    usa_indiviso    BOOLEAN DEFAULT FALSE,  -- Si TRUE, calcula monto basado en indiviso de la unidad
    es_recurrente   BOOLEAN DEFAULT TRUE,
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(coto_id, nombre)
);

-- Cargos a unidades (adeudos)
CREATE TABLE cargos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id),
    concepto_id     UUID NOT NULL REFERENCES conceptos_cargo(id),
    -- Montos
    periodo         VARCHAR(7) NOT NULL,  -- "2026-11" (año-mes)
    monto_original  DECIMAL(12,2) NOT NULL,
    monto_moratoria DECIMAL(12,2) DEFAULT 0,
    monto_descuento DECIMAL(12,2) DEFAULT 0,
    saldo_pendiente DECIMAL(12,2) NOT NULL,  -- Lo que falta por pagar
    -- Estado
    estado          VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','parcial','pagado','condonado','cancelado')),
    fecha_emision   DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_vencimiento DATE NOT NULL,
    -- Auditoría
    generado_por    UUID REFERENCES usuarios(id),  -- NULL = sistema automático
    notas           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_cargos_coto_periodo ON cargos(coto_id, periodo);
CREATE INDEX idx_cargos_unidad_estado ON cargos(unidad_id, estado);

-- Pagos recibidos
CREATE TABLE pagos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id),
    -- Monto y método
    monto           DECIMAL(12,2) NOT NULL,
    metodo          VARCHAR(30) NOT NULL CHECK (metodo IN (
        'tarjeta','spei','oxxo','efectivo','cheque','transferencia_manual','autopay_tarjeta','autopay_clabe','condonacion'
    )),
    -- Referencia de pasarela
    gateway         VARCHAR(20),  -- 'conekta', 'stripe', 'manual'
    gateway_order_id VARCHAR(100),
    gateway_charge_id VARCHAR(100),
    -- Comprobante
    comprobante_url TEXT,  -- URL en Storage (foto/PDF del voucher)
    referencia_bancaria VARCHAR(50),
    -- Estado
    estado          VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','confirmado','rechazado','reembolsado','en_revision')),
    -- Auditoría
    registrado_por  UUID REFERENCES usuarios(id),  -- NULL = sistema/webhook
    confirmado_por  UUID REFERENCES usuarios(id),
    fecha_pago      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_confirmacion TIMESTAMPTZ,
    notas           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Detalle de aplicación de pagos (N pagos pueden liquidar N cargos)
CREATE TABLE detalle_pagos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pago_id         UUID NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
    cargo_id        UUID NOT NULL REFERENCES cargos(id),
    monto_aplicado  DECIMAL(12,2) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pago_id, cargo_id)
);

-- Cuentas bancarias del coto
CREATE TABLE cuentas_bancarias (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    banco           VARCHAR(100) NOT NULL,
    titular         VARCHAR(200),
    clabe           VARCHAR(18),
    numero_cuenta   VARCHAR(20),
    tipo            VARCHAR(30) DEFAULT 'operativa' CHECK (tipo IN ('operativa','reserva','mejoras','inversion')),
    saldo_registrado DECIMAL(14,2) DEFAULT 0,
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Proveedores
CREATE TABLE proveedores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    nombre          VARCHAR(200) NOT NULL,
    rfc             VARCHAR(13),
    telefono        VARCHAR(20),
    email           CITEXT,
    categoria       VARCHAR(50),  -- "Jardinería", "Seguridad", "Limpieza", etc.
    clabe           VARCHAR(18),
    activo          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Egresos (gastos del coto)
CREATE TABLE egresos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    cuenta_bancaria_id UUID REFERENCES cuentas_bancarias(id),
    proveedor_id    UUID REFERENCES proveedores(id),
    -- Datos
    concepto        VARCHAR(200) NOT NULL,
    categoria       VARCHAR(50),
    monto           DECIMAL(12,2) NOT NULL,
    fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Comprobante fiscal
    tiene_factura   BOOLEAN DEFAULT FALSE,
    factura_uuid    VARCHAR(36),  -- UUID del CFDI del proveedor
    comprobante_url TEXT,
    -- Aprobación
    estado          VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobado','rechazado','pagado')),
    solicitado_por  UUID REFERENCES usuarios(id),
    aprobado_por    UUID REFERENCES usuarios(id),
    fecha_aprobacion TIMESTAMPTZ,
    notas           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

#### C. Auto-Pay y Payment Methods

```sql
-- ═══════════════════════════════════════════════════════════
-- DOMINIO: AUTO-PAY Y MÉTODOS DE PAGO TOKENIZADOS
-- ═══════════════════════════════════════════════════════════

CREATE TABLE payment_methods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id),
    usuario_id      UUID NOT NULL REFERENCES usuarios(id),
    tipo            VARCHAR(20) NOT NULL CHECK (tipo IN ('card','clabe','spei_mandate')),
    -- NUNCA almacenamos datos raw de tarjeta. Solo tokens de la pasarela:
    gateway         VARCHAR(20) NOT NULL DEFAULT 'conekta',
    gateway_customer_id VARCHAR(100) NOT NULL,
    gateway_source_id   VARCHAR(100),
    -- Datos seguros para display
    label           VARCHAR(100),  -- "VISA ****4523" o "CLABE ****7890"
    ultimos_4       CHAR(4),
    marca_tarjeta   VARCHAR(20),  -- 'visa', 'mastercard', 'amex'
    fecha_expiracion VARCHAR(7),   -- "MM/YYYY"
    banco_emisor    VARCHAR(100),
    -- Estado
    es_default      BOOLEAN DEFAULT FALSE,
    activo          BOOLEAN DEFAULT TRUE,
    -- Auditoría
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE autopay_config (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id) UNIQUE,
    payment_method_id UUID REFERENCES payment_methods(id),
    -- Configuración
    activo          BOOLEAN DEFAULT FALSE,
    dia_cobro       SMALLINT DEFAULT 5 CHECK (dia_cobro BETWEEN 1 AND 28),
    -- Política de reintentos
    max_reintentos  SMALLINT DEFAULT 3,
    dias_entre_reintentos SMALLINT[] DEFAULT '{3,7,14}',
    -- Estado operativo
    intentos_fallidos_consecutivos SMALLINT DEFAULT 0,
    ultimo_cobro_exitoso DATE,
    proximo_cobro   DATE,
    estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','pausado','suspendido_por_fallos','cancelado_por_usuario')),
    razon_suspension TEXT,
    -- Auditoría
    activado_por    UUID REFERENCES usuarios(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE autopay_intentos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    autopay_id      UUID NOT NULL REFERENCES autopay_config(id),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    cargo_id        UUID REFERENCES cargos(id),
    pago_id         UUID REFERENCES pagos(id),  -- NULL si falló
    -- Intento
    intento_num     SMALLINT NOT NULL,
    monto_centavos  INTEGER NOT NULL,
    -- Gateway
    gateway         VARCHAR(20) NOT NULL,
    gateway_order_id VARCHAR(100),
    -- Resultado
    estado          VARCHAR(20) CHECK (estado IN ('pendiente','exitoso','fallido','reembolsado')),
    codigo_error    VARCHAR(50),
    mensaje_error   TEXT,
    -- Timing
    programado_para TIMESTAMPTZ NOT NULL,
    ejecutado_en    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_autopay_intentos_programado ON autopay_intentos(programado_para, estado);
```

#### D. Facturación CFDI

```sql
-- ═══════════════════════════════════════════════════════════
-- DOMINIO: FACTURACIÓN ELECTRÓNICA SAT (CFDI 4.0)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE facturas_cfdi (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    pago_id         UUID REFERENCES pagos(id),
    -- Datos del CFDI
    uuid_cfdi       VARCHAR(36) UNIQUE,  -- UUID asignado por el SAT/PAC
    serie           VARCHAR(10),
    folio           VARCHAR(20),
    tipo_comprobante CHAR(1) DEFAULT 'I' CHECK (tipo_comprobante IN ('I','P','E','N')),
    -- Emisor
    emisor_rfc      VARCHAR(13) NOT NULL,
    emisor_nombre   VARCHAR(300) NOT NULL,
    emisor_regimen  VARCHAR(5) NOT NULL,
    -- Receptor
    receptor_rfc    VARCHAR(13) NOT NULL,
    receptor_nombre VARCHAR(300) NOT NULL,
    receptor_regimen VARCHAR(5),
    receptor_cp     VARCHAR(5),
    receptor_uso_cfdi VARCHAR(5) DEFAULT 'G03',
    -- Montos
    subtotal        DECIMAL(12,2) NOT NULL,
    total           DECIMAL(12,2) NOT NULL,
    moneda          CHAR(3) DEFAULT 'MXN',
    metodo_pago     VARCHAR(3),  -- 'PUE' o 'PPD'
    forma_pago      VARCHAR(2),  -- '01'=Efectivo, '03'=Transferencia, '04'=Tarjeta, etc.
    -- Archivos
    xml_url         TEXT,  -- URL firmada en Storage
    pdf_url         TEXT,
    -- Estado
    estado          VARCHAR(20) DEFAULT 'timbrado' CHECK (estado IN ('pendiente','timbrado','cancelado','error')),
    pac_utilizado   VARCHAR(50),  -- Nombre del PAC
    -- Cancelación
    cancelado_en    TIMESTAMPTZ,
    motivo_cancelacion VARCHAR(5),
    -- Auditoría
    generado_por    UUID REFERENCES usuarios(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_cfdi_coto_periodo ON facturas_cfdi(coto_id, created_at DESC);

-- Paquetes de timbres comprados
CREATE TABLE paquetes_timbres (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizaciones(id),
    cantidad        INTEGER NOT NULL,
    usados          INTEGER DEFAULT 0,
    precio_unitario DECIMAL(6,2) NOT NULL,
    total_pagado    DECIMAL(10,2) NOT NULL,
    gateway_order_id VARCHAR(100),
    estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','agotado','cancelado')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

#### E. Control de Accesos

```sql
-- ═══════════════════════════════════════════════════════════
-- DOMINIO: CONTROL DE ACCESOS Y SEGURIDAD PERIMETRAL
-- ═══════════════════════════════════════════════════════════

CREATE TABLE invitaciones_acceso (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id),
    creado_por      UUID NOT NULL REFERENCES usuarios(id),
    -- Datos del invitado
    nombre_invitado VARCHAR(200) NOT NULL,
    tipo            VARCHAR(30) NOT NULL CHECK (tipo IN ('unico','temporal','frecuente','evento','proveedor','paqueteria')),
    -- Código de acceso
    codigo_qr       VARCHAR(64) UNIQUE NOT NULL,  -- Hash único para el QR
    codigo_numerico VARCHAR(6),  -- Código corto alternativo (para dictar por teléfono)
    -- Vigencia
    valido_desde    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valido_hasta    TIMESTAMPTZ,  -- NULL = sin expiración para frecuentes
    dias_permitidos SMALLINT[],  -- {1,2,3,4,5} = Lun-Vie (NULL = todos)
    hora_inicio     TIME,
    hora_fin        TIME,
    max_usos        INTEGER DEFAULT 1,  -- NULL = ilimitado
    usos_actuales   INTEGER DEFAULT 0,
    -- Vehículo (opcional)
    placa_vehiculo  VARCHAR(15),
    -- Estado
    estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','usado','expirado','revocado')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_invitaciones_qr ON invitaciones_acceso(codigo_qr);
CREATE INDEX idx_invitaciones_coto ON invitaciones_acceso(coto_id, estado, valido_hasta);

-- Registro de entradas/salidas en caseta
CREATE TABLE registros_acceso (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    invitacion_id   UUID REFERENCES invitaciones_acceso(id),
    -- Quién
    tipo_persona    VARCHAR(20) NOT NULL CHECK (tipo_persona IN ('residente','visitante','proveedor','paqueteria','emergencia','desconocido')),
    nombre          VARCHAR(200),
    unidad_destino  UUID REFERENCES unidades(id),
    -- Vehículo
    placa           VARCHAR(15),
    -- Método de validación
    metodo_validacion VARCHAR(20) CHECK (metodo_validacion IN ('qr','codigo_numerico','rfid','lpr','manual','biometrico')),
    -- Resultado
    tipo_movimiento VARCHAR(10) NOT NULL CHECK (tipo_movimiento IN ('entrada','salida')),
    autorizado      BOOLEAN NOT NULL,
    motivo_rechazo  TEXT,
    -- Evidencia
    foto_url        TEXT,  -- Foto del visitante/vehículo (encriptada)
    -- Guardia que registró
    guardia_id      UUID REFERENCES usuarios(id),
    dispositivo_id  UUID REFERENCES dispositivos_iot(id),
    -- Timing
    fecha_hora      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notas           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_registros_coto_fecha ON registros_acceso(coto_id, fecha_hora DESC);

-- Dispositivos IoT instalados en el coto
CREATE TABLE dispositivos_iot (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    nombre          VARCHAR(100) NOT NULL,  -- "Pluma Principal", "Cámara LPR Acceso 2"
    tipo            VARCHAR(30) NOT NULL CHECK (tipo IN ('lector_qr','antena_rfid','camara_lpr','pluma_vehicular','control_peatonal','intercom')),
    -- Conexión
    mac_address     VARCHAR(17),
    ip_local        VARCHAR(45),
    protocolo       VARCHAR(20) CHECK (protocolo IN ('mqtt','http','websocket','modbus','wiegand')),
    endpoint_url    TEXT,
    api_key_encrypted BYTEA,  -- Encriptado AES-256
    -- Estado
    estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','offline','mantenimiento','desactivado')),
    ultimo_heartbeat TIMESTAMPTZ,
    firmware_version VARCHAR(20),
    -- Configuración
    config          JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

#### F. Amenidades, Comunicación, Gobernanza, Tickets

```sql
-- ═══════════════════════════════════════════════════════════
-- DOMINIO: AMENIDADES
-- ═══════════════════════════════════════════════════════════

CREATE TABLE amenidades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id) ON DELETE CASCADE,
    nombre          VARCHAR(100) NOT NULL,
    descripcion     TEXT,
    tipo            VARCHAR(30) CHECK (tipo IN ('alberca','palapa','salon_eventos','cancha_padel','cancha_tenis','gimnasio','asador','jardin','otro')),
    capacidad_max   INTEGER,
    -- Reglas
    requiere_deposito BOOLEAN DEFAULT FALSE,
    monto_deposito  DECIMAL(10,2) DEFAULT 0,
    monto_uso       DECIMAL(10,2) DEFAULT 0,
    duracion_slot_min INTEGER DEFAULT 120,  -- Duración de cada slot en minutos
    max_reservas_por_unidad_mes INTEGER DEFAULT 2,
    intervalo_limpieza_min INTEGER DEFAULT 60,
    horario_inicio  TIME DEFAULT '08:00',
    horario_fin     TIME DEFAULT '22:00',
    dias_disponibles SMALLINT[] DEFAULT '{0,1,2,3,4,5,6}',
    requiere_estar_al_corriente BOOLEAN DEFAULT TRUE,
    -- Estado
    activo          BOOLEAN DEFAULT TRUE,
    foto_url        TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reservaciones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    amenidad_id     UUID NOT NULL REFERENCES amenidades(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id),
    usuario_id      UUID NOT NULL REFERENCES usuarios(id),
    -- Horario
    fecha           DATE NOT NULL,
    hora_inicio     TIME NOT NULL,
    hora_fin        TIME NOT NULL,
    num_invitados   INTEGER DEFAULT 0,
    -- Depósito
    deposito_pagado BOOLEAN DEFAULT FALSE,
    deposito_devuelto BOOLEAN DEFAULT FALSE,
    -- Estado
    estado          VARCHAR(20) DEFAULT 'confirmada' CHECK (estado IN ('pendiente','confirmada','cancelada','completada','no_show')),
    notas           TEXT,
    cancelada_por   UUID REFERENCES usuarios(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_reservaciones_amenidad_fecha ON reservaciones(amenidad_id, fecha, hora_inicio);

-- ═══════════════════════════════════════════════════════════
-- DOMINIO: COMUNICACIÓN
-- ═══════════════════════════════════════════════════════════

CREATE TABLE comunicados (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    -- Contenido
    titulo          VARCHAR(200) NOT NULL,
    cuerpo          TEXT NOT NULL,
    tipo            VARCHAR(30) DEFAULT 'aviso' CHECK (tipo IN ('aviso','urgente','mantenimiento','evento','reglamento','asamblea','financiero')),
    prioridad       VARCHAR(10) DEFAULT 'normal' CHECK (prioridad IN ('baja','normal','alta','urgente')),
    -- Segmentación
    dirigido_a      VARCHAR(30) DEFAULT 'todos' CHECK (dirigido_a IN ('todos','propietarios','inquilinos','morosos','sector','unidades_especificas')),
    sector_id       UUID REFERENCES sectores(id),
    unidades_ids    UUID[],  -- Para envío selectivo
    -- Canales de envío
    enviar_push     BOOLEAN DEFAULT TRUE,
    enviar_email    BOOLEAN DEFAULT TRUE,
    enviar_whatsapp BOOLEAN DEFAULT FALSE,
    -- Adjuntos
    archivos_urls   TEXT[],
    -- Estado
    publicado       BOOLEAN DEFAULT FALSE,
    fecha_publicacion TIMESTAMPTZ,
    publicado_por   UUID REFERENCES usuarios(id),
    -- Métricas
    total_destinatarios INTEGER DEFAULT 0,
    total_leidos    INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE comunicados_lectura (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comunicado_id   UUID NOT NULL REFERENCES comunicados(id) ON DELETE CASCADE,
    usuario_id      UUID NOT NULL REFERENCES usuarios(id),
    leido_en        TIMESTAMPTZ DEFAULT NOW(),
    canal           VARCHAR(20),  -- 'app', 'email', 'whatsapp'
    UNIQUE(comunicado_id, usuario_id)
);

-- ═══════════════════════════════════════════════════════════
-- DOMINIO: TICKETS / QUEJAS / SUGERENCIAS
-- ═══════════════════════════════════════════════════════════

CREATE TABLE tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    unidad_id       UUID REFERENCES unidades(id),
    -- Ticket
    numero          SERIAL,
    titulo          VARCHAR(200) NOT NULL,
    descripcion     TEXT NOT NULL,
    categoria       VARCHAR(30) CHECK (categoria IN ('mantenimiento','ruido','mascotas','estacionamiento','seguridad','limpieza','jardineria','otro')),
    prioridad       VARCHAR(10) DEFAULT 'normal' CHECK (prioridad IN ('baja','normal','alta','urgente')),
    -- Adjuntos
    fotos_urls      TEXT[],
    -- Estado y asignación
    estado          VARCHAR(20) DEFAULT 'abierto' CHECK (estado IN ('abierto','en_proceso','esperando_residente','resuelto','cerrado','cancelado')),
    asignado_a      UUID REFERENCES usuarios(id),
    -- Timing
    reportado_por   UUID NOT NULL REFERENCES usuarios(id),
    fecha_reporte   TIMESTAMPTZ DEFAULT NOW(),
    fecha_resolucion TIMESTAMPTZ,
    -- SLA
    sla_horas       INTEGER DEFAULT 72,
    sla_vencido     BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ticket_comentarios (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    usuario_id      UUID NOT NULL REFERENCES usuarios(id),
    comentario      TEXT NOT NULL,
    es_interno      BOOLEAN DEFAULT FALSE,  -- Solo visible para admins
    fotos_urls      TEXT[],
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- DOMINIO: GOBERNANZA Y VOTACIONES
-- ═══════════════════════════════════════════════════════════

CREATE TABLE votaciones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    titulo          VARCHAR(200) NOT NULL,
    descripcion     TEXT,
    tipo            VARCHAR(20) DEFAULT 'encuesta' CHECK (tipo IN ('encuesta','asamblea','referendum')),
    -- Configuración
    voto_ponderado_por_indiviso BOOLEAN DEFAULT FALSE,
    permite_voto_delegado BOOLEAN DEFAULT FALSE,
    requiere_quorum BOOLEAN DEFAULT FALSE,
    porcentaje_quorum DECIMAL(5,2) DEFAULT 50.00,
    solo_propietarios BOOLEAN DEFAULT TRUE,
    -- Vigencia
    fecha_inicio    TIMESTAMPTZ NOT NULL,
    fecha_fin       TIMESTAMPTZ NOT NULL,
    -- Estado
    estado          VARCHAR(20) DEFAULT 'borrador' CHECK (estado IN ('borrador','activa','cerrada','cancelada')),
    resultado       JSONB,  -- Resultados finales calculados
    creado_por      UUID NOT NULL REFERENCES usuarios(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE opciones_voto (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    votacion_id     UUID NOT NULL REFERENCES votaciones(id) ON DELETE CASCADE,
    texto           VARCHAR(300) NOT NULL,
    orden           SMALLINT DEFAULT 0,
    votos_count     INTEGER DEFAULT 0,
    votos_peso      DECIMAL(10,6) DEFAULT 0  -- Suma de indivisos si es ponderado
);

CREATE TABLE votos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    votacion_id     UUID NOT NULL REFERENCES votaciones(id),
    coto_id         UUID NOT NULL REFERENCES cotos(id),
    opcion_id       UUID NOT NULL REFERENCES opciones_voto(id),
    -- Votante
    miembro_id      UUID NOT NULL REFERENCES miembros_coto(id),
    unidad_id       UUID NOT NULL REFERENCES unidades(id),
    peso_voto       DECIMAL(10,6) DEFAULT 1,  -- Indiviso de la unidad si es ponderado
    -- Inmutabilidad (el voto emitido no se modifica)
    emitido_en      TIMESTAMPTZ DEFAULT NOW(),
    ip_origen       INET,
    UNIQUE(votacion_id, miembro_id)  -- Un solo voto por miembro por votación
);
```

### 5.3 Habilitar RLS en Todas las Tablas con `coto_id`

```sql
-- Script de activación masiva de RLS
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOR tbl IN 
        SELECT table_name FROM information_schema.columns 
        WHERE column_name = 'coto_id' 
        AND table_schema = 'public'
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%I ON %I AS RESTRICTIVE FOR ALL 
             USING (coto_id = current_coto_id()) 
             WITH CHECK (coto_id = current_coto_id())',
            tbl, tbl
        );
        RAISE NOTICE 'RLS enabled on: %', tbl;
    END LOOP;
END $$;
```

---

## 6. Módulos del Sistema y API Endpoints

### 6.1 Mapa Completo de Módulos y Rutas

> [!TIP]
> Todas las rutas requieren autenticación JWT excepto las marcadas con 🔓. Rate limits indicados por ruta.

#### M1: Autenticación y Usuarios (`/api/v1/auth`)

| Método | Ruta | Auth | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/auth/register` | 🔓 | Registro con email + password (invitación requerida) |
| POST | `/auth/login` | 🔓 | Login email/password → JWT |
| POST | `/auth/login/otp` | 🔓 | Login con OTP SMS/WhatsApp |
| POST | `/auth/mfa/setup` | ✅ | Configurar TOTP para MFA |
| POST | `/auth/mfa/verify` | ✅ | Verificar código MFA |
| POST | `/auth/refresh` | ✅ | Renovar access token |
| POST | `/auth/logout` | ✅ | Invalidar sesión |
| POST | `/auth/forgot-password` | 🔓 | Enviar link de reset |
| POST | `/auth/reset-password` | 🔓 | Resetear contraseña con token |
| GET | `/auth/me` | ✅ | Perfil del usuario actual |
| PATCH | `/auth/me` | ✅ | Actualizar perfil |
| DELETE | `/auth/me` | ✅ | Solicitud de eliminación de cuenta (ARCO) |

#### M2: Organizaciones (`/api/v1/orgs`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/orgs` | platform_admin | Crear organización |
| GET | `/orgs` | platform_admin | Listar organizaciones |
| GET | `/orgs/:id` | org_owner | Detalle de organización |
| PATCH | `/orgs/:id` | org_owner | Actualizar organización |
| POST | `/orgs/:id/members` | org_owner | Invitar miembro admin |
| DELETE | `/orgs/:id/members/:uid` | org_owner | Remover miembro |
| GET | `/orgs/:id/billing` | org_owner | Estado de suscripción |
| POST | `/orgs/:id/billing/portal` | org_owner | URL portal de pago Stripe |

#### M3: Cotos (`/api/v1/cotos`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/cotos` | org_admin | Crear coto |
| GET | `/cotos` | org_admin | Listar cotos de mi org |
| GET | `/cotos/:id` | coto_comite | Detalle de coto |
| PATCH | `/cotos/:id` | coto_admin | Actualizar configuración |
| GET | `/cotos/:id/dashboard` | coto_comite | Dashboard con KPIs |
| POST | `/cotos/:id/sectores` | coto_admin | Crear sector/torre |
| POST | `/cotos/:id/unidades` | coto_admin | Crear unidad |
| POST | `/cotos/:id/unidades/import` | coto_admin | Importar unidades (CSV) |
| GET | `/cotos/:id/unidades` | coto_comite | Listar unidades |
| POST | `/cotos/:id/miembros` | coto_admin | Agregar miembro |
| POST | `/cotos/:id/miembros/invite` | coto_admin | Invitar por email/WhatsApp |
| GET | `/cotos/:id/miembros` | coto_admin | Listar miembros |
| PATCH | `/cotos/:id/miembros/:mid` | coto_admin | Actualizar rol/datos |
| DELETE | `/cotos/:id/miembros/:mid` | coto_admin | Dar de baja miembro |

#### M4: Finanzas (`/api/v1/cotos/:cotoId/finanzas`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| **Cargos** | | | |
| POST | `/cargos/generar-masivo` | coto_admin | Generar cargos del mes para todas las unidades |
| POST | `/cargos` | coto_admin | Crear cargo individual |
| GET | `/cargos` | coto_tesorero | Listar cargos (filtros: periodo, estado, unidad) |
| GET | `/cargos/resumen` | coto_comite | Resumen de morosidad (% cobrado, pendiente) |
| PATCH | `/cargos/:id/condonar` | coto_admin | Condonar cargo |
| **Pagos** | | | |
| POST | `/pagos` | coto_admin | Registrar pago manual |
| POST | `/pagos/online` | residente | Iniciar pago en línea (Conekta checkout) |
| POST | `/pagos/comprobante` | residente | Subir comprobante de transferencia |
| GET | `/pagos` | coto_tesorero | Listar pagos |
| PATCH | `/pagos/:id/confirmar` | coto_admin | Confirmar pago pendiente |
| PATCH | `/pagos/:id/rechazar` | coto_admin | Rechazar pago |
| **Egresos** | | | |
| POST | `/egresos` | coto_admin | Registrar egreso |
| GET | `/egresos` | coto_tesorero | Listar egresos |
| PATCH | `/egresos/:id/aprobar` | coto_tesorero | Aprobar egreso |
| **Reportes** | | | |
| GET | `/reportes/estado-cuenta/:unidadId` | residente (own) | Estado de cuenta individual |
| GET | `/reportes/balance-mensual` | coto_comite | Balance ingresos vs egresos |
| GET | `/reportes/morosidad` | coto_tesorero | Reporte de morosos |
| GET | `/reportes/presupuesto-vs-real` | coto_comite | Comparativo presupuestal |
| GET | `/reportes/pdf/:tipo` | coto_comite | Descargar reporte en PDF |

#### M5: Auto-Pay (`/api/v1/cotos/:cotoId/autopay`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/payment-methods` | residente | Registrar método de pago (tokenizado) |
| GET | `/payment-methods` | residente (own) | Listar mis métodos |
| DELETE | `/payment-methods/:id` | residente (own) | Eliminar método |
| POST | `/activate` | residente | Activar auto-pay |
| GET | `/status` | residente (own) | Estado de mi auto-pay |
| PATCH | `/config` | residente (own) | Cambiar día de cobro |
| POST | `/pause` | residente (own) | Pausar auto-pay |
| POST | `/resume` | residente (own) | Reanudar auto-pay |
| DELETE | `/cancel` | residente (own) | Cancelar auto-pay |
| GET | `/history` | residente (own) | Historial de cobros |
| GET | `/admin/dashboard` | coto_admin | Dashboard auto-pay del coto |

#### M6: Facturación CFDI (`/api/v1/cotos/:cotoId/facturacion`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/config/csd` | coto_admin | Cargar CSD (encriptado) |
| POST | `/timbrar/:pagoId` | coto_admin | Timbrar CFDI para un pago |
| POST | `/timbrar-masivo` | coto_admin | Timbrar lote de pagos |
| GET | `/facturas` | coto_admin | Listar facturas emitidas |
| GET | `/facturas/:id/xml` | residente (own) | Descargar XML |
| GET | `/facturas/:id/pdf` | residente (own) | Descargar PDF |
| POST | `/facturas/:id/cancelar` | coto_admin | Cancelar CFDI ante el SAT |
| POST | `/complemento-pago` | coto_admin | Emitir complemento de pago |

#### M7: Control de Accesos (`/api/v1/cotos/:cotoId/accesos`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/invitaciones` | residente | Generar invitación QR |
| GET | `/invitaciones` | residente (own) | Mis invitaciones activas |
| DELETE | `/invitaciones/:id` | residente (own) | Revocar invitación |
| POST | `/validar` | guardia | Validar código QR/numérico |
| POST | `/registro-manual` | guardia | Registrar entrada manual |
| POST | `/registro-salida` | guardia | Registrar salida |
| GET | `/bitacora` | coto_admin | Bitácora de entradas/salidas |
| POST | `/iot/evento` | 🔓 (API key) | Webhook desde dispositivo IoT |
| GET | `/dispositivos` | coto_admin | Listar dispositivos IoT |
| POST | `/dispositivos` | coto_admin | Registrar dispositivo IoT |

#### M8: Amenidades (`/api/v1/cotos/:cotoId/amenidades`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| GET | `/` | residente | Listar amenidades |
| POST | `/:id/reservar` | residente | Crear reservación |
| GET | `/:id/disponibilidad` | residente | Slots disponibles |
| GET | `/mis-reservaciones` | residente (own) | Mis reservaciones |
| DELETE | `/reservaciones/:id` | residente (own) | Cancelar reservación |

#### M9: Comunicación (`/api/v1/cotos/:cotoId/comunicados`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/` | coto_admin | Crear comunicado |
| POST | `/ai-redactar` | coto_admin | Redactar con IA |
| GET | `/` | residente | Listar comunicados |
| POST | `/:id/leido` | residente | Marcar como leído |

#### M10: Tickets (`/api/v1/cotos/:cotoId/tickets`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/` | residente | Crear ticket |
| GET | `/` | coto_admin / residente (own) | Listar tickets |
| PATCH | `/:id/estado` | coto_admin | Cambiar estado |
| POST | `/:id/comentarios` | residente / coto_admin | Agregar comentario |

#### M11: Votaciones (`/api/v1/cotos/:cotoId/votaciones`)

| Método | Ruta | Rol Mínimo | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/` | coto_admin | Crear votación |
| GET | `/` | residente | Listar votaciones |
| POST | `/:id/votar` | residente_propietario | Emitir voto |
| GET | `/:id/resultados` | coto_comite | Ver resultados |

#### M12: Webhooks Entrantes (`/api/v1/webhooks`)

| Método | Ruta | Auth | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/webhooks/conekta` | Firma RSA | Eventos de pago Conekta |
| POST | `/webhooks/stripe` | Firma HMAC | Eventos de suscripción Stripe |
| POST | `/webhooks/whatsapp` | Firma Meta | Mensajes entrantes WhatsApp |
| POST | `/webhooks/iot/:deviceId` | API Key | Eventos de dispositivos IoT |

---

## 7. Motor de Pagos y Auto-Pay

*(Detalle completo en el artefacto anterior — referencia cruzada)*

### 7.1 Flujo de Webhooks de Pago (Seguridad)

```typescript
// /api/v1/webhooks/conekta/route.ts

export async function POST(req: Request) {
  const body = await req.text();
  const digest = req.headers.get('digest');
  
  // 1. VERIFICAR FIRMA RSA — NUNCA procesar sin validar
  const isValid = verifyConektaSignature(body, digest);
  if (!isValid) {
    await auditLog('webhook.firma_invalida', { digest, ip: getIP(req) });
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  const event = JSON.parse(body);
  
  // 2. IDEMPOTENCIA — Verificar si ya procesamos este evento
  const existing = await db.webhookEvents.findUnique({
    where: { event_id: event.data.object.id }
  });
  if (existing) {
    return Response.json({ status: 'already_processed' }, { status: 200 });
  }
  
  // 3. GUARDAR evento y encolar procesamiento
  await db.webhookEvents.create({
    data: { event_id: event.data.object.id, type: event.type, payload: event }
  });
  
  await paymentQueue.add('process-payment-webhook', {
    eventId: event.data.object.id,
    type: event.type,
  });
  
  // 4. Responder 200 INMEDIATAMENTE (Conekta espera <5s)
  return Response.json({ status: 'queued' }, { status: 200 });
}
```

---

## 8. Motor de IA y WhatsApp (Arquitectura Self-Hosted Anti-Baneo)

> [!CAUTION]
> **Riesgo Operativo Crítico:** El bloqueo o baneo de números de WhatsApp por parte de Meta puede detener la cobranza y la comunicación de un condominio entero. Por ello, el sistema abandona el enfoque ingenuo de "enviar mensajes masivos con un bot" y adopta una **estrategia de mitigación anti-baneo en 5 capas** montada sobre **Evolution API v2**, el gateway self-hosted líder en la industria.

### 8.1 Comparativa de Motores Self-Hosted: ¿Por qué Evolution API v2?

| Criterio | Evolution API v2 (Recomendado) | WAHA (WhatsApp HTTP API) | WPPConnect Server | Meta Cloud API Oficial |
| :--- | :--- | :--- | :--- | :--- |
| **Arquitectura de Conexión** | **Híbrida:** Baileys (WebSocket sin navegador) + Cloud API oficial | Baileys o Puppeteer | Chrome headless / Puppeteer | API REST oficial de Meta |
| **Consumo de RAM por Instancia** | **Muy bajo (~40-80 MB)** | Medio (~100-300 MB) | Muy alto (~400-800 MB por Chrome) | N/A (Serverless) |
| **Soporte Multi-Instancia (Multi-Tenant)** | **Nativo y escalable:** Miles de instancias con un solo servidor | Soporta sesiones | Difícil de escalar a >20 instancias | N/A |
| **Riesgo de Detección/Baneo** | **Bajo** (con proxies y emulación de presencia) | Medio/Bajo | **Alto** (huellas detectables de Chromium) | **Cero** (Oficialmente autorizado) |
| **Soporte de Proxies por Instancia** | ✅ **Nativo (HTTP/HTTPS/SOCKS5)** | ✅ Soporta proxies | ⚠️ Configuración compleja | N/A |
| **Costos por Mensaje** | **$0.00 MXN** (Solo costo de hosting y chip) | $0.00 MXN | $0.00 MXN | ~$0.015 - $0.05 USD por conversación |
| **Veredicto para Administrador de Cotos** | 🏆 **Ganador Absoluto** para operación self-hosted masiva | Buena alternativa secundaria | Descartado por consumo y baneos | **Segundo riel** de respaldo para alertas críticas |

---

### 8.2 Arquitectura Anti-Baneo en 5 Capas

```mermaid
flowchart TD
    subgraph Layer1["Capa 1: Estrategia de Flujo Inbound-First"]
        QR_POST["QR en Elevador/Caseta: 'Escribe Hola para ver tu saldo'"] --> RES_HELLO["Residente inicia el chat (Inbound)"]
        RES_HELLO --> VCARD["Bot envía vCard: 'Guarda este contacto como Administración'"]
    end

    subgraph Layer2["Capa 2: Aislamiento de Red (Proxies Residenciales)"]
        PROXY_MX["Proxy Residencial Guadalajara/CDMX (Telmex/Totalplay)"]
        META_SERVERS["Servidores de Meta / WhatsApp"]
        PROXY_MX -->|IP Residencial Limpia\nNo Datacenter AWS/Hetzner| META_SERVERS
    end

    subgraph Layer3["Capa 3: Emulación de Conducta Humana"]
        QUEUE["Cola de Mensajes (BullMQ + Redis)"]
        QUEUE --> TYPING["Envía estado 'composing' (1.5 - 3.5s)"]
        TYPING --> DELAY["Jitter Gaussiano aleatorio (2 - 7s entre mensajes)"]
        DELAY --> READ["Marca mensaje previo como leído (read_receipt)"]
        READ --> SEND["Envío final de mensaje"]
    end

    subgraph Layer4["Capa 4: Motor de Calentamiento (Warm-Up Protocol)"]
        NEW_SIM["Chip Nuevo Activado"] --> W1["Semana 1: Max 15 msgs/día (100% Inbound)"]
        W1 --> W2["Semana 2: Max 50 msgs/día"]
        W2 --> W3["Semana 3: Max 150 msgs/día"]
        W3 --> W4["Semana 4+: Régimen Normal (300-500 msgs/día)"]
    end

    subgraph Layer5["Capa 5: Topología Híbrida Dual-Rail"]
        ROUTER{"¿Tipo de Mensaje?"}
        ROUTER -->|"Consulta de saldo / QR Visita / Tickets (Inbound)"| RAIL_BAILEYS["Riel 1: Evolution API (Baileys + Proxy Residencial)\nCosto $0"]
        ROUTER -->|"Convocatoria Asamblea Urgente / Broadcast Masivo"| RAIL_OFFICIAL["Riel 2: Meta Cloud API Oficial\nRiesgo de baneo CERO absoluto"]
    end
```

#### Regla de Oro 1: Filosofía Inbound-First (El Secreto Anti-Baneo #1)
El 90% de los baneos en WhatsApp ocurren porque un número nuevo envía mensajes a 300 personas que **no lo tienen guardado en sus contactos**. Cuando 4 o 5 personas presionan el botón *"Reportar como Spam / Bloquear"*, el algoritmo de Meta banea el número de inmediato.
* **Solución de Arquitectura:** En el onboarding del coto, se genera un póster para la caseta y elevadores con un código QR que dice: *"Escanea aquí para consultar tu saldo, descargar recibos y generar pases de visita por WhatsApp"*.
* El residente envía el primer mensaje (`"Hola"`). Al ser un mensaje **entrante (inbound)**, Meta clasifica la conversación como legítima y reduce el riesgo de penalización en más de un 95%.
* **Compartición de vCard Automática:** En el primer contacto, el bot envía automáticamente la tarjeta de contacto oficial del coto solicitando: *"Por favor guarda este número en tu agenda como 'Administración Coto Miraflores' para que tus notificaciones y códigos QR nunca se interrumpan"*.

#### Regla de Oro 2: Proxies Residenciales Dedicados por Coto (Anti-Datacenter Flagging)
Si corremos 50 instancias de WhatsApp desde un solo servidor de Hetzner, AWS o DigitalOcean, Meta detecta que 50 números están saliendo desde el mismo bloque de IP de un centro de datos.
* **Solución:** Cada instancia de Evolution API se configura con un **proxy residencial rotativo/fijo de México** (ej. IPRoyal, Bright Data o Webshare).
* A ojos de Meta, el tráfico del coto proviene de una conexión residencial doméstica de **Telmex Infinitum o Totalplay** en la misma ciudad donde se ubica el fraccionamiento.

#### Regla de Oro 3: Emulación de Conducta Humana en la Cola de Envío
```typescript
// /packages/notifications/src/whatsapp-scheduler.ts
export async function scheduleWhatsAppMessage(payload: WhatsAppPayload) {
  // 1. Calcular tiempo de 'escribiendo...' proporcional al texto
  const charCount = payload.text.length;
  const typingMs = Math.min(Math.max(charCount * 35, 1500), 5000); // Entre 1.5s y 5.0s

  // 2. Jitter gaussiano aleatorio entre mensajes (evitar cadencias robóticas)
  const randomDelayMs = Math.floor(Math.random() * (4500 - 2000 + 1)) + 2000;

  await whatsappQueue.add(
    'send-message',
    {
      ...payload,
      typingDurationMs: typingMs,
    },
    {
      delay: randomDelayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }
    }
  );
}
```

---

### 8.3 Configuración de Infraestructura: Evolution API v2 (Docker Compose)

Despliegue self-hosted optimizado para alta concurrencia, multi-tenancy y aislamiento con Redis:

```yaml
# infra/docker-compose.whatsapp.yml
version: '3.8'

services:
  evolution-api:
    image: atendai/evolution-api:v2.1.2
    container_name: evolution_api_gateway
    restart: always
    ports:
      - "8080:8080"
    environment:
      - SERVER_URL=https://whatsapp-gateway.admcotos.mx
      - DOCKER_ENV=true
      - LOG_LEVEL=ERROR,WARN,INFO
      - AUTHENTICATION_API_KEY=${EVOLUTION_MASTER_API_KEY}
      
      # Base de Datos PostgreSQL dedicada para sesiones de WhatsApp
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/evolution_db?schema=public
      - DATABASE_CLIENT_NAME=evolution_api
      
      # Redis para Colas BullMQ y Estado de Sesiones
      - REDIS_ENABLED=true
      - REDIS_URI=redis://:${REDIS_PASSWORD}@redis:6379/1
      
      # Webhooks Globales hacia nuestro Backend Next.js/NestJS
      - WEBHOOK_GLOBAL_ENABLED=true
      - WEBHOOK_GLOBAL_URL=https://api.admcotos.mx/api/v1/webhooks/whatsapp-evolution
      - WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS=true
      - WEBHOOK_EVENTS_MESSAGES_UPSERT=true
      - WEBHOOK_EVENTS_CONNECTION_UPDATE=true
      - WEBHOOK_EVENTS_SEND_MESSAGE=true
      
      # Seguridad y Cifrado
      - CONFIG_SESSION_PHONE_CLIENT=Administrador de Cotos
      - WEBSOCKET_ENABLED=true
    volumes:
      - evolution_instances:/evolution/instances
    networks:
      - admcotos_internal_network

volumes:
  evolution_instances:
    driver: local

networks:
  admcotos_internal_network:
    external: true
```

---

### 8.4 Flujo de Procesamiento y Webhooks con Seguridad Criptográfica

```mermaid
sequenceDiagram
    actor Residente as Residente (WhatsApp)
    participant WA as Red WhatsApp
    participant Evo as Evolution API v2 (Docker Self-Hosted)
    participant Proxy as Proxy Residencial MX
    participant BE as Backend API (Next.js)
    participant AI as Gemini Flash (NLP/OCR)
    participant DB as PostgreSQL (RLS)

    Residente->>WA: "Hola, ¿cuánto debo de mantenimiento?"
    WA->>Proxy: Encriptado Signal Protocol
    Proxy->>Evo: WebSocket connection
    Evo->>BE: POST /api/v1/webhooks/whatsapp-evolution (Payload firmado)
    
    Note over BE: 1. Valida API Key + HMAC Secret<br/>2. Deserializa mensaje y busca usuario por teléfono
    
    BE->>AI: Analiza intención con Gemini Flash
    AI-->>BE: { intent: "consulta_saldo", confianza: 0.98 }
    
    BE->>DB: Inyecta tenant context y consulta saldo
    DB-->>BE: Saldo: $1,450 MXN (Vencimiento: 10 Dic)
    
    BE->>Evo: POST /message/sendText/{coto_instance}
    Note over Evo: 1. Simula 'composing' por 2.2s<br/>2. Marca mensaje como leído<br/>3. Aplica delay gaussiano
    Evo->>Proxy: Envía payload
    Proxy->>WA: Enrutado a través de IP Residencial
    WA-->>Residente: "🏠 Tu saldo pendiente es $1,450 MXN.\n📅 Límite: 10 de Diciembre.\n💳 Pagar en línea: [Link Seguro]\n🔑 Pases de visita: escribe 'visita'"
```

---

### 8.5 Catálogo Completo de Intenciones del Asistente

| Intención | Ejemplos de Entrada del Residente | Respuesta y Acción del Backend |
| :--- | :--- | :--- |
| `consulta_saldo` | "cuánto debo", "mi saldo", "estado de cuenta" | Muestra desglose de cuotas pendientes, recargos y link de pago en línea (Conekta). |
| `generar_qr_visita` | "viene una visita", "invitado", "pase de acceso" | Pide el nombre de la visita y fecha $\rightarrow$ genera código QR dinámico y lo envía como imagen con código numérico de 6 dígitos. |
| `enviar_comprobante` | Residente adjunta foto o PDF de transferencia BBVA/Santander | Descarga el archivo, activa el motor OCR multimodal con Gemini Flash y concilia el pago en segundos. |
| `apartar_amenidad` | "quiero apartar la alberca", "reservar palapa este sábado" | Consulta disponibilidad en tiempo real, verifica que no tenga adeudos y agenda la reservación. |
| `reportar_falla` | "se fue la luz en la privada", "hay una fuga de agua en la entrada" | Crea un ticket de mantenimiento clasificado, adjunta las fotos enviadas y notifica al administrador. |
| `asamblea_votacion` | "quiero votar en la asamblea", "votación pintura" | Muestra las opciones activas de la encuesta, valida que sea propietario con derecho a voto y registra la papeleta digital. |
| `escalar_humano` | "hablar con el administrador", "ayuda de una persona" | Pausa el bot temporalmente para esa conversación y notifica al administrador del coto vía panel web. |

---

### 8.6 OCR Multimodal de Comprobantes Bancarios (Gemini Flash)

Cuando el vecino manda una foto de su comprobante por WhatsApp, el pipeline de conciliación automática opera en menos de 2 segundos:

```typescript
// /packages/ai/src/ocr-comprobantes.ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export interface ComprobanteExtraido {
  montoCentavos: number;
  fechaOperacion: string; // ISO 8601
  claveRastreo: string | null;
  referencia: string | null;
  bancoOrigen: string;
  cuentaDestinoUltimos4: string | null;
  esValido: boolean;
}

export async function extraerDatosComprobante(imageBuffer: Buffer, mimeType: string): Promise<ComprobanteExtraido> {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `Analiza esta imagen de comprobante de pago o transferencia bancaria en México (BBVA, Banorte, Santander, Banamex, Mercado Pago, STP, Nu, etc.).
Extrae los siguientes datos en formato JSON estricto:
{
  "montoCentavos": número entero con el monto en centavos (ej. $1,500.00 -> 150000),
  "fechaOperacion": fecha en formato YYYY-MM-DDTHH:mm:ss o null,
  "claveRastreo": cadena de texto con la clave de rastreo SPEI o null,
  "referencia": número de referencia o autorización o null,
  "bancoOrigen": nombre del banco emisor o "Desconocido",
  "cuentaDestinoUltimos4": últimos 4 dígitos de la cuenta o CLABE receptora o null,
  "esValido": true si parece un comprobante bancario real, false si es una foto no relacionada
}
Responde ÚNICAMENTE con el bloque JSON, sin markdown adicional.`;

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType
      }
    }
  ]);

  const responseText = result.response.text().trim();
  const cleanJson = responseText.replace(/```json|```/g, '').trim();
  
  return JSON.parse(cleanJson);
}
```

---

## 9. Motor de Accesos e IoT

### 9.1 Protocolo de Comunicación con Dispositivos

```mermaid
flowchart LR
    subgraph Caseta["🏢 Caseta"]
        QR["Lector QR (Tablet)"]
        RFID["Antena RFID UHF\n(ZKTeco / Hikvision)"]
        LPR["Cámara LPR\n(Lectura de Placas)"]
        PLUMA["Pluma Vehicular\n(Control de Barrera)"]
    end

    subgraph Cloud["☁️ Backend"]
        MQTT["MQTT Broker\n(EMQX / HiveMQ Cloud)"]
        IOT_API["IoT Event Handler"]
        AUTH_ENGINE["Motor de Autorización\n(¿Está al corriente?\n¿Tiene tag activo?\n¿QR válido?)"]
    end

    QR -->|"HTTPS POST\n/api/accesos/validar"| IOT_API
    RFID -->|"MQTT publish\ntopic: coto/xxx/rfid"| MQTT
    LPR -->|"MQTT publish\ntopic: coto/xxx/lpr"| MQTT
    MQTT --> IOT_API
    IOT_API --> AUTH_ENGINE
    AUTH_ENGINE -->|"MQTT command\ntopic: coto/xxx/pluma/open"| PLUMA
```

---

## 10. Infraestructura, DevOps y Observabilidad

### 10.1 Stack de Infraestructura

```mermaid
graph TD
    subgraph CI_CD["🔄 CI/CD"]
        GH["GitHub (Monorepo)"]
        GHA["GitHub Actions"]
        TESTS["Tests Automatizados\n- Unit (Vitest)\n- Integration (Postgres testcontainers)\n- E2E (Playwright)\n- Security (npm audit + Snyk)"]
    end

    subgraph Hosting["☁️ Hosting"]
        VERCEL["Vercel\n(Next.js Frontend + API)"]
        RAILWAY["Railway\n(Workers BullMQ)\n(MQTT Bridge)"]
    end

    subgraph Data_Infra["🗄️ Data"]
        SUPA["Supabase\n(Postgres + Auth + Storage + Realtime)"]
        UPSTASH["Upstash Redis\n(Colas + Cache + Rate Limits)"]
    end

    subgraph Observability["📊 Observabilidad"]
        SENTRY["Sentry\n(Error tracking + Performance)"]
        AXIOM["Axiom / Better Stack\n(Logs estructurados)"]
        UPTIME["Better Uptime\n(Status page + Alertas)"]
    end

    subgraph Security_Infra["🔒 Seguridad"]
        CF["Cloudflare\n(CDN + WAF + DDoS)"]
        VAULT2["Infisical / Doppler\n(Secrets Manager)"]
    end

    GH --> GHA --> TESTS
    TESTS -->|"Deploy on merge to main"| VERCEL
    TESTS -->|"Deploy workers"| RAILWAY
    VERCEL --> CF
    VERCEL --> SUPA
    RAILWAY --> SUPA
    RAILWAY --> UPSTASH
    VERCEL --> UPSTASH

    VERCEL --> SENTRY
    RAILWAY --> SENTRY
    VERCEL --> AXIOM
    RAILWAY --> AXIOM
```

### 10.2 Estructura del Monorepo

```
administradorcotos/
├── apps/
│   ├── web/                    # Next.js 15 (Portal Admin + Residente)
│   │   ├── app/
│   │   │   ├── (auth)/         # Rutas de autenticación
│   │   │   ├── (dashboard)/    # Dashboard admin
│   │   │   ├── (residente)/    # Portal del residente
│   │   │   ├── api/
│   │   │   │   ├── v1/         # API REST endpoints
│   │   │   │   └── webhooks/   # Webhook handlers
│   │   │   └── layout.tsx
│   │   ├── middleware.ts       # Auth + tenant middleware
│   │   └── next.config.ts
│   ├── mobile/                 # React Native / Expo
│   │   ├── src/screens/
│   │   └── app.json
│   └── caseta/                 # App kiosk para tablet caseta
│       └── src/
├── packages/
│   ├── db/                     # Prisma/Drizzle schema + migrations
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   ├── auth/                   # Auth helpers (Supabase + RBAC)
│   ├── payments/               # Conekta + Stripe wrappers
│   ├── cfdi/                   # Timbrado CFDI SAT
│   ├── notifications/          # Push + Email + WhatsApp
│   ├── ai/                     # OCR + NLP wrappers
│   ├── iot/                    # MQTT + IoT protocols
│   ├── shared/                 # Types, utils, validators (Zod)
│   │   ├── types/
│   │   ├── validators/
│   │   └── constants/
│   └── ui/                     # shadcn/ui components compartidos
├── workers/
│   ├── autopay-scheduler.ts    # Cron de cobros automáticos
│   ├── notification-worker.ts  # Procesador de notificaciones
│   ├── cfdi-worker.ts          # Timbrado asíncrono
│   ├── ocr-worker.ts           # OCR de comprobantes
│   ├── conciliacion-worker.ts  # Conciliación bancaria
│   └── audit-writer.ts         # Escritor de audit log
├── infra/
│   ├── docker-compose.yml      # Dev environment
│   ├── supabase/
│   │   ├── migrations/
│   │   └── config.toml
│   └── scripts/
│       ├── seed-dev.ts
│       └── backup.sh
├── tests/
│   ├── unit/
│   ├── integration/
│   │   └── rls-isolation.test.ts   # 🔴 CRÍTICO: Tests de aislamiento tenant
│   └── e2e/
├── docs/
│   ├── api/                    # OpenAPI spec autogenerada
│   ├── architecture/
│   └── security/
├── turbo.json                  # Turborepo config
├── package.json
└── .env.example                # NUNCA commitear .env real
```

### 10.3 Pipeline CI/CD

```yaml
# .github/workflows/ci.yml (simplificado)
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level=high
      - uses: snyk/actions/node@master

  lint-and-type-check:
    runs-on: ubuntu-latest
    steps:
      - run: turbo lint typecheck

  test-unit:
    runs-on: ubuntu-latest
    steps:
      - run: turbo test:unit

  test-integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
    steps:
      - run: turbo test:integration
      # 🔴 INCLUYE: tests de aislamiento RLS multi-tenant

  test-e2e:
    needs: [test-unit, test-integration]
    runs-on: ubuntu-latest
    steps:
      - run: turbo test:e2e

  deploy-staging:
    needs: [security-scan, test-e2e]
    if: github.ref == 'refs/heads/develop'
    steps:
      - run: vercel deploy --env preview

  deploy-production:
    needs: [security-scan, test-e2e]
    if: github.ref == 'refs/heads/main'
    steps:
      - run: vercel deploy --prod
      - run: railway deploy
```

---

## 11. Cumplimiento Legal y Privacidad

### 11.1 LFPDPPP (México) — Obligaciones del SaaS

| Obligación | Implementación en el Sistema |
| :--- | :--- |
| **Aviso de Privacidad** | Cada organización configura su propio aviso. Se muestra al residente en su primer login. Se registra versión aceptada y fecha. |
| **Consentimiento para datos sensibles** | Al activar control biométrico o fotos en caseta, se pide consentimiento expreso con checkbox obligatorio y registro en `audit_log`. |
| **Derechos ARCO** | Endpoint `DELETE /auth/me` inicia proceso de eliminación. Admin puede exportar datos del residente (Acceso). `PATCH /auth/me` para Rectificación. |
| **Medidas de seguridad** | Encriptación (AES-256 reposo, TLS 1.3 tránsito), RBAC, RLS, audit log inmutable, backups diarios encriptados. |
| **Acuerdo de Encargado** | Términos de servicio incluyen cláusulas de procesamiento de datos. Nosotros somos Encargado; el coto es Responsable. |
| **Prohibición de publicar morosos** | El sistema NUNCA publica nombres de morosos en áreas públicas. Los reportes de morosidad solo son visibles para roles `coto_admin` y `coto_tesorero`. |
| **Retención de datos** | Política configurable por coto. Registros de acceso: 90 días por defecto. Datos financieros: 5 años (obligación fiscal). |

### 11.2 PCI-DSS — Manejo de Pagos

| Control | Implementación |
| :--- | :--- |
| **Nunca tocar datos raw de tarjeta** | Tokenización 100% client-side via Conekta Components SDK. Backend solo recibe `tok_xxx`. |
| **Almacenamiento** | Solo tokens opacos y últimos 4 dígitos. Nunca PAN, CVV, fecha completa. |
| **Transmisión** | TLS 1.3 obligatorio en toda comunicación con pasarela. |
| **Webhook verification** | Firma RSA verificada antes de procesar cualquier evento de pago. |
| **Segregación de ambientes** | Keys de sandbox vs producción en variables de entorno separadas. |

---

## 12. Disaster Recovery y Backups

### 12.1 Estrategia de Backups

| Tipo | Frecuencia | Retención | Almacenamiento |
| :--- | :--- | :--- | :--- |
| **Postgres Point-in-Time Recovery** | Continuo (WAL) | 7 días | Supabase managed |
| **Snapshot completo DB** | Diario 3:00 AM CST | 30 días | Supabase + GCS bucket externo |
| **Storage (documentos, fotos)** | Continuo (versionado) | 90 días versiones | Supabase Storage |
| **Configuración e IaC** | Cada commit | Indefinido | Git (GitHub) |
| **Secrets** | Cada cambio | Versionado | Infisical/Doppler |

### 12.2 RPO y RTO

| Métrica | Objetivo | Cómo se logra |
| :--- | :--- | :--- |
| **RPO** (Recovery Point Objective) | < 1 hora | WAL streaming continuo |
| **RTO** (Recovery Time Objective) | < 4 horas | Restore automatizado desde snapshot + redeploy |

### 12.3 Plan de Respuesta a Incidentes

```mermaid
flowchart TD
    A["🚨 Incidente Detectado"] --> B{Tipo}
    B -->|"Brecha de datos"| C["1. Contener: Revocar tokens\n2. Preservar evidencia\n3. Notificar INAI (72 hrs si es grave)\n4. Notificar usuarios afectados\n5. Post-mortem"]
    B -->|"Caída de servicio"| D["1. Activar status page\n2. Failover a réplica\n3. Comunicar ETA\n4. Restaurar\n5. Post-mortem"]
    B -->|"Intento de intrusión"| E["1. Bloquear IP/origen\n2. Rotar credenciales afectadas\n3. Analizar logs\n4. Fortalecer control\n5. Post-mortem"]
```

---

## 13. Hoja de Ruta de Implementación

```mermaid
flowchart LR
    subgraph F1["🟢 Fase 1: Fundamentos (Sem 1-3)"]
        F1A["Monorepo + CI/CD"]
        F1B["Schema DB + RLS + Seed"]
        F1C["Auth + RBAC + Middleware"]
        F1D["CRUD Orgs + Cotos + Unidades"]
        F1E["Tests de aislamiento RLS"]
    end

    subgraph F2["🔵 Fase 2: Finanzas Core (Sem 4-6)"]
        F2A["Cargos + Generación masiva"]
        F2B["Pagos manuales + Estados de cuenta"]
        F2C["Integración Conekta (tarjeta + SPEI)"]
        F2D["Webhooks + Conciliación"]
        F2E["Egresos + Balance"]
    end

    subgraph F3["🟡 Fase 3: Auto-Pay + CFDI (Sem 7-9)"]
        F3A["Tokenización + Payment Methods"]
        F3B["Scheduler BullMQ de cobros"]
        F3C["Reintentos + Notificaciones"]
        F3D["Timbrado CFDI 4.0"]
        F3E["Portal residente web"]
    end

    subgraph F4["🟠 Fase 4: Comunicación + WhatsApp (Sem 10-12)"]
        F4A["Comunicados + Push + Email"]
        F4B["WhatsApp Bot (saldos, QR)"]
        F4C["OCR comprobantes IA"]
        F4D["Tickets + Votaciones"]
        F4E["App Móvil Residente (Expo)"]
    end

    subgraph F5["🔴 Fase 5: Accesos + IoT + Scale (Sem 13-16)"]
        F5A["QR Invitaciones + Caseta"]
        F5B["App Caseta (Kiosk mode)"]
        F5C["Integración RFID/LPR/Plumas"]
        F5D["Amenidades + Reservaciones"]
        F5E["White Label + Onboarding"]
        F5F["Load testing + Hardening final"]
    end

    F1 --> F2 --> F3 --> F4 --> F5
```

---

## 14. Métricas de Éxito y KPIs

### 14.1 KPIs Técnicos

| Métrica | Objetivo | Herramienta |
| :--- | :--- | :--- |
| **Uptime** | 99.9% (8.7 hrs downtime/año máx) | Better Uptime |
| **P95 Latency API** | < 200ms | Sentry Performance |
| **Error Rate** | < 0.1% | Sentry |
| **Test Coverage** | > 80% | Vitest + Coverage |
| **RLS Isolation Tests** | 100% pass siempre | CI obligatorio |
| **Security Vulnerabilities** | 0 high/critical | Snyk + npm audit |
| **Webhook Success Rate** | > 99.5% | Custom dashboard |

### 14.2 KPIs de Negocio

| Métrica | Descripción |
| :--- | :--- |
| **MRR** (Monthly Recurring Revenue) | Ingresos mensuales recurrentes |
| **Cotos Activos** | Total de cotos con actividad en los últimos 30 días |
| **Tasa de Morosidad Promedio** | % de cuotas vencidas vs emitidas (nuestros clientes) |
| **Adopción Auto-Pay** | % de unidades con auto-pay activo |
| **NPS Residente** | Net Promoter Score de los residentes |
| **Churn Rate** | % de cotos que cancelan por mes |
| **CAC** (Costo de Adquisición) | Costo promedio para adquirir un coto nuevo |
| **LTV** (Lifetime Value) | Ingreso promedio por coto durante su vida útil |
