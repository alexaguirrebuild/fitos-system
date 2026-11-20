# TRASPASO · Sistema Físico

Fecha: 2026-11-20. Repo local en `~/Documents/sistema-fisico` (git, sin remoto, sin `.env`).

## Qué funciona hoy (verificado en local)

| Pieza | Estado | Cómo se comprobó |
|---|---|---|
| Motor científico (`src/engine`) | Hecho | 47 tests; varios reproducen cifras de los Excels |
| Esquema `fit` + RLS (5 migraciones) | Hecho | Aplicado en Postgres embebido (PGlite); 8 tests de aislamiento |
| Importación del histórico | Hecho | Export real del 15-nov: 102 sesiones, 2.072 series, 0 descartadas, 586/655 ejercicios enlazados, 15 check-ins. Idempotente |
| Catálogo | Hecho | 148 ejercicios, 2 programas, 58 términos, 80 alimentos (41 con precio de Mercadona del 20-nov; Lidl sin precio) |
| Servicios (entreno, plan, bienestar, analítica, nutrición, cardio, salud, medios) | Hecho | Tests por área sobre PGlite |
| Vista «Hoy» y 62 herramientas MCP | Hecho | Tests a través del endpoint MCP real con token |
| OAuth 2.1 (registro dinámico, PKCE, rotación) | Hecho | 51 tests; flujo completo con el cliente del SDK MCP |
| PWA (12 rutas) | Hecho | `next build` compila; recorrido real con Playwright a 390 px con el histórico cargado; capturas en `docs/capturas/` |
| Cola sin conexión para series | Hecho | Probada cortando la red |

Suite: 259 de 260 tests. El rojo es `tests/mcp.test.ts:167`, una aserción que quedó desfasada al añadir herramientas (el código es correcto). Arreglo de tres líneas pendiente del OK de Alex.

## Qué NO está verificado

- Nada contra el Postgres real de Supabase (solo PGlite).
- Muse conectándose de verdad.
- Login con contraseña real (solo modo dev).
- En el móvil: cámara, lector de códigos de barras, vibración, instalación como PWA.
- Subida real a Google Drive y Open Food Facts real (solo con respuestas simuladas).
- Reloj: el endpoint de ingesta existe; el puente Watch 2R → Health Connect → `POST /api/ingest/health` hay que montarlo en el móvil (una PWA no puede leer Health Connect).

## Para ponerlo en producción

1. **Supabase:** crear proyecto. Copiar la cadena del *Transaction pooler* a `DATABASE_URL`.
2. `npm run hash-password` → `OWNER_PASSWORD_HASH`. Poner `OWNER_EMAIL`.
3. `SESSION_SECRET`: 32 bytes aleatorios (comando en `.env.example`).
4. `APP_URL`: el origen público exacto (https). Quitar `AUTH_MODE=dev`.
5. `OFF_USER_AGENT`: con un contacto.
6. `npm run db:seed` (aplica migraciones y catálogo) y `npm run import:legacy -- <carpeta_export> <email>`.
7. Desplegar (Vercel o Netlify) con esas variables.
8. **Muse:** pegarle el texto de `docs/MUSE.md` con `<APP_URL>/api/mcp` y aprobar el consentimiento.
9. **Drive (opcional):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_ROOT_FOLDER_ID`. Sin ellas los vídeos quedan como «pendiente» y el fichero no se guarda.
10. **Reloj:** Ajustes → crear token de ingesta y usarlo en la automatización del móvil.

## Límites conocidos

- Vídeos: la subida pasa por el servidor. En Vercel el cuerpo máximo es 4,5 MB; para vídeos reales hace falta subida directa del navegador a Drive.
- Sin límite de peticiones en `/api/mcp` ni `/oauth/token`.
- Cola sin conexión: un reenvío guarda la hora del reenvío y puede duplicar una serie si la respuesta se perdió y pasan más de 20 s (falta id de cliente en el backend).
- «Quitar el top set si el tobillo dolió» es un aviso; no retira la serie.
- La lista de la compra marca si se pasa de presupuesto, pero no recorta. Lidl sin precios.
- Faltan en el catálogo: carne picada magra, claras, queso batido 0 %, avena, whey, fruta y verdura fresca (alta manual o escaneo).
- No hay pantalla para crear comidas ancla ni para editar bloques de horario sueltos (se rehace en el onboarding).
- Código duplicado menor: ayudantes de validación en `athlete.ts` y `annotations.ts`; lógica de sugerencias repetida en `today.ts` y `training.ts`.

## Datos que solo tiene Alex (los pide el onboarding)

Altura (174 o 164 cm), fecha de nacimiento, peso y cintura de hoy, FC en reposo, hora de acostarse, estado del tobillo, medicación TDAH (sí/no), presupuesto semanal y programa (`torso-pierna-6d` o `gorilangel-bro-split`).

## Documentos

- Ingeniería inversa, evidencia y decisiones: `CEREBRO/research/_inbox/2026-11-20-sistema-fitness-arquitectura/` (`01_…excels.md`, `02_notebooklm.md`).
- `docs/MOTOR.md`, `docs/MUSE.md`, `docs/DISENO.md`.
