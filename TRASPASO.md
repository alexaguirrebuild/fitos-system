# TRASPASO · FITOS SYSTEM

Actualizado el 22-nov-2026. Sustituye al del 20-nov. Cada dato dice de dónde sale: **[prod]** leído hoy en producción, **[repo]** leído en el código, **[local]** medido en local con el mismo importador y el mismo export, **[contexto]** del brief de Alex del 22-nov sin re-verificar.

## Dónde está cada cosa

| Pieza | Valor | Fuente |
|---|---|---|
| Producción | https://fitos-system.vercel.app (proyecto Vercel `fitos-system`, plan Hobby) | [prod] |
| Región de las funciones | **iad1 (Washington)** | [prod] `get_deployment` |
| Base de datos | Supabase `gmxzktvjuwtohuarztvn`, pooler de transacciones en **eu-west-1 (Irlanda)**, esquema `fit` | [repo] `scripts/importar-historico.ps1` |
| Despliegue | CLI (`npx vercel@latest deploy --prod --yes`). Vercel aún no está conectado a GitHub | [prod] `source: cli` |
| Repo | `alexaguirrebuild/fitos-system`, privado, `main` al día con `origin` | [prod] `gh repo view` |
| Ramas vivas | `claude/great-nash-727c01`, `claude/rediseno-frontend-158662` e `investigacion/gimnasio-reloj-drive`, con worktrees. Las tres ya están fusionadas en `main` | [repo] `git worktree list` |

La base de producción **no** está en el conector de Supabase de Claude (pertenece a otra cuenta). Leerla exige la contraseña de la base, que pone Alex.

## Qué funciona en producción

| Pieza | Estado | Fuente |
|---|---|---|
| Webhook de Health Connect (`/api/ingest/hc-webhook`) | Llega cada hora (12 POST con 200 entre las 04:21 y las 14:11 UTC del 22-nov). Un origen por app: móvil y reloj no se suman | [prod] registros de peticiones · [contexto] |
| Muse por OAuth (`mcp:read` + `mcp:log`) | Usándose hoy: `/oauth/token` y ráfagas de `/api/mcp` con 200 | [prod] registros de peticiones |
| Histórico | 106 sesiones, 2.154 series, del 30-jun al 20-nov | [local] mismo export del 21-nov · [contexto] |
| Programa activo | `alex-torso-pierna-5d` desde el 21-nov. Rueda y motivos en `docs/RUTINAS.md` §8 | [contexto] |
| Nutrición | Calibración (On 3.076 / Off 2.725 kcal) hasta tener 14 días de peso y comida | [contexto] |
| Drive | Cliente OAuth publicado y las 4 variables en Vercel. Sin probar una subida real | `docs/DRIVE.md` §5 |

## Medido el 22-nov (diagnóstico, nada corregido todavía)

### «Empezar» va lento: es la región, no un bloqueo

- Cada ida y vuelta a la base cruza el Atlántico. Con GET de solo lectura en producción: página sin base ~170 ms, `/mas` (6 consultas) ~560 ms, `/entreno` ~1,03 s y la vista de una sesión ~1,25-1,32 s. Sale a **~65 ms por consulta**. [prod]
- Pulsar «Empezar» hace **45 idas y vueltas en serie**: 23 en la acción (`startWorkout` crea la sesión y además calcula la vista completa, que se tira) y 22 en la página de destino (layout + `getWorkoutView`, que vuelve a calcular la misma vista). [local] Son **~2,5-3 s** sin ningún aviso en el botón.
- Además, la lista «Últimas sesiones» precarga cada enlace: se vieron 13 GET a `/entreno/[id]` en medio segundo, cada uno con ~16 consultas. [prod]
- Hubo una ráfaga de 12 POST a `/entreno`, 6 a `/entreno/<id>` y 5 a `/nutricion` en 14 s (13:42 UTC del 22-nov). Encaja con toques repetidos o con la cola sin conexión vaciándose desde varias pestañas. **Sin confirmar**: hace falta mirar en la base qué se escribió a esa hora.

### Tobillo

- `ankleRule` solo mira números de dolor: el apunte de hoy (`fit.injury_logs`), el check-in de hoy (`checkins.ankle_pain`) o, si la lesión **no** está cerrada, el último de los 3 días anteriores. El estado `cerrada` de `fit.injuries` solo corta ese arrastre de 3 días. [repo] `athlete.ts:ankleStatusTx`
- **Trampa 1**: `painDayAfterLegs` sale del check-in del día después de la última pierna y **no mira si la lesión está cerrada**. Un > 3 de entonces restringe hasta la siguiente sesión de pierna.
- **Trampa 2**: el deslizador del check-in arranca con el último dolor. Con la lesión abierta, guardar sin moverlo vuelve a escribir el mismo valor y la restricción se renueva sola.
- Cerrar la lesión **sí se puede**, pero está escondido: Ajustes → «Editar en la ficha guiada» → «Ya no molesta: cerrar la lesión». [repo]
- Hoy, 22-nov, ni Hoy, ni Bienestar, ni Entreno muestran restricción. [prod]

### Ejercicios sin enlazar

- **70 nombres y 234 series (10,9 %)** sin enlazar tras el import. Muchos son notas pegadas al nombre en la app antigua, incluidas sesiones de sentadilla que hoy no cuentan para el histórico de pierna. [local]
- **Fase 1 (rama `fase-1/mapa-ejercicios`)**: 7 ejercicios nuevos en el seed y `scripts/enlazar-huerfanos.ps1` (simulacro → confirmación → `db:seed` → enlace), que aplica el mapa de `VIDA/entrenamiento/mapa-huerfanos-2026-11-22.md`. En local, con el export del 21-nov: 234 → 0 series sueltas; repetido, 0 cambios. [local] **Aplicado en producción el 22-nov por Alex**: seed sin migraciones pendientes (155 ejercicios), 234 series de 70 nombres enlazadas, 0 sueltas. [prod, salida del script]
- **Ajustes (rama `fase-1/ajuste-ejercicios`)**: `scripts/ajustar-ejercicios.ps1` fusiona `remo-pecho-apoyado-banco-multipower` en `remo-ancho-apoyado-en-mp` (era el mismo; borra el vacío, también del catálogo común), pone mancuernas a la elevación frontal y quita 32 alias que eran notas (lista en `VIDA/entrenamiento/alias-a-quitar-2026-11-22.md`). En local, con el estado de producción: 3 series al remo ancho, 32 alias fuera, 0 sueltas; repetido, 0 cambios. [local] **Aplicado en producción el 22-nov por Alex**: seed con 154 ejercicios y 97 alimentos (los 17 nuevos), fusión del remo (3 series movidas, copia propia del remo ancho creada), mancuernas en la elevación frontal y 40 alias quitados (32 nombres), sin errores. [prod, salida del script]
- Ojo al reimportar el histórico (`import:legacy`): reinserta las series y las enlaza por nombre, slug y alias. Las de los alias quitados vuelven a quedar sueltas: hay que repetir `enlazar-huerfanos` con el mapa de VIDA (ya apunta a `remo-ancho-apoyado-en-mp`). [repo]
- Ojo: `linkRawName`/`addAlias` crean una copia propia del ejercicio común, que lo tapa. Un cambio del seed (equipo, vídeo, nota) no llega a esas copias: hay 27 tras el enlace. [local]
- El dato de producción puede ser menor si desde entonces se usó `link_exercise_name`. Ya existen `list_unlinked_exercise_names` y `link_exercise_name` (enlazan y guardan el alias), pero solo por MCP. No hay pantalla. [repo]

### MCP

- Son **65 herramientas**, no 66 (el 66 contaba la definición de `defineTool`): 28 de lectura, 24 de registro y 13 de plan. Muse, con `read` + `log`, ve 52. `docs/MUSE.md` dice 62: le faltan `get_nutrition_targets`, `list_unlinked_exercise_names` y `link_exercise_name`. [repo]

## Qué falta (comprobado en el repo)

- No hay CI (`.github/workflows`), ni Playwright, ni `.claude/settings.json` del proyecto.
- `AGENTS.md` solo trae el bloque de Next.js.
- `evidencia/` y `docs/ARRANQUE.md` están sin seguimiento y `evidencia/` no está en `.gitignore`.
- Ficheros grandes: `nutrition.ts` (78,5 KB), `training.ts` (57,5 KB), `athlete.ts` (42,3 KB) y `today.ts` (27,8 KB). [contexto]
- `api/media/upload` recibe el vídeo entero por `formData()`. Con el límite de 4,5 MB de Vercel, un vídeo real falla. La subida a Drive sí va por trozos. [contexto]
- Sin límite de peticiones en `/api/mcp` ni en `/oauth/token`. [repo]
- Plan Hobby: los registros de ejecución duran 1 h y los de peticiones 12 h, sin duración por petición. Para medir tiempos hace falta instrumentar (`Server-Timing`) o medir desde el navegador.

## Cómo medir sin tocar datos

- Tiempos: GET con cabecera `RSC: 1` desde el navegador con sesión iniciada (lo que se hizo hoy).
- Consultas por flujo: envolver el `Db` de PGlite y contar (`openMemoryDb` + `seedCatalog` + `importLegacy` + `activateProgram`).
- Base de producción: solo con transacción `read only` y la contraseña puesta por Alex en el momento (como en `scripts/importar-historico.ps1`).

## Documentos

`docs/MOTOR.md` (motor y PMID), `docs/RUTINAS.md` (programa), `docs/MUSE.md` (MCP), `docs/RELOJ.md` (Health Connect), `docs/DRIVE.md`, `docs/GIMNASIO.md`, `docs/DISENO.md`. Investigación de origen: `CEREBRO/research/_inbox/2026-11-20-sistema-fitness-arquitectura/`.
