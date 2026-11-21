# Muse y el servidor MCP

El servidor MCP vive en `<APP_URL>/api/mcp`. Es Streamable HTTP sin estado, detrás del OAuth 2.1 propio de la app.
Código: `src/server/mcp/` (una lista de herramientas por fichero `tools-*.ts`, todas declaradas con `defineTool`). Tests: `tests/mcp.test.ts` (transporte y OAuth) y `tests/mcp-tools.test.ts` (herramientas).

## Conectar Muse

Pégale esto, cambiando `<APP_URL>` por la dirección de la app:

> Crea un conector a medida llamado "sistema-fisico". Es un servidor MCP remoto (Streamable HTTP) en <APP_URL>/api/mcp. Usa OAuth 2.1: devuelve 401 con WWW-Authenticate y metadatos en /.well-known/oauth-protected-resource/mcp, y admite registro dinámico de cliente. Cuando se abra la pantalla de consentimiento, la apruebo yo.

Lo que pasa después:

1. Muse llama sin token, recibe el 401 y lee los metadatos.
2. Se registra solo como cliente (`POST /oauth/register`).
3. Abre la pantalla de consentimiento. Ahí eliges los permisos y apruebas con tu sesión.
4. Muse guarda su token y lo renueva solo.

La primera vez, dile: «Llama a `whoami` y a `server_guide`, y después a `get_today`». `server_guide` le da el flujo y las reglas.

Conectado de verdad el 21-nov-2026 en `https://fitos-system.vercel.app/api/mcp` (cliente «Muse», redirect `https://agent.meta.ai/api/hatch/oauth/callback`). Lo que el cliente de Meta hace distinto y la app ya tolera:
- Se come la barra de las rutas de OAuth: pide `/oauthorize` y `/oauthtoken`. Hay alias en `src/app/oauthorize`, `oauthtoken`, `oauthregister` y `oauthrevoke`.
- Manda los scopes en un formato que el validador estricto rechazaba (`invalid_scope`). Ahora se aceptan comas o «+» y se ignoran los scopes desconocidos.
- `resource` se acepta con cualquier ruta del mismo origen; el token queda ligado a `/api/mcp`.
- Antes de conectar, Sentinel (el filtro de Muse) pide permiso para hablar con el dominio. Eso lo aprueba Alex, no un agente.
- Si algo se rechaza en `/oauth/authorize`, queda en el log de Vercel como `[oauth/authorize] rechazo {…}`, sin secretos.

## Qué permisos dar

| Permiso | Qué permite | Cuándo darlo |
|---|---|---|
| `mcp:read` | Leer estado, plan, historial y nutrición | Siempre |
| `mcp:log` | Registrar series, comida, peso, check-in, pasos, cardio, cafeína, dolor y notas | Siempre: es el uso diario |
| `mcp:plan` | Cambiar el programa, la descarga, el volumen, los objetivos de calorías, la ficha, los precios y la librería | Solo si quieres que Muse pueda tocar el plan. Sin él, Muse propone y tú lo cambias en la app |

Recomendado para el día a día: `mcp:read` + `mcp:log`. Muse solo ve las herramientas de los permisos concedidos; las demás ni se listan.

## Herramientas

62 en total: 26 de lectura, 24 de registro y 12 de plan. Las fechas son opcionales (por defecto, hoy en tu zona horaria). Cada escritura devuelve un `summary` en una línea y, si aplica, `warnings`. Cada escritura deja una línea en `fit.audit_log` con el cliente que la hizo.

### Lectura (`mcp:read`)

| Herramienta | Para qué |
|---|---|
| `whoami` | Atleta, permisos, fecha de hoy y zona horaria |
| `server_guide` | Flujo recomendado y reglas de uso |
| `get_today` | Todo lo de hoy en una llamada: la acción pendiente, check-in, tobillo, sesión con cargas, comida, pasos, carga y peso |
| `get_plan` | Programa activo: macrociclo, mesociclo, microciclo n de m y la rueda de sesiones con su pauta |
| `get_next_session` | Qué sesión toca y por qué, con la pauta de cada ejercicio |
| `get_workout` | Una sesión (la que está en curso si no das id): objetivos, series con su id y totales |
| `list_workouts` | Sesiones recientes con fecha, estado, series, tonelaje y esfuerzo |
| `get_exercise_history` | Últimas sesiones de un ejercicio, mejor 1RM estimado y tendencia |
| `search_exercises` | Buscar ejercicios por nombre, alias o grupo muscular |
| `find_exercise_alternatives` | Sustitutos del mismo músculo y patrón; con `ankleSafe`, sin carga de tobillo |
| `get_nutrition_day` | Día On/Off, objetivo, comido, restante, apuntes con su id, cafeína y pasos |
| `search_foods` | Buscar alimentos del catálogo con macros por 100 g y precio |
| `lookup_barcode` | Alimento por código de barras (catálogo propio y Open Food Facts) |
| `get_progress` | Tendencia de peso y cintura, 1RM de los 6 ejercicios más entrenados y adherencia |
| `get_load_status` | Ratio de carga aguda/crónica, estrés por grupo y decisión de descarga con sus señales |
| `get_volume_status` | Series efectivas por grupo frente a su mínimo y máximo, con consejo |
| `get_cardio_week` | Cardio de la semana, minutos por zona y lo que falta de zona 2 |
| `get_activity` | Pasos, sueño, pulso en reposo y variabilidad de los últimos días |
| `get_checkins` | Check-ins recientes y media de readiness |
| `list_annotations` | Avisos y notas sin descartar (récords, estancamientos, tobillo) |
| `get_glossary` | Definiciones del método (RIR, MEV, descarga…) |
| `get_onboarding_status` | Qué falta en la ficha y la pregunta exacta para pedirlo |
| `list_videos` | Vídeos de técnica con su enlace de Drive |
| `get_gear_patterns` | Rendimiento con y sin rodilleras, cinturón o cafeína |
| `list_meal_templates` | Comidas ancla con sus alimentos, calorías y coste |
| `list_program_templates` | Programas que se pueden activar |

### Registro (`mcp:log`)

| Herramienta | Para qué |
|---|---|
| `start_workout` | Abrir la sesión que toca (o una concreta, o una libre) con las cargas de hoy |
| `log_set` | Guardar una serie. Devuelve si es récord y la siguiente serie con su descanso |
| `update_set` | Corregir una serie guardada |
| `delete_set` | Borrar una serie (no se recupera) |
| `add_exercise_to_workout` | Añadir un ejercicio a la sesión |
| `swap_exercise` | Cambiar un ejercicio por otro solo en esa sesión |
| `finish_workout` | Cerrar la sesión con el esfuerzo percibido: carga, récords y avisos |
| `log_food` | Anotar comida: alimento + gramos, o kcal y macros a mano |
| `update_food_log` | Corregir un apunte de comida |
| `delete_food_log` | Borrar un apunte de comida (no se recupera) |
| `log_meal_template` | Anotar una comida ancla de un toque |
| `repeat_meal` | Copiar una comida de otro día |
| `log_body_metrics` | Peso, cintura y demás medidas |
| `log_checkin` | Check-in del día: calcula el readiness y qué sesión toca |
| `save_poms` | Guardar el test de estado de ánimo de 52 preguntas |
| `log_steps` | Pasos del día |
| `log_cardio` | Sesión de cardio: modalidad, minutos y pulso |
| `log_caffeine` | Cafeína con su hora; avisa si pasa del corte |
| `log_pain` | Dolor de una zona; con el tobillo devuelve la regla de hoy |
| `log_soreness` | Agujetas por grupo muscular |
| `add_note` | Dejar una nota firmada como de Muse |
| `dismiss_annotation` | Descartar un aviso ya visto |
| `register_video` | Registrar el enlace de Drive de un vídeo de técnica |
| `register_photo` | Registrar el enlace de Drive de una foto de progreso |

### Plan (`mcp:plan`)

Cambian el plan. Muse tiene orden de confirmarlo contigo antes de llamarlas.

| Herramienta | Para qué |
|---|---|
| `activate_program` | Cerrar el programa activo y empezar otro |
| `set_deload` | Marcar el microciclo actual como descarga, o quitarla |
| `set_volume_target` | Cambiar el mínimo y el máximo de series de un grupo |
| `recalc_nutrition_targets` | Recalcular calorías y macros de los días On y Off |
| `set_day_type` | Forzar un día como On u Off, o devolverlo a automático |
| `build_shopping_list` | Generar y guardar la lista de la compra de la semana |
| `weekly_review` | Revisión semanal: guarda el resumen y propone qué hacer con las calorías (no lo aplica) |
| `update_profile` | Cambiar la ficha: altura, peso objetivo, hora de acostarse, pasos, presupuesto, tiendas |
| `save_meal_template` | Crear o editar una comida ancla |
| `update_food_price` | Guardar el precio de un alimento con su fecha |
| `create_exercise` | Crear un ejercicio propio |
| `add_exercise_alias` | Enseñarle un nombre nuevo para un ejercicio |

## Frases de ejemplo

| Lo que dices | Herramienta | Argumentos que saca |
|---|---|---|
| «¿Qué toca hoy?» | `get_today` | ninguno |
| «Empiezo» | `start_workout` | ninguno: abre la sesión que toca |
| «Press banca 100 por 8, RIR 2» | `log_set` | `exercise: "press banca", kg: 100, reps: 8, rir: 2` |
| «Eran 9, no 8» | `update_set` | `setId` de la serie anterior, `reps: 9` |
| «He terminado, un 7» | `finish_workout` | `srpe: 7` |
| «200 gramos de pechuga de pollo» | `log_food` | `food: "pechuga de pollo", grams: 200` |
| «Hoy 79,4» | `log_body_metrics` | `weightKg: 79.4` |
| «He dormido 7 horas, sueño 8, estrés 3, ganas 8, dolor 2, fatiga 3» | `log_checkin` | los cinco valores y `sleepHours: 7` |
| «Llevo 8.400 pasos» | `log_steps` | `steps: 8400` |
| «Me duele el tobillo 5» | `log_pain` | `zone: "tobillo", pain: 5` |
| «40 minutos de bici a 128 pulsaciones» | `log_cardio` | `mode: "bici", minutes: 40, avgHr: 128` |
| «Me acabo de tomar un café» | `log_caffeine` | `mg: 90, source: "café"` |
| «Pásame a descarga» | `get_load_status` y, si confirmas, `set_deload` | ninguno: marca el microciclo en curso |
| «¿Cómo voy de peso?» | `get_progress` | ninguno |

Lo que Muse no hace por su cuenta:

- **No elige entre candidatos.** Si «press inclinado» encaja con tres ejercicios, `log_set` falla con la lista (nombre e id) y no guarda nada. Muse te pregunta cuál y repite con el id. Con los alimentos, igual.
- **No inventa calorías.** «Un plato de pasta» sin gramos ni macros hace fallar a `log_food`, que dice qué falta.
- **No inventa el check-in.** Si falta alguno de los cinco valores, lo pregunta.
- **El tobillo manda.** Si una respuesta trae un aviso de tobillo, lo lee tal cual.

## Desconectar

En la app: **Ajustes → Agentes conectados → Desconectar**. Por debajo llama a `revokeGrant(userId, clientId)` (`src/server/oauth.ts`): revoca todos los tokens y códigos pendientes de ese cliente. La siguiente llamada de Muse recibe un 401 y tiene que volver a pedir permiso.

Para cambiar los permisos, desconecta y vuelve a conectar eligiendo otros.

## Límites conocidos

- **Fotos y vídeos:** por MCP no viaja el fichero. Muse registra el enlace de Drive con `register_photo` y `register_video`; la subida del binario se hace desde la app.
- **`lookup_barcode`** consulta Open Food Facts cuando el código no está en tu catálogo, y guarda el producto en el catálogo común. Si el servicio no responde, lo dice y propone el alta a mano.
- **Altas de alimento:** no hay herramienta para crear un alimento a mano. Sin código de barras, se da de alta en la app o se anota con kcal y macros.
- **Listas recortadas:** las respuestas van resumidas y con un máximo de 20 elementos por defecto. Si hay más, lo indica (`truncated`).
- **Servidor sin estado:** cada llamada es independiente. Muse no recibe avisos; tiene que preguntar (`get_today`).
- **Un atleta por conexión:** el token decide de quién son los datos. No hay forma de pedir los de otro.
- **`weekly_review` y `build_shopping_list`** guardan su resultado, por eso están en `mcp:plan` aunque no cambien calorías ni programa.
