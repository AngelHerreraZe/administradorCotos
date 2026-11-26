# apps/web — Portal web (Next.js 16)

Portales de administración, despacho, mesa directiva y residente. Fuera del alcance del plan de backend: consume `apps/api` y los contratos de `@admcotos/shared`.

Crear cuando inicie el frontend: `npx create-next-app@latest apps/web --ts --app --eslint=false` (lint y formato los da Biome). Diseño: [DESIGN.md](../../DESIGN.md). Antes de cada pantalla, consulta modern-web-guidance (AGENTS.md §4): CSP con nonce, Trusted Types, cookies `__Host-`, rendimiento y accesibilidad.
