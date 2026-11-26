# Entrega: feat/f1-identidad

Tarea: Fase 1 — Identidad, MFA, tenancy y núcleo organizacional (`plan_fases_backend.md` §5)
Ronda: 3

## Qué cambió

### Base de datos, contexto y seguridad
- `packages/security/src/tenant-context.ts`: formato v2 de `signDbContext` (`<uuid>.<aal1|aal2>.<exp>.<hmac>`) y `signPreAuthContext` (`auth.<auth_uuid>.<aal1|aal2>.<exp>.<hmac>`).
- `packages/security/test/security.test.ts`: verifica `signDbContext` v2 y `signPreAuthContext`.
- `packages/db/src/index.ts`: agrega `aal` a `DbContext` y `withPreAuthTenant` para transacciones de pre-registro.
- `packages/db/prisma/schema.prisma`: `organizaciones.exigir_mfa`, `clave_idempotencia` en `SoporteAcceso` e `InvitacionMiembro`, e índices FK en `invitaciones_miembro(unidad_id, creada_por)`.
- `packages/db/prisma/migrations/20261126000200_identidad/migration.sql`:
  - `organizaciones.exigir_mfa`, `app.uid()` v2, `app.auth_uid()`, `app.aal()`, filtro `usuarios.activo` en `_cotos`/`_unidades`/`_orgs`/`usuario_por_auth`, y exigencia de `aal2` en `_cotos`, `_orgs` y `orgs_owner()`.
  - `soporte_accesos.clave_idempotencia` única e inmutable.
  - `invitaciones_miembro` con RLS, política `upd` endurecida, privilegio mínimo `UPDATE (revocada_en)`, y trigger `tg_invitacion_defaults` usando `coalesce(nullif(current_setting('role', true), 'none'), session_user) = 'app_service'` para forzar `created_at := now()` en `INSERT`.
  - Restricción LFPDPPP en BD: política `sel` de `usuarios` acotada a `app.cotos_finanzas()` (excluyendo `coto_comite`) y función `app.directorio_coto(p_coto, p_limite, p_cursor)` (`SECURITY DEFINER`, `SET search_path` fijo) que exige `cotos_staff()`, respeta `coto_activo()`, pagina por cursor y enmascara `email`/`telefono` a `NULL` salvo para `cotos_finanzas()`.
  - `app.aceptar_invitacion` (re-firma `app.ctx` con `usuarios.id` antes de modificar tablas auditadas) y `app.mis_membresias()`.
  - Convención `UA4xx` en `generar_cargos`, `aplicar_pago`, `validar_acceso`, `votar` y `guardar_csd`.
- `packages/db/test/rls.test.ts`: escenarios completos de MFA v2, políticas RLS de `invitaciones_miembro`, ajuste forzado de `created_at` por `tg_invitacion_defaults`, actor real en `audit_outbox`, restricción de `usuarios` al comité y `app.directorio_coto` (LFPDPPP, paginación, `coto_activo`, `UA403`).

### Dependencias, colas, notificaciones y worker
- `package.json` y `package-lock.json`: `"overrides": { "effect": "3.22.5" }` (`GHSA-7589-6fvf-x4pw`).
- `packages/shared/src/colas.ts` y `packages/shared/src/index.ts`: contrato `Colas.correo`, `OPCIONES_JOB_CORREO` (`removeOnComplete: true`, `removeOnFail: { age: 3_600 }`) y `errors` opcional en `AppError`.
- `packages/notifications/src/correo.ts` y `test/correo.test.ts`: envío con Resend, `idempotencyKey`, escape HTML y sanitización de URLs.
- `apps/worker/src/processors/correo.ts` y `test/correo.test.ts`: cola `correo` pasando `idempotencyKey: job.id` a Resend, validación Zod y logs sin PII.

### API HTTP, Redis, middleware, módulos y pruebas
- `apps/api/src/lib/redis.ts` y `apps/api/src/main.ts`: conexiones ioredis separadas *fail-fast* (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, timeouts cortos) para rate limit y cola `correo`.
- `apps/api/src/middleware/rate-limit.ts`, `apps/api/src/app.ts` y `test/rate-limit.test.ts`: `rejectIfRedisNotReady: true`, límite por IP previo a BD (`limiteTasaPorIp`) y por usuario posterior (`limiteTasaPorUsuario`), Cloudflare `BlockList` y prueba contra puerto cerrado real (`< 1 s`).
- `apps/api/src/middleware/auth.ts` y `test/auth.test.ts`: JWT `ES256`/`RS256` vía JWKS, caché con TTL de 60 s en `crearResolvedorUsuario`, y `autenticacionPreRegistro` basado solo en `payload.email` top-level (nunca `user_metadata`).
- `apps/api/src/lib/{openapi,prisma,tenant}.ts`: `IdempotencyHeader` único compartido en `openapi.ts`, `conIdempotencia` (`SAVEPOINT`) sin `extraerIdempotencyKey` redundante en `prisma.ts`, y `conTenant`/`conTenantPreRegistro`.
- `apps/api/src/modules/{me,invitaciones,orgs,cotos,sectores,unidades,miembros}/`:
  - `invitaciones/routes.ts`: encola el correo con `deps.encolarCorreo` **dentro** de `conTenant` antes del *commit* para revertir la transacción y la `clave_idempotencia` ante un `503`; usa `IdempotencyHeader` tipado y enlace `#token=`.
  - `orgs`: `CotoResumen` con `Monto` exacto, `Idempotency-Key` en `/soporte` sin encabezado `Location` inexistente.
  - `unidades`: parseo CSV fuera de transacción y limpieza de esquema.
  - `miembros/service.ts`: `listar` consulta directamente `app.directorio_coto(...)` en Postgres y `actualizar` desacopla `usuario` cuando `activo = false`.
- Pruebas unitarias en `apps/api/test/*.test.ts` (incluye prueba de rollback transaccional ante fallo `503` del encolador y reintento idempotente) y E2E en `apps/api/test/e2e/{setup,identidad}.test.ts` + `.github/workflows/ci.yml`.
- `plan_fases_backend.md`: avance actualizado.

## Decisiones

- **B1 (encolado antes del commit):** en `POST /cotos/{cotoId}/invitaciones`, `deps.encolarCorreo` corre dentro de `conTenant` antes de cerrar la transacción (timeout de cola `800 ms` ≪ timeout de transacción `5 000 ms`). Si Redis cae (`503`), la transacción hace *rollback* completo: ni `invitaciones_miembro` ni `clave_idempotencia` quedan guardados y un reintento posterior con la misma `Idempotency-Key` crea la invitación (`201`) y encola exactamente un correo.
- **M1 (`tg_invitacion_defaults` bajo `SECURITY DEFINER`):** se evalúa `coalesce(nullif(current_setting('role', true), 'none'), session_user) = 'app_service'`, cubriendo tanto conexiones directas como `SET LOCAL ROLE app_service`.
- **M2 (LFPDPPP en BD):** se restringe la política `sel` de `usuarios` a `app.cotos_finanzas()` y se concentra la lectura del directorio en `app.directorio_coto(...)` (`SECURITY DEFINER`), garantizando en Postgres que el comité reciba solo nombre/rol/unidad con `email`/`telefono = NULL`.
- **M3 (`IdempotencyHeader` único):** se centraliza el esquema de cabecera en `apps/api/src/lib/openapi.ts` y los handlers consumen `c.req.valid('header')['idempotency-key']?.toLowerCase()`.

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
- `npx biome ci .`: OK (95 archivos revisados, 0 errores, 0 advertencias).
- `npx turbo run typecheck test --force`: OK, 13/13 tareas exitosas (0 caché), **62** pruebas unitarias/RLS en verde (`@admcotos/api` 36, `@admcotos/db` 16, `@admcotos/worker` 4, `@admcotos/notifications` 3, `@admcotos/security` 3). `typecheck` compiló también `apps/api/test/e2e/*.test.ts`.
- `npm audit --omit=dev --audit-level=high`: OK, salida 0 (`found 0 vulnerabilities`).
- `npm run test:e2e` y `npm run db:migrate:deploy` contra Postgres 17 real: no ejecutados localmente porque Docker Desktop está detenido en este equipo (pendientes de CI `migraciones-postgres` y `e2e`).

## modern-web-guidance

- `passkeys` y `passkey-authentication`: consultados para el flujo MFA (`aal2` exigido en BD para escrituras administrativas cuando `exigir_mfa = true`).
- `verify-email-ownership`: consultado; se descartó el *Origin Trial* `tmp-email-verification` en favor de token aleatorio enviado por correo (`#token=`) y `payload.email` confirmado en Supabase Auth.

## Dependencias nuevas

- `jose@6.2.18` (`apps/api`): verificación JWT JWKS (`ES256`/`RS256`).
- `rate-limiter-flexible@11.6.1` (`apps/api`): limitación de tasa distribuida sobre Redis.
- `ioredis@6.1.0` (`apps/api`): cliente Redis (misma versión que `apps/worker`).
- `bullmq@6.7.10` (`apps/api`): cola de correos (misma versión que `apps/worker`).
- `csv-parse@7.0.3` (`apps/api`): parseo streaming de CSV en `unidades/importar`.
- `resend@6.40.1` (`packages/notifications`): transporte Resend.
- `@testcontainers/postgresql@12.2.2` (`apps/api`, `devDependencies`): Postgres 17 efímero para E2E locales.

## Respuesta al dictamen

- **B1 (`encolarCorreo` post-commit en invitaciones):** `apps/api/src/modules/invitaciones/routes.ts:111-124` ejecuta `deps.encolarCorreo` dentro de `conTenant` antes del *commit*; si falla con `503`, Postgres revierte la transacción y no persiste `clave_idempotencia`. Probado en `apps/api/test/invitaciones.test.ts:255-356` (fallo `503` con rollback -> reintento `201` con 1 correo -> reintento `200` sin duplicar) y en `apps/api/test/e2e/setup.ts:169-184,201-203` + `apps/api/test/e2e/identidad.test.ts:93-135`.
- **M1 (`tg_invitacion_defaults` con `SECURITY DEFINER`):** `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:233-236` valida `coalesce(nullif(current_setting('role', true), 'none'), session_user) = 'app_service'` para forzar `NEW.created_at := now()`. Probado en `packages/db/test/rls.test.ts:479-497` con rechazo por `invitaciones_miembro_exp_ck` (`+395d`) y reajuste a `now()` (`-10d`).
- **M2 (minimización LFPDPPP en Postgres):** `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:355-430` reemplaza la política `sel` de `usuarios` para limitar al staff hacia `cotos_finanzas()` (excluyendo comité) y agrega `app.directorio_coto` (`SECURITY DEFINER`) con paginación por cursor y enmascarado de `email`/`telefono` a `NULL` fuera de `cotos_finanzas()`. `apps/api/src/modules/miembros/service.ts:73-89` delega `listar` en esa función; probado en `packages/db/test/rls.test.ts:705-734` y `apps/api/test/miembros.test.ts:117-167`.
- **M3 (`IdempotencyHeader` duplicado y `extraerIdempotencyKey`):** unificado `IdempotencyHeader` en `apps/api/src/lib/openapi.ts:26-28`, eliminada `extraerIdempotencyKey` de `apps/api/src/lib/prisma.ts:1-4`, y leída directamente desde `c.req.valid('header')['idempotency-key']?.toLowerCase()` en `apps/api/src/modules/invitaciones/routes.ts:109` y `apps/api/src/modules/orgs/routes.ts:128` (`apps/api/test/orgs.test.ts:258-263`).

## Pendientes y dudas

- Confirmación explícita del usuario sobre las decisiones operativas listadas en el dictamen (`overrides` de `effect@3.22.5`, *Confirm email* y sin sesiones anónimas en Supabase, `409` por llave natural en cotos/sectores/unidades, minimización para comité en BD y ausencia de tope de cotos por tier).
- Declarar en `AGENTS.md` (regla 1) la excepción de `app.usuario_por_auth` previa a `withTenant` (`apps/api/src/middleware/auth.ts:35`), si el equipo decide incorporarla.
- Ejecutar en CI (o localmente con Docker activo) `migraciones-postgres` y `npm run test:e2e` contra PostgreSQL 17 real.
