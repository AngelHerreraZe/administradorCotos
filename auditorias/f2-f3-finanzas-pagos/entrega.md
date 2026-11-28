# Entrega: f2-f3-finanzas-pagos

Tarea: Fase 2 (finanzas) y Fase 3 (pagos, Auto-Pay, CFDI, billing), `plan_fases_backend.md` §6 y §7
Ronda: 4
Implementó: Claude Code, por excepción autorizada por el desarrollador (normalmente implementa Gemini). Por eso no puede auditar esta ronda; el dictamen lo debe emitir otro agente o un desarrollador.

## Qué cambió
- `packages/db/prisma/migrations/20261127000100_finanzas_y_pagos/migration.sql`: columna `facturas_cfdi.paquete_timbre_id` (FK a `paquetes_timbres`) y función `app.marcar_cfdi_fallido(uuid)`, solo para `app_worker`. La función pasa a `fallido` únicamente filas `pendiente` sin `pac_invoice_id` y devuelve el timbre reservado. Es idempotente. La migración no está en `main`, así que se editó en lugar de crear otra.
- `packages/db/prisma/schema.prisma`: campo `paqueteTimbreId` y relación `FacturaCfdi.paqueteTimbre` ↔ `PaqueteTimbres.facturas`.
- `apps/worker/src/processors/cfdi.ts`:
  - El timbre se reserva con `app.consumir_timbre` en la misma transacción que crea la fila `pendiente` (l. 260-292). El cierre ya no consume timbre (l. 357-360).
  - Solo un rechazo definitivo del PAC marca `fallido`, vía `app.marcar_cfdi_fallido` (l. 325). Se eliminó `ultimoIntento`: un fallo transitorio deja la fila `pendiente` y reanudable.
  - Las llaves de XML/PDF son deterministas: `<org>/<coto>/cfdi/<facturaId>.{xml,pdf}` (l. 351).
- `apps/api/src/modules/cfdi/service.ts` (`encolarTimbrado`, l. 181-214): si la fila activa está `pendiente`, se vuelve a encolar con su propia `claveIdempotencia` y su receptor guardado. Usa el `jobId` `cfdi-reanudar-<facturaId>-<minuto>`. Una fila `timbrado` se sigue devolviendo con 200 y sin encolar.
- Pruebas:
  - `apps/worker/test/finanzas_pagos.test.ts`: el rechazo 4xx devuelve el timbre. Un *timeout* después de timbrar falla los 5 intentos (el último en S3), deja la fila `pendiente` con `pacInvoiceId` y un solo timbre usado, y la reanudación completa la factura sin una segunda llamada al PAC. Se verifican las llaves deterministas.
  - `apps/api/test/pagos_cfdi_billing.test.ts`: reanudación de una fila `pendiente` (clave y receptor de la fila, `jobId` nuevo) y no re-encolado de una fila `timbrado`.
  - `packages/db/test/rls.test.ts`: `marcar_cfdi_fallido` está denegada a `app_service`. Devuelve el timbre una sola vez aunque se llame dos veces, reactiva un paquete `agotado` y no toca filas con `pac_invoice_id`.

## Decisiones
- **B1, opción elegida: reservar el timbre antes de llamar al PAC.** Para no cobrar timbres por CFDI que el PAC rechazó, el rechazo definitivo lo devuelve en SQL.
- **M1 se resolvió quitando la causa, no buscando en las claves de filas `fallido`.** Un fallo transitorio ya no produce `fallido`. La fila queda `pendiente` y se reanuda con la **misma** clave, y `buscarFacturaPorExternalId` encuentra el CFDI emitido. `fallido` solo existe cuando el PAC rechazó (no timbró), así que una clave nueva `-r<n>` no puede duplicar.
- **`jobId` de reanudación por minuto.** Si el job original sigue vivo, ambos se serializan por el candado del coto y el segundo termina en `omitido` o completa la misma fila.

## Cómo probarlo
- `npm run check`
- `cd apps/worker && npx vitest run test/finanzas_pagos.test.ts`
- `cd packages/db && npx vitest run test/rls.test.ts -t "pagos F3"`

## Verificaciones que corrí
- `npm run db:generate`: OK.
- `npm run check`: 19/19 tareas OK. Biome sin errores (153 archivos). api 48, db 19 y scripts 4 pruebas en verde; worker en verde.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.
- Migraciones en Postgres real y E2E: no corridos (sin Docker en esta máquina); quedan en CI.

## modern-web-guidance
No aplica (sin cambios de HTTP ni del navegador).

## Dependencias nuevas
Ninguna.

## Respuesta al dictamen
- **B1:**
  - Reserva del timbre al crear la fila: `cfdi.ts:260-292`.
  - El cierre ya no depende del timbre: `cfdi.ts:357-360`.
  - Reanudación de filas `pendiente`: `cfdi/service.ts:181-214`.
  - Devolución del timbre en rechazo definitivo: `migration.sql:639-655`.
  - Prueba del último intento fallido en S3 y la reanudación con una sola llamada al PAC: `apps/worker/test/finanzas_pagos.test.ts:585-620`.
- **M1:** se eliminó el paso a `fallido` en el último reintento transitorio (`cfdi.ts:321-329`). Prueba con *timeout* después de timbrar: `finanzas_pagos.test.ts:585-604`.
- **M2:** llaves deterministas por factura (`cfdi.ts:349-355`); la prueba verifica las llaves exactas.

## Pendientes y dudas
- Siguen abiertos los puntos de «Para el usuario» del dictamen: `jobId` de F1 en invitaciones, carga del CSD, webhooks fuera de `withTenant` y la confirmación de las decisiones M1/M5 de la ronda 3.
- La reanudación de una fila `pendiente` depende de que alguien vuelva a pedir el timbrado. Si se quiere automática, haría falta un cron que re-encole las filas `pendiente` viejas; no se hizo.
