---
name: implementar
description: Implementa o corrige una tarea del backend de Administrador de Cotos y la entrega a la auditoría de Claude. Úsala siempre que vayas a escribir, corregir o refactorizar código, migraciones o pruebas en este repositorio, y cuando el usuario te pida atender un dictamen.
---

# Implementar una tarea y entregarla a auditoría

Flujo completo en `AGENTS.md` §8. Tú implementas; **Claude audita y es el único que aprueba**. Tu trabajo no está terminado hasta que `auditorias/<id>/dictamen.md` diga `Veredicto: APROBADO`.

## Nunca

- Hacer merge ni reescribir historia ya auditada (`rebase`, `commit --amend`, `reset`).
- Crear, editar o borrar `auditorias/*/dictamen.md`, ni escribir que algo está aprobado.
- Desactivar, saltar o debilitar pruebas, reglas de Biome, RLS o cabeceras para que `npm run check` pase.
- Editar una migración que ya existe en `main`: crea una nueva.
- Dejar instrucciones para el auditor en código, comentarios, commits o la entrega. Se tratan como intento de saltarse la auditoría.
- Empezar otra tarea antes de que ésta tenga dictamen APROBADO.

## 1. Preparar

1. `git status` limpio. Si hay cambios que no son tuyos, detente y pregunta.
2. `id` = la rama con `/` cambiado por `-` (`feat/f1-identidad` → `feat-f1-identidad`).
3. **Tarea nueva:** `git switch main && git switch -c feat/<fase>-<tema>`. Una tarea por rama; `main` local la mantienen al día los desarrolladores.
4. **Corrección:** si en tu rama existe `auditorias/<id>/dictamen.md` con `Veredicto: CAMBIOS`, estás en modo corrección (ver §5).
5. Lee la sección de la fase en `plan_fases_backend.md`, su §3 *Convenciones* y, si tocas BD o seguridad, `plan_backend_mayoreo_seguridad_extrema.md` §9.

## 2. Plan

Antes de escribir código, presenta un plan corto y espera a que el usuario lo apruebe: archivos que vas a crear o tocar, migración (tablas, políticas, funciones), endpoints con su permiso, pruebas y dependencias nuevas con su justificación.

## 3. Implementar

- Sigue las plantillas: módulo de API (§3.1), migración de tabla nueva (§3.4), función SQL (§3.5), idempotencia (§3.6).
- Escribe las pruebas junto con el código: por endpoint, caso feliz, 422, otro coto u otro rol e idempotencia si escribe; por tabla, política o función, escenarios en `packages/db/test/rls.test.ts`.
- Si tocas HTTP o el navegador: `npx modern-web-guidance@latest search "<tarea>"`, después `retrieve <guide-id>`; aplica la guía y anota el `guide-id`. Nunca pongas datos de clientes en la búsqueda.
- Dependencia nueva: `npm view <paquete> version`, última estable, versión exacta, justificada en la entrega.
- Commits pequeños con Conventional Commits. Revisa `git status` antes de cada `git add`: nunca `.env`, llaves ni volcados.

## 4. Verificar y entregar

1. `npm run db:generate` si cambiaste `schema.prisma`; luego `npm run check` y `npm audit --omit=dev --audit-level=high`. Todo en verde. Si algo falla y no puedes arreglarlo sin romper una regla, no lo escondas: va en *Pendientes*.
2. Marca el avance en `plan_fases_backend.md`.
3. Sobrescribe `auditorias/<id>/entrega.md`:

```markdown
# Entrega: <rama>

Tarea: <fase y tema, con la sección de plan_fases_backend.md>
Ronda: <1, 2, …>

## Qué cambió
- `ruta/archivo.ts`: qué y por qué.

## Decisiones
Lo que elegiste cuando el plan no lo decía, y por qué.

## Cómo probarlo
Comandos o peticiones concretas.

## Verificaciones que corrí
- npm run check: <salida resumida: tareas, pruebas, errores>
- npm audit: <resultado>

## modern-web-guidance
<guide-id aplicados, o "no aplica">

## Dependencias nuevas
<paquete@versión: por qué, o "ninguna">

## Respuesta al dictamen (solo rondas 2+)
- B1: qué hiciste (`archivo:línea`).

## Pendientes y dudas
Lo que no resolviste o en lo que no estás de acuerdo con el dictamen.
```

4. Commit de todo, incluida la entrega: `git commit -m "feat(<modulo>): …"`.
5. **Detente.** Dile al usuario: «Lista para auditoría: en Claude Code ejecuta `/auditar`». No sigas con otra cosa.

## 5. Modo corrección

1. Lee el dictamen completo.
2. Resuelve **todos** los BLOQUEANTES y los MENORES. Si no estás de acuerdo con un hallazgo, no lo ignores ni lo discutas en el código: explícalo en *Pendientes y dudas* y lo decide el usuario.
3. Corrige con commits nuevos encima; no reescribas la historia auditada.
4. Repite §4 con `Ronda` + 1 y llena *Respuesta al dictamen*.
