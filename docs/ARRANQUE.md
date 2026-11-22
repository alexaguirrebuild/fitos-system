# Prompt de arranque · sesión nueva de FITOS (22-nov-2026)

Pega todo lo que hay debajo de la línea en la sesión nueva, abierta en `C:\Users\Alex Aguirre\Documents\sistema-fisico` (rama `main`).

---

Arrancamos en modo ingeniería agéntica sobre `fitos-system`. Todavía no se escribe código de producto.

## Contexto verificado el 22-nov (manda sobre `TRASPASO.md`, que es del 15-nov y está desfasado)

- **Producción:** https://fitos-system.vercel.app, sobre Supabase real. Vercel despliega con el CLI (`npx vercel@latest deploy --prod --yes`) y todavía no está conectado a GitHub. Repo privado: `alexaguirrebuild/fitos-system`.
- **Ya funciona en producción:**
  - El webhook de Health Connect sincroniza pasos y sueño. Hay una fuente por origen, así que móvil y reloj no se suman.
  - Muse está conectado por OAuth con los permisos `mcp:read` y `mcp:log`, y registra comidas con estimación.
  - El histórico real está importado: 106 sesiones y 2.154 series, del 30-jun al 20-nov.
  - El programa `alex-torso-pierna-5d` está activo desde el 21-nov. Su rueda es: sábado descanso, domingo Hombro + brazo, Pierna A, Torso A, descanso activo, Pierna B, Torso B. Lo que se decidió y por qué está en `docs/RUTINAS.md` §8.
  - La nutrición está en fase de calibración (On 3.076 / Off 2.725 kcal) hasta tener 14 días de peso y comida.
- **Suite:** 301 tests sobre PGlite.
- **Lo que falta, comprobado en el repo:**
  - No hay CI (`.github/workflows`), ni Playwright, ni `.claude/settings.json`.
  - `AGENTS.md` solo tiene el bloque de Next.js.
  - El MCP tiene **66 herramientas**.
  - Ficheros grandes: `nutrition.ts` (78,5 KB), `training.ts` (57,5 KB), `athlete.ts` (42,3 KB) y `today.ts` (27,8 KB).
  - `api/media/upload` recibe el vídeo entero por `formData()`. Con el límite de 4,5 MB de Vercel, un vídeo real falla. La subida a Drive sí va por trozos.
- **Hipótesis sin verificar (hay que medirlas, no darlas por buenas):**
  - Que «Empezar» se congela o va lento.
  - Que quedan 69 ejercicios sin enlazar (el dato es del import del 15-nov, no del de producción).
  - Que la restricción del tobillo no se puede quitar. Ojo: `fit.injuries` ya tiene el estado `cerrada`.

## Documentos que hay que leer primero

`docs/MOTOR.md`, `docs/RUTINAS.md`, `docs/MUSE.md`, `docs/RELOJ.md`, `docs/DRIVE.md`, `AGENTS.md`, `TRASPASO.md` (como histórico) y `git log --oneline -40`.

## Tarea de esta primera vuelta: solo diagnóstico, devuelto en bloques cortos para que yo apruebe

1. **Poner `TRASPASO.md` al día** con el estado real del 22-nov: sale de este contexto, del git log y de consultas de solo lectura a Supabase.
2. **Arnés.** Propuesta concreta para cada pieza:
   - CI en GitHub Actions: `tsc --noEmit`, `eslint`, `vitest run` y `next build`.
   - Conectar Vercel a GitHub: `main` despliega producción y cada rama genera un preview.
   - Reglas `deny` en `.claude/settings.json`: `rm -rf`, `git push --force`, `DROP`/`TRUNCATE`, leer o subir `.env`, `evidencia/` y PDFs médicos.
   - `AGENTS.md` con invariantes y comandos.
   - `docs/coding-standards.md` para el revisor.
   - Para los dos últimos, parte del borrador de NotebookLM con dos cambios:
     - Los comentarios que explican el porqué se permiten. Solo se rechazan los que tapan un workaround.
     - El revisor con contexto limpio es obligatorio en cambios de motor, datos, auth y migraciones. En lo trivial es opcional.
3. **Medir antes de diagnosticar, en producción y con solo lectura:**
   - El tiempo real de «Empezar» en `/entreno`: queries, idas y vueltas a la base de datos, render.
   - De dónde sale `ankleRule` (ficha del onboarding frente a `fit.injuries`) y si la UI deja cerrar la lesión.
   - El recuento real de ejercicios sin enlazar en Supabase, agrupados por nombre y con variantes de máquina o polea (laterales, tríceps). Me los presentas para que los mapee en 2 minutos. No se toca ningún dato sin mi OK.
4. **Mapa del MCP:**
   - Clasifica las 66 herramientas en (A) uso diario de Muse/Claude, unas 15, y (B) admin o secundarias.
   - Antes de quitar ninguna, revisa qué flujos de Muse dependen de cada una (`docs/MUSE.md`) y propón herramientas compuestas o un perfil «diario».

## Roadmap completo, en paralelo con el Experimento 1 de negocio (23-nov → 13-dic)

- **Fase 0 · Arnés:**
  - Vercel conectado a GitHub, CI, `AGENTS.md`, `coding-standards.md` y reglas `deny`.
- **Fase 1 · Estabilizar y limpiar datos:**
  - Corregir lo que salga de la medición de «Empezar».
  - La lesión del tobillo, visible y revocable.
  - Mapear los ejercicios huérfanos con un script idempotente.
  - Añadir 10-15 alimentos base al seed.
  - Subida de vídeo directa del navegador a Drive, o desactivarla hasta tenerla.
  - Playwright E2E de 5 flujos: login → check-in → empezar y guardar 2 series → registrar comida → «Hoy» refleja los cambios.
- **Fase 2 · Explicabilidad + Health Connect:**
  - Panel histórico con SQL determinista: series efectivas frente a MEV/MRV, ejercicios estancados y frecuencia por músculo.
  - Tarjeta «Por qué hoy toca X», que lee las anotaciones.
  - Comprobar en el S24 que sueño, pasos y FC en reposo alimentan `deloadDecision`.
  - Recorte del MCP y rate limit en `/api/mcp` y `/oauth/token`.
- **Fase 3 · Bucle semanal:**
  - Trocear los ficheros grandes solo cuando un ticket los toque.
  - Repaso cada domingo: cada fallo repetido se convierte en regla de lint, script o test.
  - 14 días de datos limpios antes de tocar macros.

## Forma de trabajo

- Una sesión es un ticket, en su rama o worktree.
- Una sesión implementa y otra revisa con contexto limpio, siguiendo `coding-standards.md`.
- No se debilita ningún test sin mi OK.
- Nada se da por terminado sin ejecutarlo y enseñarme la prueba.
- Nunca se pegan contraseñas ni tokens. Los datos personales no entran en git.
