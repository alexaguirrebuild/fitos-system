# FITOS SYSTEM · instrucciones para agentes

App personal de Alex: entreno con progresión, nutrición On/Off, cardio y reloj, y un servidor MCP con OAuth para Muse. Producción en https://fitos-system.vercel.app sobre Supabase. Antes de tocar nada, lee [`TRASPASO.md`](TRASPASO.md) (estado real) y el documento del área que toques en `docs/`.

## Comandos

| Comando | Para qué |
|---|---|
| `npm test` | 301 tests sobre PGlite (motor, RLS, servicios, OAuth, MCP). Sin Docker ni credenciales |
| `npm run typecheck` · `npm run lint` · `npm run build` | Lo mismo que corre la CI (`.github/workflows/ci.yml`) |
| `npm run dev` | Local con PGlite en `.data/pglite` y `AUTH_MODE=dev` |
| `npm run db:seed` · `npm run import:legacy` | Catálogo e histórico. Contra producción, solo con OK de Alex |

Node 26 (`engines` en `package.json`, igual que Vercel).

## Invariantes

1. **Ningún cálculo fuera de `src/engine/`.** Cada fórmula lleva su test y su grado (evidencia, fórmula, derivada o heurística) en `docs/MOTOR.md`, con PMID si es evidencia.
2. **Datos del atleta, solo por `withUser()`.** `asSystem()` es para el alta, OAuth y los tokens de ingesta.
3. **Migraciones: siempre un fichero nuevo y numerado** en `supabase/migrations/`. Una migración aplicada no se edita. Toda tabla del atleta lleva RLS y un test de aislamiento.
4. **Toda entrada pasa por zod**: acciones, rutas, herramientas MCP y webhooks.
5. **Herramienta MCP nueva**: scope correcto, test en `tests/mcp-tools.test.ts` y su fila en `docs/MUSE.md`.
6. **Nada personal en git**: ni `.env`, ni exports, ni `evidencia/`, ni PDFs, ni los nombres crudos del histórico. Eso vive en `~/Documents/VIDA/`.
7. **Producción se lee, no se escribe**, salvo OK explícito de Alex. La base, en transacción `read only`. Ningún agente borra esquema ni datos. `.claude/hooks/bloquear-sql-destructivo.mjs` frena los errores obvios (DROP, TRUNCATE, DELETE/UPDATE sin WHERE, `supabase db reset`), pero no es una frontera: el SQL en fichero no lo ve.
8. **No se debilita ni se borra un test sin OK de Alex.**

## Cómo se trabaja

- Una sesión es un ticket y una rama (o worktree). `main` es producción.
- Antes de pedir revisión: CI en verde en local (`typecheck`, `lint`, `test`, `build`).
- Revisión con contexto limpio según [`docs/coding-standards.md`](docs/coding-standards.md). Es **obligatoria** en motor, datos, migraciones, auth/OAuth, MCP y CI; opcional en lo trivial (textos, estilos, docs).
- **Terminado** = ejecutado y con prueba en el PR o en el mensaje: salida de los tests, captura o petición y respuesta. Lo no probado se dice. Cada commit termina con `Verificado: <cómo>` (aunque sea `ninguno`).
- A la tercera ronda fallida, para y llama a Alex.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
