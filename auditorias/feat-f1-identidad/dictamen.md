# Dictamen: feat/f1-identidad

Veredicto: CAMBIOS
Commit auditado: 8d5d376aab0389980c0c432805a78b0fef9645d0
Base: 27e585944582fbf1ed6d6f09cf66c3c9d384dd15
Ronda: 1
Fecha: 2026-11-26

## Verificaciones
| Gate | Resultado |
| :--- | :--- |
| `npm ci` (cambió `package-lock.json`) | ✅ instalación limpia |
| `npm run db:generate` (cambió `schema.prisma`) | ✅ Prisma Client 7.10.1 |
| `npm run check` | ✅ Biome: 94 archivos, 0 errores. 13/13 tareas. 59 pruebas: api 33, db/RLS 16, worker 4, notifications 3, security 3 |
| `npm audit --omit=dev --audit-level=high` | ❌ salida 1: 3 altas (`effect` ≤ 3.22.0, GHSA-7589-6fvf-x4pw, vía `@prisma/config@7.10.1` → `prisma@7.10.1`). Ya estaba en `main` (`27e5859`) |
| Migraciones en Postgres real | Pendiente de CI (`migraciones-postgres`) |
| E2E (`npm run test:e2e`) | Pendiente de CI (`e2e`): Docker no está disponible en este equipo |
| Comprobaciones adicionales del auditor | Scripts desechables fuera del repo: Redis caído con la configuración de `main.ts` deja `consume()` pendiente después de 8 s; en PGlite, un miembro desactivado deja de ser visible para el staff y `aceptar_invitacion` deja el `auth_id` como `usuario_id` en `audit_outbox` |

Además se verificó que las funciones reescritas (`generar_cargos`, `aplicar_pago`, `validar_acceso`, `votar`, `guardar_csd`) sean idénticas a las de `seguridad_rls`. Solo cambian los `ERRCODE` a `UA4xx`. Ninguna migración previa se modificó. `security.ts` no se tocó. Las dependencias nuevas usan la última versión estable, con versión exacta y en el workspace correcto.

## Hallazgos

### B1 · BLOQUEANTE · `package-lock.json:3864`
El gate `npm audit --omit=dev --audit-level=high` está en rojo. `@prisma/config@7.10.1` fija `effect` en `3.20.0`, que es vulnerable a GHSA-7589-6fvf-x4pw (ReDoS). La vulnerabilidad ya existía desde la Fase 0, así que Gemini no la introdujo, pero un gate en rojo impide aprobar. Sí existen versiones parcheadas en la rama 3.x (`effect@3.22.5`).
**Resuelto cuando:** `npm audit --omit=dev --audit-level=high` termina con salida 0, por ejemplo con `"overrides": { "effect": "3.22.5" }` en el `package.json` raíz, y `db:generate`, `check` y `db:migrate:deploy` siguen funcionando. La otra salida es que el usuario documente una excepción explícita (ver *Para el usuario*).

### B2 · BLOQUEANTE · `apps/api/src/main.ts:19` · `apps/api/src/middleware/rate-limit.ts:182`
Si Redis cae, la API entera se queda colgada. El limitador y la cola comparten una conexión ioredis con `maxRetriesPerRequest: null` y la cola *offline* activa, así que `RateLimiterRedis.consume()` nunca resuelve ni rechaza: se reprodujo con la misma configuración contra un puerto sin Redis y la promesa seguía pendiente a los 8 s. Por eso el `catch` de `limiteTasaGeneral` nunca corre. No hay "falla abierto" en la API general ni `503` en las rutas críticas, como exige §3.8 del plan: toda petición autenticada espera indefinidamente. `colaCorreo.add` (`main.ts:30`) tiene el mismo problema en `POST /cotos/{id}/invitaciones`. La prueba `rate-limit.test.ts:62` no lo detecta porque su Redis falso lanza el error de inmediato.
**Resuelto cuando:** con Redis inalcanzable, una ruta general responde normalmente y una ruta con `falloCerrado` responde `503` en un tiempo acotado (≤ 1 s). Opciones: una conexión propia para el limitador con `enableOfflineQueue: false` o `rejectIfRedisNotReady: true`, y un productor de cola que falle rápido. Debe haber una prueba que reproduzca un Redis no listo, no solo uno que lanza errores.

### B3 · BLOQUEANTE · `apps/api/src/middleware/auth.ts:89-93`
`autenticacionPreRegistro` acepta `user_metadata.email_verified === true` como prueba de que el correo está verificado. En Supabase, `user_metadata` lo edita la propia persona (`supabase.auth.updateUser({ data })`), y Supabase advierte que no se use para autorizar. Ese control, el único que distingue "correo verificado" en `POST /invitaciones/aceptar`, queda en manos del cliente.
**Resuelto cuando:** ninguna decisión de seguridad depende de `user_metadata`. La verificación se apoya en algo que la persona no puede alterar (qué claim o configuración de Supabase usar lo decide el usuario). Una prueba demuestra que un JWT con solo `user_metadata.email_verified: true` es rechazado.

### B4 · BLOQUEANTE · `apps/api/src/lib/tenant.ts:41` · `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:188`
`conTenantPreRegistro` firma el `authId` como si fuera el `userId` del contexto. Dentro de `app.aceptar_invitacion`, `app.uid()` devuelve entonces el `auth_id`, y `tg_auditar` lo escribe en `audit_outbox.usuario_id`. Reproducido en PGlite: `miembros_coto.insert` e `invitaciones_miembro.update` quedan con `usuario_id = <auth_id>` y no con el `usuarios.id` creado. `audit_log` es inmutable y está encadenado con HMAC, así que el actor queda mal registrado para siempre y no se puede unir con `usuarios`. Las pruebas de `rls.test.ts:488-500` llaman la función con `como(null, …)`, sin el contexto que usa la API, y por eso no lo detectan.
**Resuelto cuando:** tras aceptar una invitación, las filas de auditoría tienen `usuario_id` igual al `usuarios.id` resultante (o `NULL`, si así se decide de forma explícita), y un escenario en `rls.test.ts` lo afirma con el mismo contexto que firma la API. Ya que se toca este flujo: hoy cualquier llamador `app_service` puede pasar cualquier `p_auth`/`p_email`. Conviene que la BD ligue `p_auth` a la identidad firmada.

### B5 · BLOQUEANTE · `apps/api/src/modules/miembros/service.ts:15-23`
El directorio se rompe en cuanto se desactiva un miembro. La política `sel` de `usuarios` (`seguridad_rls/migration.sql:444-451`) solo muestra personas con una membresía **activa**. Reproducido en PGlite: después de `activo = false`, el admin del coto ya no ve la fila de `usuarios` de ese residente. `selectMiembro` trae `usuario` como relación requerida, así que Prisma recibe `null` y lanza un error de resultado inconsistente, que llega como `500`. Consecuencias: (a) `GET /cotos/{id}/miembros` devuelve 500 para todo el coto mientras exista un miembro inactivo sin otra membresía visible; (b) `PATCH /cotos/{id}/miembros/{id}` con `{ "activo": false }` falla al leer el resultado y la transacción se revierte, así que no se puede desactivar a nadie desde la API.
**Resuelto cuando:** una prueba contra BD real (E2E) desactiva un miembro, el `PATCH` responde `200` y luego `GET …/miembros` responde `200`. La forma (filtrar activos, relación opcional o ajustar la política) la elige Gemini. Si implica ver datos de personas inactivas, lo decide el usuario.

### B6 · BLOQUEANTE · `apps/api/src/modules/invitaciones/routes.ts:321-330` · `apps/api/src/modules/orgs/routes.ts:262-268`
Ninguna creación acepta `Idempotency-Key` (AGENTS.md §3 regla 9, plan §3.1 y §3.6, definición de terminado §6). Para cotos, sectores y unidades existe una llave natural única que convierte un reintento en `409`. `POST /cotos/{id}/invitaciones` y `POST /orgs/{id}/soporte` no tienen ninguna: un doble clic o un reintento de red crea dos invitaciones y **envía dos correos**, o abre dos ventanas de soporte. `invitaciones_miembro` es una tabla nueva de esta misma migración y pudo nacer con `clave_idempotencia`. La entrega lo presenta como *Decisión*. Por AGENTS.md §8, una desviación de una regla va en *Pendientes y dudas* para que la resuelva la persona.
**Resuelto cuando:** al menos invitaciones y soporte aceptan `Idempotency-Key` según §3.6, con una prueba: misma llave → mismo recurso, `200` y un solo correo encolado. Si el `409` por llave natural basta para cotos, sectores y unidades, lo decide el usuario.

### B7 · BLOQUEANTE · `packages/db/test/rls.test.ts:439`
A las políticas nuevas de `invitaciones_miembro` les faltan escenarios (§6, plan §3.4 paso 4: "quién ve, quién escribe, quién no, y referencia cruzada entre cotos"). No hay pruebas de:
- **`sel`:** el admin del coto ve la invitación; el admin de otro coto u otra organización, un residente, un guardia y el staff con `aal1` no la ven.
- **`upd`:** el admin de A2 o de B1 no puede revocar una invitación de A1.
- **`coto_activo`:** con `app.coto_id` de otro coto, la invitación no se ve.
- **Rama de despacho (`coto_id IS NULL`):** `ownerA` invita `org_admin`; un `org_admin` no puede; un owner con `aal1` tampoco.
- **Invitación ya aceptada por otro `auth_id`:** `UA409 'ya fue utilizada'`.

**Resuelto cuando:** existen esos escenarios y alguno falla si se elimina o afloja la política correspondiente.

### M1 · MENOR · `apps/api/src/middleware/auth.ts:20-32`
La caché `authId → usuarioId` nunca se invalida. Si back-office desactiva a alguien (`usuarios.activo = false`), esa persona conserva acceso hasta que se reinicie el proceso, porque `_cotos` no revisa `usuarios.activo`. Sigue al plan §3.2 ("la relación no cambia"), pero `activo` sí cambia. Ver *Para el usuario*.

### M2 · MENOR · `apps/api/src/modules/invitaciones/service.ts:154` · `packages/shared/src/colas.ts:14-19`
El token de invitación viaja en la *query* (`?token=`), por lo que puede filtrarse por `Referer`, historial o logs del portal. Conviene usar el fragmento (`#token=`) o exigir `Referrer-Policy: no-referrer` y limpiar la URL en el cliente. Además, `OPCIONES_JOB_CORREO` conserva 1 000 jobs completados y 10 000 fallidos en Redis, con el correo del destinatario y el token vigente en claro hasta por 7 días. Para la cola `correo` conviene `removeOnComplete: true` o un `age` corto.

### M3 · MENOR · `apps/worker/src/processors/correo.ts:171`
El envío no es idempotente frente a Resend. Si Resend envía pero la respuesta se pierde (*timeout*), el reintento duplica el correo, contra §3.7 ("trabajo idempotente"). Resend acepta una llave de idempotencia: se puede usar `job.id`.

### M4 · MENOR · `apps/api/src/modules/unidades/routes.ts:301-304`
El CSV se lee y se parsea **dentro** de la transacción interactiva (timeout por defecto de 5 s). Una subida lenta ocupa una conexión del pool y puede vencer la transacción, lo que da un `500` sin mapear. Conviene leer y validar primero (el cuerpo ya está limitado a 1 MB) y abrir la transacción solo para insertar.

### M5 · MENOR · `apps/api/src/modules/orgs/schemas.ts` (`CotoResumen`) · `apps/api/src/modules/orgs/service.ts:96-99`
`emitidoMes`, `cobradoMes` y `adeudoVencido` son dinero, pero el contrato usa `z.string()` y no `Monto` (regla 8). `Decimal.toString()` produce `"1450.5"` mientras el valor por omisión es `"0.00"`. Conviene usar `Monto` y formatear con `Decimal#toFixed(2)`, que es decimal.js y no float.

### M6 · MENOR · `apps/api/src/modules/orgs/routes.ts:267`
`Location: /api/v1/orgs/{orgId}/soporte/{id}` apunta a una ruta que no existe.

### M7 · MENOR · `apps/api/src/modules/unidades/schemas.ts:45,55`
`TipoSectorUnidadOrTipo()` es una función de un solo uso, con un nombre confuso, que solo devuelve `TipoUnidad.optional()`. Basta con usar ese valor directamente (AGENTS.md §5).

### M8 · MENOR · `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:118-124`
Las FK `unidad_id` y `creada_por` no tienen índice (plantilla §3.4). El impacto es bajo porque no hay `DELETE`, pero queda anotado.

### M9 · MENOR · `packages/db/prisma/migrations/20261126000200_identidad/migration.sql:144-153`
Endurecimiento pendiente en BD:
- `GRANT UPDATE (revocada_en)` y la política `upd` permiten des-revocar (`revocada_en = NULL`) y "revocar" una invitación ya aceptada. Se puede exigir `aceptada_en IS NULL AND revocada_en IS NULL` en `USING` y `revocada_en IS NOT NULL` en `WITH CHECK`, con su escenario.
- El `CHECK` de vigencia ≤ 7 días se mide contra `created_at`, que envía la API (`invitaciones/service.ts:139`). La regla depende de un valor que controla la aplicación.

### M10 · MENOR · `plan_fases_backend.md:585,612`
- La fila de `POST /orgs/{orgId}/cotos` sigue diciendo "Valida límite de cotos del plan en servicio", aunque la entrega decidió lo contrario.
- "Todos los endpoints de 1.3 con sus pruebas" está marcado `[x]`, pero faltan las pruebas de idempotencia (B6).

### M11 · MENOR · `apps/api/src/app.ts:41,48`
El límite de tasa corre después de verificar el JWT y de resolver el usuario en BD. Un JWT válido de alguien sin cuenta consulta `usuario_por_auth` en cada petición (el `null` no se cachea) sin ningún límite. Conviene aplicar el límite por IP antes de autenticar.

## Para el usuario

- **B1 (`effect`):** viene de la Fase 0. Hay que decidir entre un `overrides` a `effect@3.22.5` (forzar una versión distinta a la que fija `@prisma/config`) o una excepción documentada mientras sale una versión estable de Prisma que lo corrija.
- **Regla 1 de AGENTS.md:** dice que la única consulta fuera de `withTenant` es `/health/ready`, pero el plan (§3.2, §5 1.1 b) exige llamar a `app.usuario_por_auth` antes de firmar el contexto (`auth.ts:25`). Conviene declarar esa excepción en AGENTS.md.
- **B3:** qué evidencia de "correo verificado" usar con Supabase (por ejemplo, exigir *Confirm email* en el proyecto y confiar en el claim `email`).
- **B6:** si el `409` por llave natural cumple la regla 9 para cotos, sectores y unidades.
- **Tope de cotos por tier:** la entrega dice que el dueño del producto confirmó que no hay tope. Hay que confirmarlo y actualizar el plan (M10).
- **Directorio:** `GET /cotos/{id}/miembros` entrega correo y teléfono de todos los miembros, incluidos residentes, a cualquier `cotos_staff`, también al comité. Decidir si el comité debe ver esos datos (LFPDPPP, minimización).
- **M1:** si desactivar a un usuario debe surtir efecto de inmediato. Implica cambiar el diseño de caché de §3.2.
- **E2E y `migraciones-postgres`:** no se ejecutaron (no hay Docker local). Quedan a cargo de CI.
