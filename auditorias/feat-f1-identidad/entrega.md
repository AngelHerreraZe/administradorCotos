# Entrega: feat/f1-identidad

Tarea: Fase 1 — Identidad, MFA, tenancy y núcleo organizacional (`plan_fases_backend.md` §5)
Ronda: 2

## Qué cambió

### Base de datos, contexto y seguridad
- `packages/security/src/tenant-context.ts`: formato v2 de `signDbContext` (`<uuid>.<aal1|aal2>.<exp>.<hmac>`) y nuevo `signPreAuthContext` (`auth.<auth_uuid>.<aal1|aal2>.<exp>.<hmac>`) para transacciones previas al alta en `usuarios`.
- `packages/security/test/security.test.ts`: verifica `signDbContext` v2 y `signPreAuthContext`.
- `packages/db/src/index.ts`: agrega `aal` a `DbContext` y `withPreAuthTenant` para ejecutar `app.aceptar_invitacion` con `auth_id` firmado.
- `packages/db/prisma/schema.prisma`: agrega `organizaciones.exigir_mfa`, `clave_idempotencia` en `SoporteAcceso` e `InvitacionMiembro`, e índices en `invitaciones_miembro(unidad_id)` e `invitaciones_miembro(creada_por)`.
- `packages/db/prisma/migrations/20261126000200_identidad/migration.sql`:
  - Agrega `organizaciones.exigir_mfa`, `app.uid()` v2, `app.auth_uid()` (`SECURITY DEFINER`), `app.aal()` con soporte pre-auth, verificación de `usuarios.activo` en `_cotos`, `_unidades`, `_orgs` y `usuario_por_auth`, y exigencia de `aal2` en `_cotos` (escrituras), `_orgs` (escrituras) y `orgs_owner()`.
  - Agrega `soporte_accesos.clave_idempotencia` única e inmutable.
  - Crea `invitaciones_miembro` con RLS, política `upd` endurecida (`aceptada_en IS NULL AND revocada_en IS NULL` y `WITH CHECK revocada_en IS NOT NULL`), privilegio mínimo (`UPDATE (revocada_en)`), índices de FK y trigger `tg_invitacion_defaults` que fuerza `created_at := now()` en `INSERT` desde `app_service`.
  - Crea `app.aceptar_invitacion` (liga `p_auth` con `app.auth_uid()` y re-firma `app.ctx` con `usuarios.id` antes de escribir para que `audit_outbox.usuario_id` registre el `usuarios.id` real) y `app.mis_membresias()`.
  - Actualiza `generar_cargos`, `aplicar_pago`, `validar_acceso`, `votar` y `guardar_csd` a códigos `UA4xx`.
- `packages/db/test/rls.test.ts`: escenarios de firma v1 rechazada, `aal1` vs `aal2`, residente sin MFA, `usuario_por_auth`, `mis_membresias`, políticas `sel`/`ins`/`upd`/`coto_activo` en `invitaciones_miembro` (coto y despacho), validación de `app.auth_uid()`, verificación de `audit_outbox.usuario_id`, no re-revocación/des-revocación y efecto inmediato de `usuarios.activo = false`.

### Dependencias, colas, notificaciones y worker
- `package.json` y `package-lock.json`: agrega `"overrides": { "effect": "3.22.5" }` para corregir `GHSA-7589-6fvf-x4pw` en `@prisma/config@7.10.1`.
- `packages/shared/src/colas.ts` y `packages/shared/src/index.ts`: contrato `Colas.correo`, `OPCIONES_JOB_CORREO` con `removeOnComplete: true` y `removeOnFail: { age: 3_600 }`, y `errors` opcional en `AppError`.
- `packages/notifications/src/correo.ts` y `test/correo.test.ts`: envío con Resend, reenvío de `idempotencyKey`, escape HTML y sanitización de URLs.
- `apps/worker/src/processors/correo.ts` y `test/correo.test.ts`: cola `correo` pasando `idempotencyKey: job.id` a Resend, validación Zod y logs sin PII.

### API HTTP, Redis, middleware, módulos y pruebas
- `apps/api/src/lib/redis.ts` y `apps/api/src/main.ts`: conexiones ioredis separadas y *fail-fast* (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `connectTimeout: 500`, `commandTimeout: 500`) para rate limit y cola `correo` (verificación de estado `ready` y timeout de `800 ms`).
- `apps/api/src/middleware/rate-limit.ts`, `apps/api/src/app.ts` y `test/rate-limit.test.ts`: `RateLimiterRedis` con `rejectIfRedisNotReady: true`, límite por IP antes de autenticar (`limiteTasaPorIp`) y por usuario después (`limiteTasaPorUsuario`), Cloudflare `BlockList` y prueba contra puerto cerrado real (`127.0.0.1:59999`) en `< 1 s`.
- `apps/api/src/middleware/auth.ts` y `test/auth.test.ts`: JWT `ES256`/`RS256` con JWKS, caché acotada con TTL de 60 s en `crearResolvedorUsuario`, y `autenticacionPreRegistro` basado únicamente en `payload.email` top-level (sin leer `user_metadata`, rechazando anónimos y `email_verified === false`).
- `apps/api/src/lib/{tenant,prisma,openapi}.ts`: `conTenant`, `conTenantPreRegistro` (`withPreAuthTenant`), `actualizarConRls`, `extraerIdempotencyKey` y `conIdempotencia` (`SAVEPOINT sp_idempotencia`).
- `apps/api/src/modules/{me,invitaciones,orgs,cotos,sectores,unidades,miembros}/`:
  - `invitaciones`: enlace con fragmento `#token=`, soporte de `Idempotency-Key` (`200` sin duplicar correo / `201`), `jobId: inv:<id>` hacia BullMQ/Resend, ajuste de `-60 s` al vencimiento de 7 días frente a `DEFAULT now()` en BD.
  - `orgs`: `CotoResumen` con `Monto` y formateo decimal exacto a 2 decimales sin flotantes, `Idempotency-Key` en `POST /orgs/{orgId}/soporte`, y eliminación del encabezado `Location` inexistente en `/soporte`.
  - `unidades`: parseo streaming del CSV fuera de la transacción de BD (`parsearCsvUnidades`) y eliminación del helper `TipoSectorUnidadOrTipo`.
  - `miembros`: `GET` filtrado a `activo: true` y ocultando `email`/`telefono` a `coto_comite` (solo `app.cotos_finanzas()` recibe contacto por LFPDPPP); `PATCH` sin join obligatorio a `usuario` cuando `activo = false` para permitir desactivaciones limpias.
- Pruebas unitarias (`apps/api/test/*.test.ts`) y suite E2E (`apps/api/test/e2e/{setup,identidad}.test.ts` + `.github/workflows/ci.yml`).
- `plan_fases_backend.md`: tabla de endpoints y lista de terminado de Fase 1 actualizadas.

## Decisiones

- **B1 (`overrides` de `effect@3.22.5`):** confirmado por el usuario usar `"overrides": { "effect": "3.22.5" }` en lugar de exentar el gate o usar `prisma@8.0.0-rc.*`.
- **B3 (evidencia de correo verificado):** confirmado exigir *Confirm email* habilitado en Supabase Auth; `autenticacionPreRegistro` acepta solo `payload.email` top-level, rechaza `email_verified === false` o `is_anonymous === true` e ignora `user_metadata`.
- **B5 + Directorio LFPDPPP:** confirmado filtrar `GET /cotos/{cotoId}/miembros` a miembros activos, devolver campos de usuario nulos al desactivar en `PATCH` (ya que RLS oculta `usuarios` sin membresías activas), y restringir `email`/`telefono` en el directorio a `app.cotos_finanzas()` para no exponer datos de contacto a `coto_comite`.
- **B6 (`Idempotency-Key`):** agregado a `invitaciones_miembro` y `soporte_accesos` usando `SAVEPOINT` en `conIdempotencia`; confirmado por el usuario mantener `409` por llave natural en `cotos`, `sectores` y `unidades`.
- **M1 (TTL de caché):** TTL de 60 s en `crearResolvedorUsuario` combinado con validación de `usuarios.activo` en `_cotos`, `_unidades`, `_orgs` y `usuario_por_auth`.
- **Sin tope de cotos por tier en `POST /orgs/{orgId}/cotos`:** confirmado por el dueño del producto; el modelo mayorista cobra por unidades activas.
- **MFA (`aal2`) en `app._orgs` y `orgs_owner()`:** aplicado a escrituras organizacionales cuando `organizaciones.exigir_mfa = true`.

## Cómo probarlo

```bash
npm run db:generate
npm run check
npm run test:security
npm audit --omit=dev --audit-level=high
# Contra Docker o TEST_DIRECT_DATABASE_URL (Postgres 17):
npm run test:e2e
```

## Verificaciones que corrí

- `npm run format` (`biome check --write .`): OK, 95 archivos revisados.
- `npm run db:generate`: OK (Prisma Client 7.10.1 generado).
- `npx biome ci .`: OK (95 archivos revisados, 0 errores, 0 advertencias).
- `npx turbo run typecheck test --force`: OK, 13/13 tareas exitosas (0 caché), **61** pruebas unitarias/RLS en verde (`@admcotos/api` 35, `@admcotos/db` 16, `@admcotos/worker` 4, `@admcotos/notifications` 3, `@admcotos/security` 3). También compiló `apps/api/test/e2e/*.test.ts` en `typecheck`.
- `npm audit --omit=dev --audit-level=high`: OK, salida 0 (`found 0 vulnerabilities`).
- `npm run test:e2e` y `npm run db:migrate:deploy` contra Postgres 17 real: no ejecutados localmente porque Docker Desktop está detenido en este equipo (quedan cubiertos por los jobs `migraciones-postgres` y `e2e` en CI).

## modern-web-guidance

- `passkeys` y `passkey-authentication`: consultados para el flujo de MFA del staff (`aal2` exigido en BD para escrituras administrativas cuando `exigir_mfa = true`).
- `verify-email-ownership`: consultado; se descartó el *Origin Trial* `tmp-email-verification` por confirmación del usuario en favor de token aleatorio enviado por correo (`#token=`) y `payload.email` confirmado por Supabase Auth.

## Dependencias nuevas

- `jose@6.2.18` (`apps/api`): verificación JWT JWKS (`ES256`/`RS256`).
- `rate-limiter-flexible@11.6.1` (`apps/api`): limitación de tasa distribuida sobre Redis.
- `ioredis@6.1.0` (`apps/api`): cliente Redis (misma versión que `apps/worker`).
- `bullmq@6.7.10` (`apps/api`): cola de correos (misma versión que `apps/worker`).
- `csv-parse@7.0.3` (`apps/api`): parseo streaming de CSV en `unidades/importar`.
- `resend@6.40.1` (`packages/notifications`): transporte Resend.
- `@testcontainers/postgresql@12.2.2` (`apps/api`, `devDependencies`): Postgres 17 efímero para E2E locales.

## Respuesta al dictamen

- **B1 (`effect` vulnerable):** agregado `"overrides": { "effect": "3.22.5" }` en `package.json:31-33` y regenerado `package-lock.json`; `npm audit --omit=dev --audit-level=high` devuelve 0 vulnerabilidades y `db:generate`/`check` pasan.
- **B2 (Redis colgado):** separadas las conexiones Redis *fail-fast* (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `connectTimeout: 500`, `commandTimeout: 500`) en `apps/api/src/lib/redis.ts:8-33`, `rejectIfRedisNotReady: true` en `apps/api/src/middleware/rate-limit.ts:83-89`, y guarda `status !== 'ready'` + timeout `800 ms` en `encolarCorreo` (`apps/api/src/lib/redis.ts:34-56`); probado contra puerto cerrado real en `< 1 s` en `apps/api/test/rate-limit.test.ts:67-90`.
- **B3 (`user_metadata`):** eliminada toda lectura de `user_metadata` en `apps/api/src/middleware/auth.ts:91-106`, confiando solo en `payload.email` top-level y rechazando `is_anonymous === true` o `email_verified === false`; probado en `apps/api/test/auth.test.ts:145-204` y `apps/api/test/invitaciones.test.ts:214-253`.
- **B4 (`audit_outbox.usuario_id` en pre-registro):** añadido `signPreAuthContext` (`auth.<auth_uuid>...`) en `packages/security/src/tenant-context.ts:44-47` (`security.test.ts:57-58`), `withPreAuthTenant` en `packages/db/src/index.ts:51-64`, `conTenantPreRegistro` en `apps/api/src/lib/tenant.ts:36-43`, y en `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:30-66,259-272,320-347` `app.auth_uid()` valida `p_auth` y re-firma `app.ctx` con `v_usuario_id` antes de modificar tablas auditadas; afirmado en `packages/db/test/rls.test.ts:510-555` y `apps/api/test/e2e/identidad.test.ts:151-156`.
- **B5 (desactivación de miembros sin 500):** `listar` filtra `{ cotoId, activo: true }` y `actualizar` desacopla `usuario` del `update()` para devolver campos nulos cuando `activo = false` (`apps/api/src/modules/miembros/service.ts:56-78,101-126`, `schemas.ts:29-33`); adicionalmente se restringe `email`/`telefono` en el directorio a `app.cotos_finanzas()` (`service.ts:50-53,74`), probado en `apps/api/test/miembros.test.ts:86-150` y `apps/api/test/e2e/identidad.test.ts:283-317`.
- **B6 (`Idempotency-Key`):** agregada columna única `clave_idempotencia` a `soporte_accesos` e `invitaciones_miembro` en `packages/db/prisma/schema.prisma:48,374` y `migration.sql:141-145,156,171,251`; helpers `extraerIdempotencyKey` y `conIdempotencia` (`SAVEPOINT`) en `apps/api/src/lib/prisma.ts:23-60`; conectados en `invitaciones` (`routes.ts:18-20,46,114-121`, `service.ts:64-96`) y `orgs/soporte` (`routes.ts:18-20,96,133-138`, `service.ts:154-178`); pruebas en `apps/api/test/invitaciones.test.ts:70-139`, `apps/api/test/orgs.test.ts:225-275` y `apps/api/test/e2e/identidad.test.ts:90-118,250-274`.
- **B7 (escenarios RLS de `invitaciones_miembro`):** agregados escenarios de `sel`, `aal1` vs `aal2`, `coto_activo`, residente/guardia/otro despacho, `upd` denegado a otro despacho o sin MFA, rama `coto_id IS NULL` (`org_owner` vs `org_admin` vs `aal1`), invitación ya aceptada con otro `auth_id` (`UA409`) y rechazo de re-revocación/des-revocación en `packages/db/test/rls.test.ts:451-679`.
- **M1 (caché de usuarios):** agregado TTL de 60 s en `crearResolvedorUsuario` (`apps/api/src/middleware/auth.ts:15-43`, `test/auth.test.ts:122-143`) y filtro `usuarios.activo` en `_cotos`, `_unidades`, `_orgs`, `auth_uid` y `usuario_por_auth` (`migration.sql:52,73,104,110,136`, `rls.test.ts:680-683`).
- **M2 (token en fragmento y retención BullMQ):** URL cambiada a `#token=` en `apps/api/src/modules/invitaciones/service.ts:109` (`invitaciones.test.ts:122`, `e2e/identidad.test.ts:120-122`); `OPCIONES_JOB_CORREO` ajustado a `removeOnComplete: true, removeOnFail: { age: 3_600 }` en `packages/shared/src/colas.ts:14-19`.
- **M3 (idempotencia en Resend):** agregado `jobId: inv:<id>` en `invitaciones/service.ts:102`, propagación en `apps/api/src/lib/redis.ts:41-44`, parámetro `idempotencyKey` en `packages/notifications/src/correo.ts:14,22,118-128` y envío de `job.id` desde `apps/worker/src/processors/correo.ts:20`; probado en `packages/notifications/test/correo.test.ts:20-58` y `apps/worker/test/correo.test.ts:31-56`.
- **M4 (CSV fuera de transacción):** `parsearCsvUnidades` lee y valida sintaxis del stream HTTP antes de abrir `conTenant` (`apps/api/src/modules/unidades/routes.ts:97-101`, `service.ts:102-243`).
- **M5 (`Monto` en `CotoResumen`):** migrado a `Monto` en `apps/api/src/modules/orgs/schemas.ts:91-94` con `formatearMontoDecimal` a 2 decimales en `orgs/service.ts:58-63,125-128` y aserciones en `apps/api/test/orgs.test.ts:149-153,205-207`.
- **M6 (`Location` en `/soporte`):** eliminado el encabezado `Location` inexistente en `apps/api/src/modules/orgs/routes.ts:138` (`orgs.test.ts:264`).
- **M7 (`TipoSectorUnidadOrTipo`):** eliminado el helper y usado `TipoUnidad.optional()` directamente en `apps/api/src/modules/unidades/schemas.ts:45`.
- **M8 (índices FK en `invitaciones_miembro`):** agregados `invitaciones_miembro_unidad_id_idx` e `invitaciones_miembro_creada_por_idx` en `packages/db/prisma/schema.prisma:388-389` y `migration.sql:174-175`.
- **M9 (endurecimiento `invitaciones_miembro`):** política `upd` exige `aceptada_en IS NULL AND revocada_en IS NULL` y `WITH CHECK revocada_en IS NOT NULL` (`migration.sql:195-210`, `rls.test.ts:579-584,632-637`), `tg_invitacion_defaults` fuerza `NEW.created_at := now()` en `INSERT` desde `app_service` (`migration.sql:228-243`) y `invitaciones/service.ts:65-67` descuenta 60 s cuando `diasVigencia === 7`.
- **M10 (`plan_fases_backend.md`):** actualizada la tabla de `POST /orgs/{orgId}/cotos`, `Idempotency-Key` en invitaciones/soporte, minimización de directorio y la lista de terminado en `plan_fases_backend.md:585,590-593,612`.
- **M11 (límite por IP previo a BD):** separado `limiteTasaPorIp` (antes de `autenticacion`/`autenticacionPreRegistro`) y `limiteTasaPorUsuario` (después) en `apps/api/src/middleware/rate-limit.ts:116-154` y `apps/api/src/app.ts:39-53`; probado en `apps/api/test/rate-limit.test.ts:92-142`.

## Pendientes y dudas

- Ejecutar en CI (o localmente con Docker activo) los jobs `migraciones-postgres` y `e2e` (`npm run test:e2e`) contra PostgreSQL 17 real.
- Documentar en `AGENTS.md` (regla 1) la excepción explícita de `app.usuario_por_auth` previa a `withTenant` (`apps/api/src/middleware/auth.ts:35`), señalada en el dictamen (*Para el usuario*), si el equipo desea reflejarla allí.
- Retirar `"overrides": { "effect": "3.22.5" }` del `package.json` raíz cuando Prisma publique una versión estable que actualice `effect`.
