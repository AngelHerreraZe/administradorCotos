# Entrega: feat/f1-identidad

Tarea: Fase 1 — Identidad, MFA, tenancy y núcleo organizacional (`plan_fases_backend.md` §5)
Ronda: 1

## Qué cambió

### Base de datos, contexto y seguridad
- `packages/security/src/tenant-context.ts`: actualiza `signDbContext` al formato v2 (`<uuid>.<aal1|aal2>.<exp>.<hmac>`) con opciones `{ aal, ttlSeconds }`.
- `packages/security/test/security.test.ts`: verifica formato v2, `aal1` por defecto y `aal2`.
- `packages/db/src/index.ts`: agrega `aal` a `DbContext` y lo envía a `signDbContext` dentro de `withTenant`.
- `packages/db/prisma/schema.prisma`: agrega `organizaciones.exigir_mfa` y el modelo `InvitacionMiembro` con sus relaciones e índices.
- `packages/db/prisma/migrations/20261126000200_identidad/migration.sql`:
  - Agrega `organizaciones.exigir_mfa` (`DEFAULT true`), `app.uid()` v2, `app.aal()` (`SECURITY DEFINER`, `search_path` fijo) y exigencia de `aal2` en `app._cotos`, `app._orgs` (escrituras) y `app.orgs_owner()`.
  - Agrega `app.usuario_por_auth(uuid)` (`SECURITY DEFINER`).
  - Crea `invitaciones_miembro` con RLS total, políticas por `cotos_admin` / `orgs_owner`, restricción `coto_activo`, privilegio mínimo (`UPDATE` solo sobre `revocada_en` para `app_service`), `CHECK`s de vigencia ≤ 7 días, roles y alcance, triggers `tg_invitacion_org_coto`, `tg_mismo_coto`, `tg_inmutable` y `tg_auditar('token_hash')`.
  - Crea `app.aceptar_invitacion` (`SECURITY DEFINER`, idempotente para el mismo `auth_id`) y `app.mis_membresias()`.
  - Actualiza `generar_cargos`, `aplicar_pago`, `validar_acceso`, `votar` y `guardar_csd` a códigos `UA4xx`.
- `packages/db/test/rls.test.ts`: agrega escenarios de firma v1 rechazada, `aal1` vs `aal2` para staff y propietario de despacho, residente sin MFA operando pagos, `usuario_por_auth`, `mis_membresias` y ciclo completo de invitaciones.

### Colas, notificaciones y worker
- `packages/shared/src/colas.ts` y `packages/shared/src/index.ts`: contrato Zod `Colas.correo`, `OPCIONES_JOB_CORREO` y soporte opcional de `errors` en `AppError`.
- `packages/notifications/package.json`, `tsconfig.json`, `src/index.ts`, `src/correo.ts`, `test/correo.test.ts`: envío de correos con Resend, escape HTML estricto, sanitización de URLs (`https:` / `http://localhost`) y plantillas `invitacion`, `recibo` y `aviso`.
- `apps/worker/package.json`, `src/env.ts`, `src/main.ts`, `src/processors/correo.ts`, `test/correo.test.ts`: registra la cola `correo` con validación de `RESEND_API_KEY` y `EMAIL_FROM` y sin PII en logs.

### API HTTP, middleware, módulos y pruebas
- `apps/api/package.json`, `package.json`: agrega dependencias de Fase 1 y separa script `test:e2e` del suite unitario `test`.
- `apps/api/src/env.ts`, `.env.example`, `apps/api/src/types.ts`: valida `SUPABASE_URL`, `AUTH_AUDIENCE`, `REDIS_URL`, `APP_PUBLIC_URL` e inyecta `jwks`, `limitador` y `encolarCorreo` explícitamente en `Deps`.
- `apps/api/src/lib/tenant.ts`, `src/lib/openapi.ts`, `src/lib/prisma.ts`: helpers `conTenant`, `conTenantPreRegistro`, `respuestasError` y `actualizarConRls`.
- `apps/api/src/middleware/auth.ts` y `test/auth.test.ts`: verificación JWT (`ES256`/`RS256`, JWKS), caché acotada de `authId -> usuarioId` (solo no nulos), y `autenticacionPreRegistro` para aceptar invitaciones antes de tener fila en `usuarios`.
- `apps/api/src/middleware/rate-limit.ts` y `test/rate-limit.test.ts`: `RateLimiterRedis` por usuario/IP y estricto por ruta, validación de IP de Cloudflare vía `BlockList`, tolerancia a caída de Redis en rutas generales y rechazo `503` en rutas críticas.
- `apps/api/src/middleware/errors.ts`: mapeo de `22P02`, `errors` en `AppError` y códigos Prisma `P2025`/`P2002`/`P2003`.
- Módulos en `apps/api/src/modules/{me,invitaciones,orgs,cotos,sectores,unidades,miembros}/` (`schemas.ts`, `service.ts`, `routes.ts`) y montaje en `apps/api/src/app.ts` y `apps/api/src/main.ts`.
- Pruebas unitarias en `apps/api/test/{app,me,invitaciones,orgs,cotos,sectores,unidades,miembros}.test.ts`.
- Pruebas E2E en `apps/api/test/e2e/{setup,identidad}.test.ts` y job `e2e` en `.github/workflows/ci.yml`.
- `plan_fases_backend.md`: avance actualizado en la tabla y en la lista de terminado de Fase 1.

## Decisiones

- **Sin tope de cotos por tier en `POST /orgs/{orgId}/cotos`:** confirmado por el dueño del producto; el modelo mayorista cobra por unidades activas y `organizaciones` usa `tier_mayoreo` sin `plan_max_cotos`.
- **MFA (`aal2`) también en `app._orgs`:** aplicado a escrituras de `orgs_admin` y a `orgs_owner` cuando `organizaciones.exigir_mfa = true`.
- **Pre-registro en `POST /invitaciones/aceptar`:** como quien acepta aún no tiene fila en `usuarios`, usa `autenticacionPreRegistro` (JWT válido + correo verificado) y `conTenantPreRegistro` (`authId` firmado como identidad temporal para ejecutar `app.aceptar_invitacion`). El resolvedor `usuario_por_auth` no cachea `null` para que `/me` funcione inmediatamente después de aceptar.
- **Límite de `test:e2e` separado de `test`:** `npm run test` excluye `test/e2e/**` para que `npm run check` corra sin Docker; `npm run test:e2e` ejecuta `apps/api/test/e2e` contra `TEST_DIRECT_DATABASE_URL` o `@testcontainers/postgresql` (y corre en el job `e2e` de CI).
- **Idempotencia en creaciones de Fase 1:** las tablas de Fase 1 (`cotos`, `sectores`, `unidades`, `invitaciones_miembro`, `soporte_accesos`) no tienen columna `clave_idempotencia` en el esquema actual; las operaciones de estado (`aceptar_invitacion` y `revocar`) son idempotentes por diseño y las creaciones con llave natural única responden `409`.
- **Commit previo de Fase 0 en `main`:** la rama `main` tenía los archivos de Fase 0 sin commitear; se creó el commit local de Fase 0 en `main` (`27e5859`) antes de ramificar `feat/f1-identidad`.

## Cómo probarlo

```bash
npm run db:generate
npm run check
npm run test:security
# Contra Docker o TEST_DIRECT_DATABASE_URL (Postgres 17):
npm run test:e2e
```

## Verificaciones que corrí

- `npm run db:generate`: OK (Prisma Client 7.10.1 generado).
- `npx biome ci .`: OK (94 archivos revisados, 0 errores, 0 advertencias).
- `npx turbo run typecheck test --force`: OK (13 tareas exitosas, 0 caché, 59 pruebas en verde: `@admcotos/security` 3, `@admcotos/notifications` 3, `@admcotos/worker` 4, `@admcotos/db` 16, `@admcotos/api` unitarias 33).
- `npm audit --omit=dev --audit-level=high`: reporta 3 vulnerabilidades altas en `effect <=3.22.0` (`GHSA-7589-6fvf-x4pw`) transitiva de `@prisma/config@7.10.1` -> `prisma@7.10.1` (`devOptional` ya presente en `main`). Ninguna dependencia agregada en Fase 1 tiene vulnerabilidades.
- `npm run test:e2e` y `npm run db:migrate:deploy` contra Postgres 17 real: no ejecutados localmente porque Docker Desktop está detenido en este equipo.

## modern-web-guidance

- `passkeys` y `passkey-authentication`: consultados como referencia para el flujo de MFA del staff (`aal2` exigido en BD para escrituras administrativas cuando `exigir_mfa = true`).
- `verify-email-ownership`: consultado; corresponde al *Origin Trial* experimental `tmp-email-verification`. Por confirmación del usuario se implementó verificación estándar multi-navegador con token aleatorio por Resend y correo verificado en el JWT, sin `tmp-email-verification`.

## Dependencias nuevas

- `jose@6.2.18` (`apps/api`): verificación de JWT con JWKS (`ES256`/`RS256`).
- `rate-limiter-flexible@11.6.1` (`apps/api`): limitador de tasa distribuido sobre Redis.
- `ioredis@6.1.0` (`apps/api`, misma versión que `apps/worker`): cliente Redis para rate limit y cola `correo`.
- `bullmq@6.7.10` (`apps/api`, misma versión que `apps/worker`): encolado de correos transaccionales desde la API.
- `csv-parse@7.0.3` (`apps/api`): parseo en streaming para `POST /cotos/{cotoId}/unidades/importar`.
- `resend@6.40.1` (`packages/notifications`): proveedor de correo transaccional.
- `@testcontainers/postgresql@12.2.2` (`apps/api`, `devDependencies`): levantamiento local de Postgres 17 en pruebas E2E cuando no hay `TEST_DIRECT_DATABASE_URL`.

## Pendientes y dudas

- `npm audit --omit=dev --audit-level=high` falla con salida 1 por `GHSA-7589-6fvf-x4pw` en `effect@3.20.0` (fijado por `@prisma/config@7.10.1` en `prisma@7.10.1`). No se actualizó a `prisma@8.0.0-rc.36` por la regla de no usar versiones RC (`AGENTS.md` §1) ni se forzó `overrides`.
- Ejecutar en CI (o con Docker activo localmente) los jobs `migraciones-postgres` y `e2e` (`npm run test:e2e`) contra Postgres 17 real.
