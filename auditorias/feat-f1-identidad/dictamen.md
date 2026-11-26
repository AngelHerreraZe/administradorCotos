# Dictamen: feat/f1-identidad

Veredicto: CAMBIOS
Commit auditado: 5f2fda0120feaef00b5adcf8b33957478523995e
Base: 27e585944582fbf1ed6d6f09cf66c3c9d384dd15
Ronda: 2
Fecha: 2026-11-26

## Verificaciones
| Gate | Resultado |
| :--- | :--- |
| `npm ci` (cambió `package-lock.json`) | ✅ instalación limpia |
| `npm run db:generate` (cambió `schema.prisma`) | ✅ Prisma Client 7.10.1 |
| `npm run check` | ✅ Biome: 95 archivos, 0 errores. 13/13 tareas. 61 pruebas: api 35, db/RLS 16, worker 4, notifications 3, security 3 |
| `npm audit --omit=dev --audit-level=high` | ✅ 0 vulnerabilidades |
| Migraciones en Postgres real | Pendiente de CI (`migraciones-postgres`) |
| E2E (`npm run test:e2e`) | Pendiente de CI (`e2e`): Docker no está disponible en este equipo. La idempotencia con `SAVEPOINT` y el `PATCH` de miembros solo se prueban ahí: las pruebas unitarias simulan `tx` |
| Comprobaciones adicionales del auditor | Scripts desechables fuera del repo: con Redis inalcanzable, `crearRecursosRedis` rechaza `consumir()` en 1 ms y `encolarCorreo` en 0 ms (503). En PGlite, la auditoría de `aceptar_invitacion` registra el `usuarios.id` real; el directorio solo con activos ya no pierde filas de `usuarios`; y una invitación insertada como `app_service` con `created_at` futuro se guarda tal cual (ver M1) |

La migración `20261126000200_identidad` se volvió a editar, pero no existe en `main` (aparece como `A` respecto a la base), así que no se viola la regla 14.

## Hallazgos

### B1 · BLOQUEANTE · `apps/api/src/modules/invitaciones/routes.ts:116-123`
La combinación de los arreglos de B2 y B6 de la ronda anterior puede perder invitaciones en silencio. La invitación se confirma en BD (`conTenant`, línea 116) y el correo se encola **después** del commit (línea 123). Si Redis no responde, `encolarCorreo` ahora falla rápido con `503`, que es lo correcto, pero la fila ya quedó guardada con su `clave_idempotencia` y el token en claro, que solo existía en memoria, se perdió. Cuando el cliente reintenta con la misma `Idempotency-Key` (justo el uso para el que existe), `conIdempotencia` encuentra la fila y responde **`200`** sin encolar nada. El cliente cree que la invitación salió, pero el correo nunca se envía y nadie puede aceptarla. Esto rompe la garantía de la regla 9: un reintento debe completar la operación, no confirmar una a medias.
**Resuelto cuando:** si falla el encolado, una invitación no puede quedar confirmada en BD. Por ejemplo, encolando dentro de la transacción, antes del commit, para que el error la revierta. Gemini elige el mecanismo. Debe haber una prueba en la que `encolarCorreo` falla en la primera llamada y funciona en la segunda: el reintento con la misma `Idempotency-Key` deja exactamente un correo encolado para una invitación válida.

### M1 · MENOR · `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:233`
`tg_invitacion_defaults` es `SECURITY DEFINER`, y dentro de esa función `current_user` es el **dueño** de la función, nunca `app_service`. Por eso la condición `current_user = 'app_service'` jamás se cumple y `created_at` no se fuerza a `now()`. Reproducido en PGlite: como `app_service` se insertó una invitación con `created_at = now() + 395 días` y `expira_en = now() + 400 días`, y el `CHECK` de 7 días la aceptó. Es el punto (b) de M9 de la ronda anterior, que la entrega da por resuelto. La API no lo explota, pero la regla de BD no protege nada.
**Resuelto cuando:** un escenario de `rls.test.ts` que inserta como `app_service` con `created_at` en el pasado o el futuro obtiene `created_at = now()` (o un rechazo). Pistas: `current_setting('role')` o `session_user` sí reflejan quién llama dentro de una función `DEFINER`.

### M2 · MENOR · `apps/api/src/modules/miembros/service.ts:50-53,74`
La restricción "el comité no ve correo ni teléfono" existe solo en la API: la política `sel` de `usuarios` sigue entregando esas columnas a cualquier `cotos_staff`. La regla 4 de AGENTS.md pide que la autorización viva en Postgres. Hoy funciona porque ningún otro endpoint expone `usuarios` al comité, pero un endpoint futuro filtraría esos datos. Si la regla de minimización es definitiva, conviene llevarla a BD (función `DEFINER` o vista que devuelva el contacto solo a `cotos_finanzas`). Ver *Para el usuario*.

### M3 · MENOR · `apps/api/src/lib/prisma.ts:23` · `apps/api/src/modules/invitaciones/routes.ts:114` · `apps/api/src/modules/orgs/routes.ts:133`
`IdempotencyHeader` ya valida el encabezado con Zod en `createRoute`, pero el handler vuelve a leer el encabezado crudo y a validarlo con `extraerIdempotencyKey`. Basta con `c.req.valid('header')['idempotency-key']`, con lo que la función sobra. Además, `IdempotencyHeader` está duplicado en los dos `routes.ts`.

## Ronda anterior
- **B1 (`npm audit`):** resuelto. `"overrides": { "effect": "3.22.5" }` en `package.json:31`; el gate da 0 vulnerabilidades.
- **B2 (Redis colgado):** resuelto. Conexiones *fail-fast* separadas (`apps/api/src/lib/redis.ts`) y `rejectIfRedisNotReady: true`. Verificado: rechazos en 0–1 ms.
- **B3 (`user_metadata`):** resuelto. `apps/api/src/middleware/auth.ts:100` ya no lee `user_metadata`; la evidencia es la configuración *Confirm email* de Supabase, documentada en `.env.example`.
- **B4 (actor de auditoría):** resuelto. Contexto pre-auth firmado, `app.auth_uid()` ligado a `p_auth` y nueva firma con el `usuarios.id` (`migration.sql:327`). Verificado en PGlite y afirmado en `rls.test.ts`.
- **B5 (directorio con inactivos):** resuelto. Listado solo con activos y `PATCH` sin relación requerida (`miembros/service.ts:56-57,101-125`). Verificado del lado de BD; el flujo HTTP queda pendiente de E2E en CI.
- **B6 (`Idempotency-Key`):** implementado en invitaciones y soporte con `clave_idempotencia` única, pero su interacción con el encolado introduce el B1 de esta ronda.
- **B7 (escenarios RLS):** resuelto (`rls.test.ts:438-683`): `sel`, `aal1`, `coto_activo`, otro despacho, `upd`, rama de despacho, `UA409` y no des-revocar.
- **M1 (caché):** resuelto. TTL de 60 s y `usuarios.activo` en `_cotos`, `_unidades` y `_orgs`.
- **M2 (token y retención):** resuelto. `#token=` y `removeOnComplete: true`, `removeOnFail: { age: 3_600 }`.
- **M3 (Resend):** resuelto. `idempotencyKey: job.id`.
- **M4 (CSV en transacción):** resuelto. `parsearCsvUnidades` corre antes de `conTenant`.
- **M5 (`Monto`):** resuelto.
- **M6 (`Location`):** resuelto.
- **M7 (helper):** resuelto.
- **M8 (índices FK):** resuelto.
- **M9 (endurecimiento de invitaciones):** parcial. La política `upd` ya impide des-revocar y revocar aceptadas; el `created_at` sigue sin forzarse (M1 de esta ronda).
- **M10 (plan):** resuelto.
- **M11 (límite por IP antes de autenticar):** resuelto.

## Para el usuario
- **Decisiones que la entrega atribuye al usuario.** Confirma que son tuyas; un agente no puede tomarlas:
  - el `overrides` de `effect@3.22.5`, a retirar cuando Prisma estable lo actualice;
  - exigir *Confirm email* y desactivar sesiones anónimas en Supabase: la seguridad de `POST /invitaciones/aceptar` depende de esa configuración, que vive fuera del repo;
  - aceptar el `409` por llave natural como idempotencia en cotos, sectores y unidades;
  - ocultar correo y teléfono al comité (y si se quiere en BD: M2);
  - ningún tope de cotos por tier.
- **AGENTS.md regla 1:** sigue pendiente declarar la excepción de `app.usuario_por_auth`, que se consulta fuera de `withTenant` antes de firmar el contexto (`apps/api/src/middleware/auth.ts:35`).
- **E2E y `migraciones-postgres`:** no se ejecutaron por falta de Docker; CI debe quedar en verde antes del merge.
