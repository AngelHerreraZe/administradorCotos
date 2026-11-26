---
version: alpha
name: Vecindad Clara — Administrador de Cotos
description: Sistema visual para vecinos, guardias, administradores, mesas directivas y despachos. Pensado para personas sin afición por la tecnología.
colors:
  primary: "#0F766E"
  primary-hover: "#115E59"
  primary-soft: "#CCFBF1"
  primary-ink: "#115E59"
  on-primary: "#FFFFFF"
  secondary: "#0369A1"
  on-secondary: "#FFFFFF"
  background: "#F5F7F6"
  surface: "#FFFFFF"
  surface-muted: "#EEF2F1"
  ink: "#12201E"
  ink-muted: "#4A5A57"
  border: "#D3DDDA"
  border-strong: "#8A9B97"
  success: "#15803D"
  on-success: "#FFFFFF"
  success-soft: "#DCFCE7"
  success-ink: "#14532D"
  warning: "#B45309"
  warning-soft: "#FEF3C7"
  warning-ink: "#78350F"
  danger: "#B91C1C"
  on-danger: "#FFFFFF"
  danger-soft: "#FEE2E2"
  danger-ink: "#7F1D1D"
  info-soft: "#E0F2FE"
  info-ink: "#0C4A6E"
  dark:
    primary: "#2DD4BF"
    primary-hover: "#5EEAD4"
    primary-soft: "#123B37"
    primary-ink: "#99F6E4"
    on-primary: "#042F2E"
    secondary: "#7DD3FC"
    background: "#0E1716"
    surface: "#152321"
    surface-muted: "#1C2D2A"
    ink: "#E8F0EE"
    ink-muted: "#A7B8B4"
    border: "#2C3F3C"
    border-strong: "#6B807B"
    success: "#4ADE80"
    on-success: "#052E16"
    warning: "#FBBF24"
    danger: "#F87171"
    on-danger: "#450A0A"
typography:
  display:
    fontFamily: Lexend
    fontSize: 2.5rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Lexend
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.2
  headline-md:
    fontFamily: Lexend
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: Lexend
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.3
  body-lg:
    fontFamily: Source Sans 3
    fontSize: 1.125rem
    fontWeight: 400
    lineHeight: 1.55
  body-md:
    fontFamily: Source Sans 3
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Source Sans 3
    fontSize: 1.125rem
    fontWeight: 700
    lineHeight: 1.2
  caption:
    fontFamily: Source Sans 3
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.4
  money:
    fontFamily: Lexend
    fontSize: 2.25rem
    fontWeight: 700
    lineHeight: 1
    fontFeature: '"tnum" 1'
  keypad:
    fontFamily: Lexend
    fontSize: 2rem
    fontWeight: 600
    lineHeight: 1
    fontFeature: '"tnum" 1'
rounded:
  sm: 8px
  md: 12px
  lg: 20px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  touch-min: 48px
  touch-primary: 56px
  touch-kiosk: 72px
motion:
  fast:
    duration: 150ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)
  base:
    duration: 220ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)
  exit:
    duration: 140ms
    timingFunction: ease-in
components:
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.ink}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  card-muted-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
  divider:
    backgroundColor: "{colors.border}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    height: 56px
  input-border:
    backgroundColor: "{colors.border-strong}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 56px
    padding: 24px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 48px
  button-secondary-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.primary}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    height: 48px
  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
  button-info:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
  choice-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.md}"
    height: 56px
  status-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success-ink}"
    rounded: "{rounded.full}"
  status-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning-ink}"
    rounded: "{rounded.full}"
  status-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-ink}"
    rounded: "{rounded.full}"
  status-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info-ink}"
    rounded: "{rounded.full}"
  text-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
  badge-count:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    rounded: "{rounded.full}"
    size: 24px
  verdict-allowed:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-success}"
    typography: "{typography.headline-lg}"
    rounded: "{rounded.lg}"
  verdict-denied:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    typography: "{typography.headline-lg}"
    rounded: "{rounded.lg}"
  keypad-key:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink}"
    typography: "{typography.keypad}"
    rounded: "{rounded.md}"
    height: 72px
  amount:
    textColor: "{colors.ink}"
    typography: "{typography.money}"
  page-dark:
    backgroundColor: "{colors.dark.background}"
    textColor: "{colors.dark.ink}"
  card-dark:
    backgroundColor: "{colors.dark.surface}"
    textColor: "{colors.dark.ink-muted}"
  muted-dark:
    backgroundColor: "{colors.dark.surface-muted}"
    textColor: "{colors.dark.ink}"
  divider-dark:
    backgroundColor: "{colors.dark.border}"
  input-border-dark:
    backgroundColor: "{colors.dark.border-strong}"
  button-primary-dark:
    backgroundColor: "{colors.dark.primary}"
    textColor: "{colors.dark.on-primary}"
  button-primary-dark-hover:
    backgroundColor: "{colors.dark.primary-hover}"
    textColor: "{colors.dark.on-primary}"
  choice-selected-dark:
    backgroundColor: "{colors.dark.primary-soft}"
    textColor: "{colors.dark.primary-ink}"
  link-dark:
    backgroundColor: "{colors.dark.surface}"
    textColor: "{colors.dark.secondary}"
  verdict-allowed-dark:
    backgroundColor: "{colors.dark.success}"
    textColor: "{colors.dark.on-success}"
  verdict-denied-dark:
    backgroundColor: "{colors.dark.danger}"
    textColor: "{colors.dark.on-danger}"
  text-warning-dark:
    backgroundColor: "{colors.dark.surface}"
    textColor: "{colors.dark.warning}"
---

# Vecindad Clara

## Overview

**Claro, cálido y a prueba de prisas.** Cada pantalla responde a una pregunta
que la persona ya trae en la cabeza: *¿cuánto debo?*, *¿lo dejo pasar?*,
*¿qué tengo pendiente hoy?*, *¿cómo van las cuentas?*, *¿qué coto necesita
ayuda?*. Lo demás espera atrás.

El público principal no es técnico y muchas veces no le gusta la tecnología:
vecinos mayores, guardias en turno de noche, administradoras que antes usaban
un cuaderno y una hoja de Excel. Por eso:

- **Una acción principal por pantalla**, grande, con verbo y monto ("Pagar $1,450").
- **Texto de 18 px** en apps de vecinos, guardias y mesa directiva. 16 px como mínimo en el portal de escritorio.
- **Iconos siempre con texto.** Ningún botón ni pestaña lleva solo icono.
- **Palabras de la vida diaria**, nunca términos de contabilidad ni de sistemas (ver *Voice & Content Strategy*).
- **El color nunca va solo.** Todo estado lleva icono y texto.

Estilo: *Accessible & Ethical* (WCAG AA como piso, AAA cuando se puede). La
superficie es plana y limpia, con sombras suaves solo para separar capas.

### Superficies por tipo de usuario

| Tipo de usuario | Roles RBAC | Dispositivo | Pregunta que responde | Endpoints principales | Mockup |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Residente | `residente_propietario`, `residente_inquilino` | Celular (app / web) | ¿Cuánto debo y cómo pago? ¿Cómo dejo entrar a mi visita? | `GET /reportes/estado-cuenta/:unidadId`, `POST /pagos/online`, `POST /pagos/comprobante`, `GET /autopay/status`, `POST /accesos/invitaciones`, `GET /amenidades`, `POST /tickets`, `GET /votaciones`, `GET /comunicados` | `@design/mockups/residente.html` |
| Caseta | `guardia` | Tableta horizontal (kiosco) | ¿Lo dejo pasar? | `POST /accesos/validar`, `POST /accesos/registro-manual`, `POST /accesos/registro-salida` | `@design/mockups/caseta.html` |
| Administración del coto | `coto_admin` | Computadora (portal web) | ¿Qué necesita mi atención hoy? | `GET /cotos/:id/dashboard`, `GET /cargos/resumen`, `PATCH /pagos/:id/confirmar`, `PATCH /pagos/:id/rechazar`, `POST /cargos/generar-masivo`, `GET /tickets`, `POST /comunicados`, `POST /comunicados/ai-redactar`, `GET /autopay/admin/dashboard` | `@design/mockups/administrador.html` |
| Mesa directiva | `coto_tesorero`, `coto_comite` | Celular | ¿Cómo van las cuentas? ¿Qué gasto apruebo? | `GET /reportes/balance-mensual`, `GET /cargos/resumen`, `GET /egresos`, `PATCH /egresos/:id/aprobar`, `GET /votaciones/:id/resultados`, `GET /reportes/pdf/:tipo` | `@design/mockups/mesa-directiva.html` |
| Despacho | `org_owner`, `org_admin` | Computadora | ¿Qué coto necesita ayuda? ¿Cómo va mi plan? | `GET /cotos`, `POST /cotos`, `GET /orgs/:id/billing`, `POST /orgs/:id/members`, `PATCH /orgs/:id` | `@design/mockups/despacho.html` |

`platform_admin` (operación interna) y `proveedor` (todavía sin endpoints) no
tienen mockup: no son usuarios finales del producto.

## Colors

La paleta parte de un **verde azulado de confianza** sobre neutros cálidos.
Hay dos acentos y cuatro estados, cada uno con su versión suave para fondos.

- **Primary (#0F766E), "Verde Caseta":** acción principal, navegación activa, marca. 5.5:1 sobre blanco.
- **Primary Soft (#CCFBF1) + Primary Ink (#115E59):** opciones seleccionadas, fondos de iconos.
- **Secondary (#0369A1), "Azul Aviso":** enlaces e información. 5.9:1 sobre blanco.
- **Background (#F5F7F6):** fondo general, un poco más cálido que el blanco puro. **Surface (#FFFFFF)** para tarjetas.
- **Ink (#12201E) / Ink Muted (#4A5A57):** texto principal y secundario. El secundario sigue en 7:1. Aquí no se usa gris claro sobre gris.
- **Success (#15803D), Warning (#B45309), Danger (#B91C1C):** estados. Sobre su fondo suave el texto usa su variante `-ink` (900) para pasar 6:1 o más.
- **Modo oscuro (`colors.dark.*`):** los tonos bajan de saturación y suben de claridad. El texto sobre un acento relleno se vuelve oscuro (`on-primary #042F2E`). La caseta lo usa de noche para reducir el deslumbramiento.

En CSS los pares claro/oscuro se declaran con `light-dark()` y
`color-scheme: light dark`. Nunca se escriben valores hex dentro de un componente.

## Typography

- **Lexend** para títulos, montos y teclados. Se diseñó para mejorar la fluidez de lectura y tiene números anchos y claros.
- **Source Sans 3** para el cuerpo. Es neutra, muy legible en tamaños grandes y tiene buen soporte para el español.
- Escala: `display` 40 · `headline-lg` 32 · `headline-md` 24 · `title` 20 · `body-lg` 18 · `body-md` 16 · `caption` 14 (mínimo absoluto).
- Montos y códigos llevan cifras tabulares (`"tnum"`) para que no "bailen".
- Todo tamaño va en `rem` para respetar la escala de texto del sistema operativo. Nunca se fija `font-size` en px sobre `html`.
- Los títulos usan `text-wrap: balance` y los párrafos `text-wrap: pretty`.

## Layout

- **Móvil primero.** Las apps de vecino y de mesa directiva son una columna de máximo 480 px, centrada en pantallas grandes.
- **Ritmo de 4/8 px:** `xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48`.
- **Objetivos táctiles:** 48 px como mínimo, 56 px para la acción principal y 72 px en el kiosco de caseta (se usa de pie, con prisa, a veces con guantes).
- **Portal de escritorio:** un menú lateral que en pantallas angostas pasa a fila de botones envolventes (`flex-wrap` y una container query, sin media queries). El contenido es un *container* (`container-type: inline-size`) y sus tarjetas se acomodan con container queries.
- **Rejillas intrínsecas:** `repeat(auto-fit, minmax(min(100%, 14rem), 1fr))`. Nunca hay scroll horizontal.
- La barra inferior móvil respeta `env(safe-area-inset-bottom)`.

## Elevation & Depth

Hay tres niveles y nada más:

1. **Plano.** Fondo `background`.
2. **Tarjeta.** `surface` más un borde de 1 px (`border`) y una sombra muy suave. En modo oscuro manda el borde, no la sombra.
3. **Diálogo.** `<dialog>` modal con un `::backdrop` negro al 50 % y una sombra amplia.

## Shapes

- `rounded.md` (12 px) para botones y campos, `rounded.lg` (20 px) para tarjetas y diálogos, `rounded.full` para chips y avatares.
- Los iconos son de trazo de 2 px con extremos redondeados (familia tipo Lucide), en SVG en línea. Nunca se usan emojis como iconos.

## Motion & Micro-interaction

- `fast` (150 ms) para presionar y pasar el cursor. `base` (220 ms) para abrir hojas y desplegar detalles. `exit` (140 ms) para cerrar, que va más rápido que abrir.
- Al presionar un botón, este se escala a 0.98. Los `<details>` se abren animando la altura (`interpolate-size: allow-keywords` + `::details-content`) como mejora progresiva.
- Con `prefers-reduced-motion: reduce` las duraciones se vuelven 0 desde los tokens, sin reglas con `*`.
- El movimiento explica causa y efecto. Nunca se anima para decorar.

## Voice & Content Strategy

Se habla de **tú**, con calidez y frases cortas. Los botones son verbos. Las
fechas se escriben en palabras y los montos llevan signo de pesos y centavos.

| En el sistema (API) | En pantalla |
| :--- | :--- |
| Cargo / cuota | **Cuota** ("Cuota de mantenimiento de noviembre") |
| Pago en línea | **Pagar ahora** |
| Comprobante | **Ya pagué, subir comprobante** |
| Auto-Pay | **Pago automático** |
| Egreso | **Gasto** |
| Morosidad / morosos | **Casas con pago pendiente** (nunca con nombres fuera de administración) |
| Ticket | **Reporte** ("Reportar un problema") |
| Invitación QR | **Pase de visita** |
| Amenidad / reservación | **Área común / apartar** |
| Comunicado | **Aviso** |
| Bitácora de accesos | **Quién entró hoy** |
| Condonar | **Perdonar el adeudo** |
| CFDI / timbre | **Factura / facturas disponibles** |
| Organización / tenant | **Despacho** |

Reglas:

- Fechas: "sábado 28 de noviembre", "9:42 pm". Nunca "2026-11-28".
- Montos: "$1,450.00". Si hay duda, se agrega "MXN".
- Un error dice **qué pasó y qué hacer**: "Este código ya se usó. Pide a la persona que te enseñe su pase nuevo o llama a la Casa 23."
- Nunca se culpa al usuario ni se usan códigos de error a la vista.
- **Privacidad (LFPDPPP):** el guardia nunca ve adeudos y la mesa directiva ve el número de casas pendientes, no sus nombres. Una negación en caseta por adeudo se muestra como "No autorizado. Pide al residente que llame a administración".

## Components

- **Botón principal** (`button-primary`): de 56 px de alto, ocupa todo el ancho en móvil y lleva icono más verbo. Hay uno solo por pantalla.
- **Botón secundario** (`button-secondary`): borde `border-strong`, texto `primary`.
- **Botón de peligro** (`button-danger`): con contorno, texto `danger` y separado del principal.
- **Tarjeta** (`card`): el contenedor por defecto, con `padding` de 24 px.
- **Chip de estado** (`status-*`): icono, texto corto y fondo suave. Se usa para *Pagado · Pendiente · Venció · Conectado*.
- **Mosaico de acción** (`tile`): icono en caja de 48 px más una etiqueta de dos palabras. Va en una rejilla 2×2 en el inicio del residente.
- **Opción** (`choice-selected`): grupo de radios con apariencia de botones. Se estiliza con `:has(:checked)` y sin JS.
- **Campo** (`input`): etiqueta visible arriba, ayuda debajo y error con icono que aparece solo tras interactuar (`:user-invalid`).
- **Veredicto de caseta** (`verdict-allowed` / `verdict-denied`): banda completa con un icono de 56 px y "PUEDE PASAR" o "NO PUEDE PASAR".
- **Teclado de caseta** (`keypad-key`): teclas de 72 px con cifras tabulares.
- **Diálogo** (`<dialog>`): se abre con `command="show-modal"` (Invoker Commands) y se cierra tocando fuera (`closedby="any"`). En móvil sube como hoja inferior.
- **Barra de progreso** (`<progress>`): siempre va acompañada del número en texto.

## Do's and Don'ts

**Do**

- Usar elementos nativos (`<dialog>`, `<details>`, `<progress>`, `<button>`, `<label>`) antes que componentes inventados.
- Empezar cada pantalla con la respuesta ("Tienes $1,450.00 por pagar") y después la acción.
- Mantener visible el camino de regreso y la ayuda humana ("Llamar a administración").
- Confirmar las acciones que no se pueden deshacer (rechazar un comprobante, no dejar pasar a alguien).
- Probar a 375 px, con el texto del sistema al 200 % y en modo oscuro.

**Don't**

- Poner nombres de vecinos con adeudo en avisos, en la caseta o en la vista de la mesa directiva.
- Usar jerga como "cargo", "egreso", "ticket", "CFDI", "tenant" o "dashboard".
- Poner botones solo con icono, texto debajo de 14 px o gris claro sobre gris.
- Usar degradados decorativos, morados o rosas "de IA", ni emojis como iconos.
- Mostrar errores antes de que la persona termine de escribir.
