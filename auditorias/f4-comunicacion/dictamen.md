# Dictamen: f4-comunicacion

Veredicto: CAMBIOS
Huella: 12cac94069b35ef3fcedc7a25ee7244ca678b468f748faec1bf5b52077a8960a
Ronda: 1
Fecha: 2026-11-27

Implementó y auditó Claude Code, por decisión del usuario.

## Verificaciones
| Gate | Resultado |
| :--- | :--- |
| npm ci | ✅ |
| npm run db:generate | ✅ |
| npm run check | ✅ Biome 172 archivos sin errores; 21/21 tareas sin caché (`turbo --force`); 109 pruebas (api 52, worker 15, db 20, ai 3, storage 3, payments 4, cfdi 2, security 3, notifications 3, scripts 4) |
| npm audit --omit=dev --audit-level=high | ✅ 0 altas |
| Migraciones en Postgres real | Pendiente de CI (`migraciones-postgres`): `20261128000100_comunicacion` es nueva (`A`) |
| E2E | Pendiente de CI; sin Docker local |

Comparación con `base.json`: 39 archivos, todos mencionados en la entrega. No se edita ninguna migración existente. `apps/api/src/middleware/security.ts` no cambió.

Búsquedas mecánicas sin hallazgos nuevos. Las coincidencias que aparecieron son todas previas a esta tarea: comentarios de `.env.example`, fixtures de prueba, el `biome-ignore` documentado de `rls.test.ts` y `proxy.password` del cliente Evolution.

## Hallazgos

### B1 · BLOQUEANTE · `apps/worker/src/env.ts:112`
El refine «DB_CTX_SECRET solo lo recibe el despliegue del bot» impide arrancar el worker en desarrollo. `apps/worker` y `apps/api` cargan el mismo `../../.env` (`"dev"` en ambos `package.json`), y la API necesita `DB_CTX_SECRET`. Verificado con `loadEnv` y `WORKER_QUEUES=auditoria,correo`:
- con el valor de `.env.example` (`DB_CTX_SECRET=`) falla con «hex de al menos 32 bytes»;
- con un hex válido falla con «solo lo recibe el despliegue del bot».

`npm run dev` deja de funcionar.

**Criterio:** con el `.env` de desarrollo (valor vacío o hex) el worker arranca con colas que no son del bot, y una prueba en `apps/worker/test` lo demuestra. El aislamiento del bot se mantiene: `whatsappEntrante` sigue exigiendo `DB_CTX_SECRET`. Si se quiere impedir que el secreto llegue a otras colas en producción, hágase sin romper desarrollo (por ejemplo, solo con `NODE_ENV=production`).

### B2 · BLOQUEANTE · `apps/worker/src/processors/notificaciones.ts:161` (y `packages/whatsapp/src/evolution-client.ts:41`)
`log.warn({ err, comunicadoId }, …)` registra el error completo de Evolution. El cliente mete en ese error el cuerpo de la respuesta (`${errorText}`). En los rechazos de envío, Evolution devuelve el número y el JID del destinatario, así que el teléfono termina en logs y en Sentry. Rompe la regla 11 de `AGENTS.md` y el criterio de F4 «ningún log contiene datos de residentes».

**Criterio:** ningún error de Evolution que llegue a logs o a Sentry contiene el cuerpo de la respuesta; basta con el estado HTTP y el *endpoint* sin número. Una prueba hace fallar `enviarTexto` con un cuerpo que incluye el número y verifica que no aparece en los logs capturados.

### B3 · BLOQUEANTE · `apps/worker/src/processors/notificaciones.ts:116-121` y `:223`
El cupo de calentamiento del chip se calcula leyendo `enviadosHoy` al inicio de cada lote, y el worker corre con `concurrency: 2`. Dos comunicados del mismo coto publicados seguidos se procesan en paralelo: cada lote ve el mismo cupo libre, lo reclama completo y entre los dos envían hasta el doble del límite diario. Rompe el criterio «sin violar límites» y la protección anti-baneo.

**Criterio:** el cupo se reserva de forma atómica por instancia y día antes de enviar (por ejemplo, `INCRBY` con tope en Redis, o un candado por instancia). Una prueba con dos comunicados concurrentes del mismo coto y un chip de 15/día termina con 15 envíos o menos.

### B4 · BLOQUEANTE · `apps/worker/src/processors/bot.ts:103`
El ticket que crea el bot no lleva llave de idempotencia. La respuesta por WhatsApp se envía después (`:65`), y los jobs `whatsappEntrante` tienen 2 intentos (`apps/api/src/lib/redis.ts:136`). Si `sendTextMessage` falla, el reintento crea un segundo ticket por el mismo mensaje. Rompe la regla 9: todo reintento debe tener una llave única en BD.

**Criterio:** el ticket del bot guarda `clave_idempotencia` derivada de `instancia:mensajeId` (como ya hace el pago en `:182`), y el reintento devuelve el mismo folio. Una prueba procesa el mismo mensaje dos veces y obtiene un solo ticket.

### B5 · BLOQUEANTE · `apps/api/test/comunicacion.test.ts`
Faltan pruebas que exige `AGENTS.md` §6 (feliz, 422, otro coto u otro rol e idempotencia si escribe):

| Endpoint | Falta |
| :--- | :--- |
| `GET /cotos/{cotoId}/comunicados` (`comunicados/routes.ts:27`) | 422 y 403 |
| `GET /cotos/{cotoId}/tickets` (`tickets/routes.ts:37`) | 422 y 403 |
| `GET /cotos/{cotoId}/votaciones` (`votaciones/routes.ts:34`) | 422 y 403 |
| `POST /tickets/{id}/comentarios` (`tickets/routes.ts:71`) | 403 (comentario interno sin ser staff) e idempotencia |
| `GET /tickets/{id}/comentarios` (`:89`) | 404 de un ticket no visible |
| `GET /tickets/{id}/adjuntos` (`:133`) | 404 de un ticket no visible |
| `POST /votaciones/{id}/abrir` y `/cerrar` (`votaciones/routes.ts:66-67`) | 403 con otro rol |
| `PATCH /me` con `notifCorreo` / `notifWhatsapp` (`me/schemas.ts:56`) | ninguna prueba |

**Criterio:** cada caso de la tabla tiene su prueba con *asserts* reales.

### M1 · MENOR · `apps/api/src/modules/comunicados/service.ts:99` y `migration.sql:74`
Si el comité (o cualquier persona del staff que no sea administración) publica un borrador, recibe 404 («Comunicado no encontrado»), aunque sí lo ve en el listado. Ante un borrador ya publicado recibe 403. Conviene responder 403 en ambos casos.

### M2 · MENOR · `packages/db/prisma/migrations/20261128000100_comunicacion/migration.sql:6` y `:37`
Faltan índices que pide la plantilla §3.4:
- `comunicados_lectura.coto_id`: es FK y filtro de la política `sel` para finanzas;
- `comunicados.sector_id`: es FK.

### M3 · MENOR · `apps/worker/src/processors/bot.ts:169` y `:199`
Si el mismo comprobante se procesa dos veces (reintento del job), cada intento sube un objeto nuevo a S3 con llave aleatoria, que queda huérfano. Además, el segundo intento responde «ya estaba registrado» al confundir el choque de su propia llave de idempotencia con un duplicado real. Conviene una llave de objeto determinista por mensaje y distinguir el caso.

### M4 · MENOR · `apps/worker/src/processors/notificaciones.ts:150`
Si encolar el correo falla a mitad de lote, el job se reintenta y reclama el lote siguiente. El resto del lote anterior se queda sin aviso y nadie se entera; el «a lo más una vez» está documentado. Conviene registrar en el log cuántos destinatarios se perdieron, sin datos personales.

### M5 · MENOR · `packages/db/test/rls.test.ts`
Faltan escenarios para:
- la política `sel` de `evolution_instances`: staff sí, residente no;
- el `GRANT UPDATE (notif_correo, notif_whatsapp)` sobre `usuarios`: cada quien sobre su fila; otras columnas, no;
- el INSERT directo en `comunicados_lectura` por alguien que no es administración.

## Para el usuario
- **Dependencia nueva:** `@google/genai@3.6.1`. Es la última estable (el `next` es un RC 2.9), con versión exacta, solo en `packages/ai` y justificada en la entrega.
- **`app.bot_resolver` no valida permisos con `app.cotos_*`** (regla 6). Por diseño no puede: el bot no tiene usuario todavía. Devuelve solo IDs y exige un teléfono verificado sin ambigüedad. Cualquier proceso con `app_service` (incluida la API) puede asociar un teléfono a su usuario si conoce el nombre de la instancia. Decidan si lo aceptan.
- **Sin implementar, según la entrega:** push (Expo y Web Push), Meta Cloud API, votar por chat y el aviso por correo de SLA vencido. Confirmen que quedan fuera de F4.
- **Cuando se corrija F4 cambiará la huella,** y el dictamen de f2-f3 dejará de coincidir con la carpeta.
