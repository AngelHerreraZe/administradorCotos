# Dictamen: feat/f1-identidad

Veredicto: APROBADO
Commit auditado: 6437a0a798169cf00f5d076a9f9364acb03d7f46
Base: 27e585944582fbf1ed6d6f09cf66c3c9d384dd15
Ronda: 3
Fecha: 2026-11-26

## Verificaciones
| Gate | Resultado |
| :--- | :--- |
| `npm ci` / `npm run db:generate` | No aplica en esta ronda: no cambiaron `package-lock.json` ni `schema.prisma` (ejecutados en verde en la ronda 2) |
| `npm run check` | ✅ Biome: 95 archivos, 0 errores. 13/13 tareas. 62 pruebas: api 36, db/RLS 16, worker 4, notifications 3, security 3 |
| `npm audit --omit=dev --audit-level=high` | ✅ 0 vulnerabilidades |
| Migraciones en Postgres real | Pendiente de CI (`migraciones-postgres`) |
| E2E (`npm run test:e2e`) | Pendiente de CI (`e2e`). La idempotencia con `SAVEPOINT` en Prisma y el flujo HTTP completo de invitaciones y miembros solo se prueban ahí. **No se debe hacer merge sin estos dos jobs en verde** |

Además se revisó el diff completo de la rama (`BASE..HEAD`). Se repitieron las búsquedas mecánicas sobre los archivos de esta ronda, sin coincidencias nuevas. Se confirmó que las únicas lecturas de `usuarios` que quedan en `apps/api/src` son la propia fila (`/me`) y la del admin en el `PATCH` de miembros, que ya acepta `null`.

## Ronda anterior
- **B1 (invitación confirmada sin correo):** resuelto. `apps/api/src/modules/invitaciones/routes.ts:111-124` encola dentro de `conTenant`, antes del commit, así que un `503` revierte la fila y su `clave_idempotencia`. Prueba unitaria con transacción simulada que revierte (`invitaciones.test.ts`, caso B1: 503 → 201 con un correo → 200 sin duplicar) y caso E2E equivalente (`e2e/identidad.test.ts`, pendiente de CI).
- **M1 (`created_at` no forzado):** resuelto. `migration.sql:233-234` usa `current_setting('role')` o `session_user`, que sí reflejan quién llama dentro de una función `DEFINER`. `rls.test.ts:480-498` prueba el rechazo con +395 días y el ajuste a `now()` con −10 días.
- **M2 (minimización solo en la API):** resuelto. La política `sel` de `usuarios` se reemplaza (con reemplazo, no se elimina sin más) para limitar el staff a `cotos_finanzas`. `app.directorio_coto` (`DEFINER`, `search_path` fijo, `UA403`, `REVOKE`/`GRANT` correctos, respeta `coto_activo`, cursor por `(created_at, id)`) devuelve el correo y el teléfono solo a finanzas. Escenarios en `rls.test.ts:705-733`.
- **M3 (validación duplicada del encabezado):** resuelto. `IdempotencyHeader` único en `apps/api/src/lib/openapi.ts:26` y lectura con `c.req.valid('header')`.

## Para el usuario
- **Cambio en una política de la Fase 0:** al atender M2, la política `sel` de `usuarios` también dejó de incluir `cotos_guardia`. Ni la caseta ni el comité ven ya las filas de `usuarios` de otros miembros. Es coherente con el plan §5.1 ("la caseta nunca recibe teléfonos…"), y en la Fase 5 la caseta necesitará una función `DEFINER` para mostrar nombres de pila. El comentario de `seguridad_rls/migration.sql:442-443` ("staff/caseta ven a los miembros") queda desactualizado; esa migración ya está aplicada y no se edita.
- **Decisiones que la entrega atribuye al usuario.** Confirma que son tuyas antes del merge:
  - el `overrides` de `effect@3.22.5`;
  - *Confirm email* activo y sin sesiones anónimas en Supabase: de eso depende la seguridad de `POST /invitaciones/aceptar`;
  - el `409` por llave natural en cotos, sectores y unidades;
  - ocultar el contacto al comité;
  - ningún tope de cotos por tier.
- **AGENTS.md regla 1:** sigue pendiente declarar la excepción de `app.usuario_por_auth`, que se consulta fuera de `withTenant` (`apps/api/src/middleware/auth.ts:35`).
- **Antes del merge:** los jobs de CI `migraciones-postgres` y `e2e` deben quedar en verde. Si alguno falla, el arreglo es un cambio de código y requiere auditar de nuevo.
