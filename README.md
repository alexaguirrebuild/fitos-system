# FITOS SYSTEM

Sistema operativo físico personal de Alex: entreno con progresión propuesta, nutrición On/Off, cardio y reloj, y un servidor MCP con OAuth para manejarlo desde Muse. Sustituye a `SISTEMA-ALEX-APP`.

Estado, credenciales pendientes y lo que no está verificado: [`TRASPASO.md`](TRASPASO.md).

## Arrancar en local (sin credenciales)

```bash
npm install
cp .env.example .env.local     # AUTH_MODE=dev ya viene puesto
npm run db:seed                # crea la base local (.data/pglite) y carga el catálogo
npm run import:legacy -- "../VIDA/_datos/supabase-2026-11-15"   # opcional: tus 102 sesiones
npm run dev
```

Sin `DATABASE_URL` la app usa PGlite: Postgres real embebido, con las mismas migraciones y el mismo RLS que producción. No hace falta Docker.

## Piezas

| Carpeta | Qué hay |
|---|---|
| `src/engine/` | Motor científico: funciones puras con tests. Mapa en [`docs/MOTOR.md`](docs/MOTOR.md) |
| `supabase/migrations/` | Esquema `fit` (no expuesto por la API de Supabase) con RLS por fila |
| `src/db/client.ts` | Una interfaz, dos motores (pg en producción, PGlite en local). `withUser()` activa el RLS |
| `src/server/services/` | Casos de uso: entreno, plan, bienestar, nutrición, cardio, salud, medios |
| `src/server/oauth.ts`, `src/server/mcp/` | Servidor OAuth 2.1 (registro dinámico, PKCE) y herramientas MCP |
| `src/app/` | PWA (Next.js 16) y rutas: `/api/mcp`, `/api/ingest/health`, `/oauth/*`, `/.well-known/*` |
| `data/seed/` | Catálogo: ejercicios, programas, glosario y alimentos |
| `scripts/` | Semillas, importación del histórico y extractores de los Excels |

## Comandos

| Comando | Para qué |
|---|---|
| `npm test` | Motor, base de datos con RLS, servicios, OAuth y MCP |
| `npm run typecheck` | Tipos |
| `npm run build` | Compilación de producción |
| `npm run db:seed` | Migraciones (en Postgres) y catálogo. Idempotente |
| `npm run import:legacy -- <carpeta>` | Hereda el histórico de la app antigua. Idempotente |
| `npm run hash-password` | Genera `OWNER_PASSWORD_HASH` |

## Reglas del repo

- `.env*` no se sube (solo `.env.example`). Las claves de la app antigua no se copian aquí.
- Ninguna fórmula vive en una pantalla: todo cálculo está en `src/engine/` con su test.
- Todo dato del atleta pasa por `withUser()`. El rol propietario solo se usa para el alta, OAuth y tokens de ingesta.
- Los Excels originales y los exports con datos personales se quedan fuera del repo.
