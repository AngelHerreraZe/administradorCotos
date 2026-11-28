# 🏢 Administrador de Cotos

Plataforma SaaS B2B2C multi-inquilino para administrar condominios, cotos y fraccionamientos en México y LATAM: cobranza, accesos, comunicación y gobernanza. Se vende al mayoreo a despachos y desarrolladoras, con seguridad de grado bancario y cumplimiento de la LFPDPPP.

## Documentación

| Documento | Para qué |
| :--- | :--- |
| [`AGENTS.md`](AGENTS.md) | Reglas obligatorias para cualquier persona o agente de IA que escriba código aquí |
| [`plan_fases_backend.md`](plan_fases_backend.md) | Plan de implementación por fases, con convenciones y código de referencia |
| [`plan_backend_mayoreo_seguridad_extrema.md`](plan_backend_mayoreo_seguridad_extrema.md) | Modelo de negocio mayorista y seguridad; §9: validación y endurecimiento |
| [`plan_backend_administrador_cotos.md`](plan_backend_administrador_cotos.md) | Visión de producto, roles, módulos y esquema original |
| [`DESIGN.md`](DESIGN.md) | Sistema de diseño y superficies por tipo de usuario |

## Estructura

```text
apps/api          API HTTP (Hono + OpenAPI). Toda consulta pasa por RLS.
apps/worker       Colas BullMQ (auditoría hoy; cobros, CFDI, notificaciones por fase).
apps/web · mobile · caseta   Frontends (se crean en su fase).
packages/db       Prisma 7, migraciones con RLS, withTenant, prueba de aislamiento.
packages/security Cifrado por campo, cadena de auditoría HMAC, firma de contexto.
packages/shared   Contratos Zod y errores compartidos con los frontends.
packages/whatsapp Cliente Evolution API y políticas anti-baneo.
packages/*        storage, notifications, payments, cfdi, ai, iot: se implementan por fase.
infra/            Docker Compose local (Postgres, Redis, Evolution).
```

## Inicio rápido

Requisitos: Node.js 26 LTS (`.node-version`), npm 12 y Docker.

```bash
cp .env.example .env                    # llena los secretos (cada uno trae cómo generarlo)
npm install
docker compose -f infra/docker-compose.whatsapp.yml up -d postgres redis
npm run db:migrate:deploy               # usa DIRECT_DATABASE_URL (rol dueño)
# una vez, como dueño de la BD:
#   ALTER ROLE app_service LOGIN PASSWORD '...';  ALTER ROLE app_worker LOGIN PASSWORD '...';
#   INSERT INTO app_private.ctx_secret (secret) VALUES (decode('<DB_CTX_SECRET>', 'hex'));
npm run db:generate
npm run dev                             # API en http://localhost:4000 · /health/ready · /openapi.json
```

## Comandos

| Comando | Qué hace |
| :--- | :--- |
| `npm run check` | Biome + TypeScript 7 + todas las pruebas. Debe pasar antes de cada entrega. |
| `npm run test:security` | Aislamiento multi-inquilino contra Postgres en memoria (sin Docker). |
| `npm run format` | Formato y arreglos seguros. |
| `npm run db:migrate:dev` | Crea una migración sin aplicarla (revísala: ver AGENTS.md §3.14). |

## Flujo con Gemini y Claude

Gemini (Antigravity) implementa y Claude Code audita: nada llega a `main` sin dictamen `APROBADO` sobre ese código exacto. Ciclo y reglas en [`AGENTS.md` §8](AGENTS.md#8-flujo-de-trabajo-gemini-implementa-claude-audita).

Configuración, una vez:

1. **GitHub** → *Settings › Rules* para `main`: exigir PR y los checks `check`, `migraciones-postgres` y `auditoria`.
2. **Antigravity**: abre la raíz del repo (carga `AGENTS.md` y la skill `implementar`). *Plan Review Policy*: *Always Ask*. Permisos: preset *Default* y en *Deny* `command(git)` y `command(gh)`. Ningún agente usa git ni GitHub.
3. **Claude Code**: nada; `.claude/settings.json` le niega `git` y `gh`, y `/auditar` vive en `.claude/skills/`.

## Seguridad en una línea por capa

Identidad firmada por transacción → roles derivados en Postgres → RLS en todas las tablas → integridad por triggers y constraints → auditoría encadenada con HMAC → cifrado por organización → cabeceras según [modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance). Detalle en el plan de seguridad §9.
