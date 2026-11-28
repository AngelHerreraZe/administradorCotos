# Entrega: f4-comunicacion

Tarea: Fase 4 — Comunicación, WhatsApp, IA, tickets y votaciones (`plan_fases_backend.md` §8)
Ronda: 1
Implementó: Claude Code, por excepción autorizada por el desarrollador (normalmente implementa Gemini). Por eso no puede auditar esta tarea; el dictamen lo debe emitir otro agente o un desarrollador.
Huella base (`base.json`): `0c428ebf71266c43d4e072a194c7cf40d60bbcb051472ea0f9e09b43e2d15a8a`. Es el estado final de f2-f3, ronda 4, todavía sin auditar.

## Qué cambió

### Base de datos
**Migración nueva:** `packages/db/prisma/migrations/20261128000100_comunicacion/migration.sql`

- **Comunicados:**
  - Columnas `dirigido_a` (todos · propietarios · sector · unidades · morosos), `sector_id`, `unidades_ids`, `publicado_en` y `clave_idempotencia`.
  - CHECKs de prioridad y segmento, y `comunicados_sin_html_ck` (Markdown sin HTML).
  - Trigger `mismo_coto` para `sector_id`.
- **Tabla `comunicados_lectura`:** destinatarios materializados más acuse de lectura.
  - RLS: cada persona ve su fila. La lista completa solo la ven `cotos_finanzas`, porque puede ser el segmento de morosos.
  - La persona solo puede actualizar `leido_en` y `canal`.
  - Lleva `mismo_coto` e `inmutable`.
  - La política `sel` de `comunicados` se rehízo: el staff ve todo; los demás, solo lo publicado que les llegó.
- **`app.publicar_comunicado(uuid)`:** INVOKER, solo administración. Inserta los destinatarios según el segmento (morosos = propietarios de unidades en `app.morosidad`) y marca publicado. Lanza `UA409` si ya estaba publicado.
- **Preferencias:** `usuarios.notif_correo` y `usuarios.notif_whatsapp`, con `GRANT UPDATE` de esas dos columnas a `app_service`.
- **Tabla `evolution_instances`:** una por coto. Un CHECK exige `instance_name = 'coto_' || coto_id`. `app_service` solo puede leer (staff); las altas las hace operaciones.
- **`app.bot_resolver(instancia, teléfono)`:** DEFINER, solo para `app_service`. Devuelve `(coto_id, usuario_id)` únicamente si la instancia está activa, el teléfono está verificado, la persona es miembro activo de ese coto y no hay ambigüedad.
- **Tickets:**
  - Columnas `adjuntos` (máximo 5), `sla_vence_en`, `sla_vencido` y `clave_idempotencia`.
  - El trigger `tg_tickets_defaults` impide que quien reporta fije su propio SLA.
  - `ticket_comentarios.clave_idempotencia`.
- **Votaciones:**
  - Nuevo estado `programada` y `clave_idempotencia`.
  - `app.resultados_votacion(uuid)`: DEFINER, solo `cotos_staff`, solo agregados (votos y peso por opción, unidades votantes y totales, indiviso votante).
- **Archivos relacionados:**
  - `packages/db/prisma/schema.prisma`: modelos y relaciones nuevas. `prisma format` también realineó el archivo.
  - `packages/db/test/rls.test.ts`: escenario «comunicación F4», que cubre:
    - segmento de morosos privado: el inquilino no lo recibe y el comité no ve la lista;
    - HTML rechazado;
    - publicar dos veces;
    - acuse de lectura propio;
    - `bot_resolver` con teléfono verificado, no verificado, ambiguo, otra instancia y rol `app_worker`;
    - inyección: estado de cuenta de otra unidad o de otro coto da 0 filas;
    - pago OCR: solo `en_revision` y rastreo duplicado rechazado;
    - SLA forzado al insertar;
    - `programada` y resultados (staff sí; residente, otro despacho y otro coto no).

### Paquetes
- **`packages/ai`** (nuevo): `clasificarIntencion` y `extraerComprobante` con `@google/genai`.
  - `responseMimeType: application/json` y `responseJsonSchema` derivado de Zod (`z.toJSONSchema`).
  - La respuesta se valida con el mismo esquema Zod.
  - *Timeout* de 15 s (`AbortSignal.timeout`) y un solo reintento.
  - La IA solo devuelve un enum de intención y un resumen; nunca IDs.
- **`packages/shared/src/colas.ts`:** colas `notificaciones`, `whatsappEntrante` y `gobernanza`.
- **`packages/whatsapp`:** `extraerMensajeEntrante` ignora mensajes propios, grupos y estados. Nuevo `getBase64FromMediaMessage`.
- **`packages/storage`:** categoría `tickets`.

### API
- **`modules/comunicados`:**
  - `POST/GET /cotos/{cotoId}/comunicados`.
  - `POST /comunicados/{id}/publicar` encola cuando la transacción de BD ya terminó, con `jobId notif-<id>`. Repetirlo no republica.
  - `POST /comunicados/{id}/leido`.
- **`modules/tickets`:**
  - `POST/GET /cotos/{cotoId}/tickets` y `PATCH /tickets/{id}`.
  - `POST/GET /tickets/{id}/comentarios`.
  - `POST /cotos/{cotoId}/tickets/adjunto-url` y `GET /tickets/{id}/adjuntos` (§3.9; se valida que las llaves tengan el prefijo del coto).
- **`modules/votaciones`:**
  - `POST/GET /cotos/{cotoId}/votaciones`.
  - `POST /votaciones/{id}/abrir|cerrar`.
  - `POST /votaciones/{id}/votos` (`app.votar`).
  - `GET /votaciones/{id}/resultados`.
- **`modules/webhooks`:** `POST /webhooks/whatsapp`. Valida `apikey` por hash e inserta en `webhook_events` **sin el texto** (solo la marca de idempotencia). Después encola `whatsappEntrante`.
- **`modules/me`:** `notifCorreo` y `notifWhatsapp` en el perfil y en `PATCH /me`.
- **Configuración y conexión:**
  - `env.ts`: `EVOLUTION_WEBHOOK_APIKEY`.
  - `types.ts`, `lib/redis.ts` y `main.ts`: encoladores nuevos. Los jobs del bot se borran también al fallar.
  - `app.ts`: monta los tres módulos.
- **Pruebas:** `apps/api/test/comunicacion.test.ts`. Cada endpoint tiene caso feliz, 422, 403 (otro coto u otro rol) e idempotencia donde crea; el webhook se prueba con 401, mensajes ignorados, duplicados y 503.

### Worker
- **`processors/notificaciones.ts`:** fan-out por lotes de 100.
  - Cada lote se reclama en SQL (`notificado_en`, `FOR UPDATE SKIP LOCKED`).
  - Envía correo (plantilla `aviso`) y WhatsApp vía Evolution con `calculateInterMessageDelay`.
  - No reclama más destinatarios que el cupo diario de `checkWarmupLimit`; el contador por instancia y día vive en Redis.
  - En horario de silencio (22:00–07:00 en la zona del coto) difiere hasta las 07:00, salvo prioridad `urgente`.
- **`processors/bot.ts` (`whatsappEntrante`):**
  - `app.bot_resolver`, y luego `withTenant` como el residente (`aal1`, con el coto de la instancia).
  - Intenciones: estado de cuenta (`app.unidades_propias()` y `app.estado_cuenta`), ticket o escalar a humano, votaciones abiertas, visitas (remite a la app) y ayuda.
  - Comprobante: descarga de Evolution, OCR, subida a S3 y pago `en_revision`, solo si la persona es propietaria de una sola unidad. Un rastreo duplicado se rechaza y se avisa.
  - A números no resueltos no se les responde. En los logs solo van `cotoId` y la acción.
- **`processors/gobernanza.ts`:** cada 5 minutos abre las votaciones programadas y cierra las vencidas. Cada día a las 08:00 marca el SLA vencido de tickets.
- **`env.ts`:**
  - Nuevas variables: `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` y `DB_CTX_SECRET`.
  - `whatsappEntrante` se despliega sola y exige sus secretos.
  - `DB_CTX_SECRET` solo se acepta en el despliegue del bot.
- **`main.ts`:** registra las tres colas. El bot exige `current_user = app_service` y `assertRestrictedRole`.
- **Pruebas:** `apps/worker/test/comunicacion.test.ts`. Cubre 5 000 destinatarios, silencio, urgente, calentamiento del chip, inyección del bot, logs sin texto ni teléfono, gobernanza y env.

### Otros
- `plan_fases_backend.md`: F4 marcada en auditoría, con el avance.
- `.env.example`: variables nuevas, comentadas.

## Decisiones
- **Destinatarios materializados al publicar** (`comunicados_lectura`). La misma tabla decide quién ve cada comunicado, guarda el acuse de lectura y sirve de cursor del fan-out. Así el segmento «morosos» nunca existe como lista legible fuera de finanzas.
- **El texto de WhatsApp no se persiste.** Viaja solo en el job (`removeOnComplete` y `removeOnFail`). `webhook_events` guarda solo la marca de idempotencia. Cumple el criterio «ningún log contiene texto» y la regla 12 sin dar al bot (`app_service`) lectura de `webhook_events`. Costo: si la cola falla, la persona tiene que reenviar el mensaje.
- **Fan-out «a lo más una vez».** Se reclama el lote y luego se envía, para que réplicas o reintentos nunca dupliquen un aviso. Si el proceso muere a medio lote, esas personas solo verán el comunicado en la app (está marcado con `ponytail:`).
- **`bot_resolver` en lugar de `usuario_por_telefono(coto, tel)` más una lectura aparte de la instancia.** Es una sola función DEFINER que resuelve ambas cosas y devuelve solo IDs. Compara los últimos 10 dígitos (numeración MX y el prefijo `521` de WhatsApp) y no resuelve si hay ambigüedad.
- **Votar por chat no se implementó:** el bot lista las votaciones abiertas y remite a la app. Elegir una opción por chat exigiría guardar el estado de la conversación.
- **`GEMINI_MODEL` es obligatorio y no tiene valor por defecto.** Así no se fija en el código un nombre de modelo que puede caducar.
- **Estado `programada`.** `abrir` deja la votación programada si todavía no empieza; el job la activa en la fecha de inicio. Si no, una votación en borrador nunca se abriría sola.
- **Horario de silencio fijo de 22:00 a 07:00** en la zona del coto. No es configurable por usuario.

## Cómo probarlo
- `npm run check`
- `npm run test:security`
- `cd apps/worker && npx vitest run test/comunicacion.test.ts`
- `cd apps/api && npx vitest run test/comunicacion.test.ts`
- Local con Redis: `WORKER_QUEUES=notificaciones,gobernanza`. El bot va en otro proceso: `WORKER_QUEUES=whatsappEntrante` con `WORKER_DATABASE_URL` de `app_service` y `DB_CTX_SECRET`.

## Verificaciones que corrí
- `npm run db:generate`: OK.
- `npm run check`: 21/21 tareas OK. Biome sin errores ni *warnings* (172 archivos).
  - api: 52 pruebas.
  - worker: 15.
  - db: 20 (19 RLS y benchmark).
  - ai: 3.
  - storage, payments, cfdi, security, notifications y scripts: en verde.
- `npm run test:security`: 19/19.
- El SQL crudo del worker (reclamo de lote con `SKIP LOCKED`, jobs de gobernanza y consultas del bot) se validó contra las migraciones reales en PGlite con una prueba temporal, que después se borró.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.
- No corrí migraciones en Postgres real ni E2E: no hay Docker en esta máquina. Quedan para CI.

## modern-web-guidance
- `sanitize-untrusted-html`: el cuerpo del comunicado es Markdown sin HTML, validado en Zod y en un CHECK de la BD. Se documenta en OpenAPI que el cliente debe renderizarlo sanitizado. El correo lo escapa (`escaparHtml`) y WhatsApp lo envía como texto.
- Webhook: no apareció una guía específica para webhooks entrantes (búsqueda «webhook endpoint verify shared secret»). Se siguió la regla 12 de `AGENTS.md`.

## Dependencias nuevas
- `@google/genai@3.6.1` (última estable; `next` es un RC 2.9). Es el SDK oficial que pide el plan §8 4.2 para Gemini con salida estructurada (`responseJsonSchema`) y `abortSignal`. Solo lo usa `packages/ai`.

## Pendientes y dudas
- **No está implementado:**
  - Push (Expo y Web Push con VAPID): no hay tabla de tokens de dispositivo ni cliente todavía.
  - Meta Cloud API para avisos masivos: hoy todo sale por Evolution, con límites de calentamiento.
  - Aviso por correo al vencer el SLA: el job solo marca `sla_vencido`.
- **Orden de auditoría.** F4 se implementó sobre f2-f3, ronda 4, todavía sin auditar, en la misma carpeta. Al auditar f2-f3, sus cambios de la ronda 4 están entre su `manifiesto.json` y la huella `0c428ebf…` (el `base.json` de F4). Se recomienda auditar f2-f3 antes que F4.
- **Webhooks fuera de `withTenant`.** `/webhooks/whatsapp` escribe en `webhook_events` con `prisma` directo, igual que Conekta y Stripe. Sigue pendiente la decisión de documentarlo en `AGENTS.md` §3 regla 1.
- **Alta de `evolution_instances`.** Solo la puede hacer operaciones (`app_worker` o el dueño); falta definir ese flujo.
- **Comprobantes huérfanos en S3.** Si un comprobante por WhatsApp resulta duplicado, el objeto ya subido queda sin dueño en el bucket; lo limpiaría la retención del bucket.
