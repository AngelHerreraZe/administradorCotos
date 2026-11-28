# Dictamen: f2-f3-finanzas-pagos

Veredicto: APROBADO
Huella: 12cac94069b35ef3fcedc7a25ee7244ca678b468f748faec1bf5b52077a8960a
Ronda: 4
Fecha: 2026-11-27

Implementó y auditó Claude Code, por decisión del usuario.

## Verificaciones
| Gate | Resultado |
| :--- | :--- |
| npm ci | ✅ (el primer intento falló por un bloqueo de archivos en Windows; el segundo terminó bien) |
| npm run db:generate | ✅ |
| npm run check | ✅ Biome 172 archivos sin errores ni *warnings*; 21/21 tareas ejecutadas sin caché (`turbo --force`); 109 pruebas: api 52, worker 15, db 20, ai 3, storage 3, payments 4, cfdi 2, security 3, notifications 3, scripts 4 |
| npm audit --omit=dev --audit-level=high | ✅ 0 altas (7 moderadas, previas) |
| Migraciones en Postgres real | Pendiente de CI (`migraciones-postgres`) |
| E2E | Pendiente de CI (`e2e`); sin Docker local |

Nota sobre `scripts/huella.test.ts`: falla si vitest corre con la ruta `/e/…` en minúscula (Git Bash). Aparecen dos instancias del módulo, `e:` y `E:`, y vitest no encuentra la *suite*. Con `E:\administradorcotos` (PowerShell) pasa 4/4. Es un artefacto del shell de quien corre la prueba, no del repo.

Comparación con `base.json`: `20261127000100_finanzas_y_pagos` sigue siendo un archivo nuevo de esta tarea (`A`); no se editó ninguna migración existente. Contra el manifiesto de la ronda 3, los archivos de esta ronda son:
- `apps/worker/src/processors/cfdi.ts`
- `apps/api/src/modules/cfdi/service.ts`
- la migración `20261127000100_finanzas_y_pagos`
- `schema.prisma`
- y sus pruebas: `finanzas_pagos.test.ts`, `pagos_cfdi_billing.test.ts` y `rls.test.ts`

El resto de la comparación es la tarea `f4-comunicacion`, que se audita en su propio dictamen.

## Hallazgos
Sin bloqueantes ni menores en el alcance de esta ronda.

## Ronda anterior
- **B1:** resuelto.
  - El timbre se reserva con `app.consumir_timbre` en la misma transacción que crea la fila `pendiente` (`cfdi.ts:260-292`). El cierre ya no depende del timbre.
  - El rechazo definitivo del PAC pasa la fila a `fallido` y devuelve el timbre con `app.marcar_cfdi_fallido` (`cfdi.ts:324-325`, `migration.sql:639-655`). La función es idempotente y nunca toca filas con `pac_invoice_id`.
  - `encolarTimbrado` reanuda una fila `pendiente` con su propia clave y receptor, y un `jobId` nuevo (`cfdi/service.ts:191-212`).
  - Pruebas:
    - worker: el último intento falla en S3 y la reanudación termina con una sola llamada al PAC (`finanzas_pagos.test.ts:585-620`);
    - API: reanudación de una fila `pendiente` y no reencolado de una fila `timbrado`;
    - PGlite: devolución única del timbre, función negada a `app_service` y fila con PAC intacta.
- **M1:** resuelto. Se quitó `ultimoIntento`: un fallo transitorio deja la fila `pendiente` y la reanudación reutiliza la misma clave, así que `buscarFacturaPorExternalId` encuentra el CFDI emitido. Lo cubre la prueba con *timeout* posterior al timbrado.
- **M2:** resuelto. Las llaves son deterministas, `<org>/<coto>/cfdi/<facturaId>.{xml,pdf}` (`cfdi.ts:351`), y la prueba verifica las llaves exactas.

## Para el usuario
- **La huella sellada incluye `f4-comunicacion`,** porque las dos tareas están en la misma carpeta. Esta aprobación cubre solo f2-f3. F4 tiene veredicto CAMBIOS en su propio dictamen. En cuanto se corrija F4, la huella cambiará y esta ya no coincidirá con la carpeta.
- **Siguen abiertos los pendientes de la ronda 3:**
  - el `jobId` de invitaciones de F1 (`inv:<id>`), que no es válido para BullMQ;
  - cómo sube cada coto su CSD a Facturapi;
  - si se documentan en `AGENTS.md` §3 regla 1 los webhooks que escriben fuera de `withTenant`;
  - la confirmación de que M1 y M5 de la ronda 3 fueron decisiones suyas.
- **La reanudación no es automática.** Una factura `pendiente` se reanuda solo si alguien vuelve a pedir el timbrado. Si se quiere automática, hace falta un job que reencole las filas `pendiente` antiguas.
