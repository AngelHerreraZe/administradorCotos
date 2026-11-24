# 🏢 Administrador de Cotos (Backend SaaS Multi-Tenant)

> Plataforma SaaS B2B2C para la administración integral de condominios, cotos residenciales y fraccionamientos cerrados en México y LATAM. Diseñada para venta al por mayor a despachos inmobiliarios y empresas administradoras con seguridad de grado bancario y cumplimiento estricto de la LFPDPPP y PCI-DSS.

---

## 📌 Documentación de Arquitectura

Para consultar el diseño técnico detallado y las especificaciones de ingeniería:

* 📄 **[Plan Maestro del Backend](file:///e:/administradorcotos/plan_backend_administrador_cotos.md)**: Arquitectura general, esquema de base de datos de 14 dominios, catálogo de más de 100 endpoints API, sistema de auto-pago, bot self-hosted de WhatsApp (Evolution API v2) con mitigaciones anti-baneo en 5 capas, gobernanza y roadmap.
* 📄 **[Arquitectura de Mayoreo B2B y Seguridad Extrema](file:///e:/administradorcotos/plan_backend_mayoreo_seguridad_extrema.md)**: Jerarquía multi-inquilino de 4 niveles, motor de facturación por volumen, dominios personalizados dinámicos con Cloudflare for SaaS, aprovisionamiento automatizado de WhatsApp por coto con proxies residenciales MX, cifrado de sobre (AES-256-GCM Envelope Encryption), auditoría forense inmutable encadenada y protocolo seguro IoT para caseta.
* 📄 **[Ingeniería Inversa de CondoVive](file:///C:/Users/Angel/.gemini/antigravity/brain/ffa1d04f-3091-4dc7-a78a-fc02f79eff5c/ingenieria_inversa_condovive.md)**: Análisis de mercado, fortalezas de la competencia y brechas explotables.

---

## 🏗️ Estructura del Proyecto (Monorepo Turborepo)

```
administradorcotos/
├── plan_backend_administrador_cotos.md        # Documento maestro del backend (API, DB, Auto-Pay, WhatsApp)
├── plan_backend_mayoreo_seguridad_extrema.md # Especificación B2B Mayoreo, White-label y Criptografía
├── apps/
│   ├── web/                    # Portal Web Next.js 15 (SuperAdmin, Despachos, Comités y Residentes)
│   ├── mobile/                 # App Móvil React Native / Expo (Residentes)
│   └── caseta/                 # App Kiosk para Tablets de Vigilancia en Caseta
├── packages/
│   ├── db/                     # Prisma ORM + Migraciones PostgreSQL con RLS
│   ├── security/               # Criptografía (AES-256-GCM), Audit Chain y Tenant Context
│   ├── whatsapp/               # Cliente Evolution API v2, Políticas Anti-Baneo y Proxies
│   ├── payments/               # Motor de Cobros (Conekta, Stripe, Auto-Pay y Reintentos)
│   ├── cfdi/                   # Timbrado SAT CFDI 4.0 con complementos de pago
│   ├── ai/                     # OCR multimodal de comprobantes bancarios (Gemini Flash)
│   ├── iot/                    # Protocolos MQTT/mTLS para plumas, RFID y cámaras LPR
│   └── shared/                 # Tipos TypeScript, validadores Zod y constantes
├── infra/
│   └── docker-compose.whatsapp.yml # Evolution API v2 + Postgres + Redis
├── workers/
│   ├── autopay-scheduler/      # Worker BullMQ de cobros automáticos programados
│   ├── notification-worker/    # Envíos masivos (WhatsApp Cloud API, Push, Email)
│   └── ocr-worker/             # Procesamiento en cola de comprobantes de pago
├── turbo.json                  # Configuración de compilación y pipelines
└── .env.example                # Variables de entorno documentadas
```

---

## 🔒 Principios de Seguridad Críticos

1. **Aislamiento Multi-Tenant (PostgreSQL RLS):**  
   Toda consulta a la base de datos se ejecuta bajo el rol `app_service` inyectando el contexto del tenant con `set_config('app.current_coto_id', ..., true)`. Ningún query puede escapar del inquilino autenticado.
2. **Cifrado de Sobre (Envelope Encryption):**  
   Datos fiscales (CSD del SAT) y credenciales bancarias se cifran con AES-256-GCM antes de persistirse en disco.
3. **Auditoría Forense Inmutable:**  
   La tabla `audit_log` utiliza un encadenamiento criptográfico con HMAC-SHA256. Cualquier alteración manual a un registro rompe la firma de los registros subsecuentes.
4. **Cumplimiento LFPDPPP:**  
   Prohibición absoluta de exhibir nombres de deudores en canales públicos. Consentimiento explícito para fotografías de visitantes y biométricos en caseta.

---

## 🚀 Inicio Rápido (Desarrollo)

### Prerrequisitos
* Node.js v20+ o v22+
* Docker Desktop (para PostgreSQL y Redis locales)
* Cuenta de pruebas en Conekta y Supabase

### Pasos
```bash
# 1. Copiar archivo de entorno
cp .env.example .env

# 2. Levantar base de datos y redis locales
docker run --name admcotos-postgres -e POSTGRES_PASSWORD=admin_password -e POSTGRES_DB=administradorcotos -p 5432:5432 -d postgres:16
docker run --name admcotos-redis -p 6379:6379 -d redis:7

# 3. Instalar dependencias
npm install

# 4. Generar cliente de base de datos
npm run db:generate
```
