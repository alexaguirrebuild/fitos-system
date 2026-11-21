# Reloj: del OnePlus Watch 2R a `POST /api/ingest/health`

Investigado el 21-nov-2026. **VERIFICADO** = leído hoy con URL (o fichero del repo). **SIN VERIFICAR** = no confirmado.

## Resumen

La cadena real es: **reloj → OHealth → Health Connect (en el S24) → app puente → webhook HTTP → adaptador → `/api/ingest/health`**.

- Health Connect vive en el móvil y **no tiene API en la nube**; algo en el teléfono tiene que leerlo y mandarlo — VERIFICADO.
- Puente recomendado: **HC Webhook** (código abierto, APK gratis en GitHub). Lee Health Connect y hace POST JSON con cabeceras propias.
- **Su JSON no es el nuestro.** Hace falta un adaptador de ~80 líneas (ruta nueva `POST /api/ingest/hc-webhook` o un Worker). Ver §5.
- Antes de nada, comprobar en el móvil qué escribe OHealth de verdad (FC en reposo y fases de sueño son la duda).

## 1. ¿OHealth escribe en Health Connect?

- Sí, según un tercero (FitMesh): pasos, FC, sueño, calorías, distancia, entrenos y SpO2; VO2 max no — VERIFICADO en https://www.fitmesh.fit/en/sync/oneplus-health (fuente no oficial).
- Ruta: OHealth → **Perfil** (abajo derecha) → **Health Connect** → Conectar → autorizar escritura — misma URL. Que en tu versión esté exactamente ahí: SIN VERIFICAR.
- Limitaciones que cita FitMesh: OnePlus no publica qué métricas exporta cada modelo; fases de sueño poco fiables (el total sí); sin ruta GPS; retraso de 5-15 min — VERIFICADO (misma URL).
- **FC en reposo y HRV desde OHealth: SIN VERIFICAR.** Ninguna fuente lo confirma.
- OnePlus no lo documenta oficialmente: su página de OnePlus Health no menciona Health Connect — VERIFICADO https://www.oneplus.com/ie/oneplus-health
- Android Central tuvo problemas para que Health Connect recibiera bien los datos del 2R; OHealth no exporta TCX/GPX — VERIFICADO https://www.androidcentral.com/wearables/oneplus-watch-2r-fitness-test
- Samsung Health y Google Fit no hacen falta en esta cadena. Que Samsung Health no sincronice da igual.

## 2. Estado de las APIs de Google (nov-2026)

| API | Estado | Fuente |
|---|---|---|
| Google Fit (incluida REST) | Deprecada; sin altas de desarrolladores desde 1-may-2024; fin de servicio en 2026, sin sustituto REST equivalente. Fecha exacta de apagado: SIN VERIFICAR | VERIFICADO https://developer.android.com/health-and-fitness/guides/health-connect/migrate/fit-apis-end-of-service |
| Health Connect | Solo en el dispositivo. Lectura en segundo plano con `READ_HEALTH_DATA_IN_BACKGROUND`; por defecto 30 días hacia atrás desde el primer permiso, más con `READ_HEALTH_DATA_HISTORY` | VERIFICADO https://developer.android.com/health-and-fitness/health-connect/read-data |
| Google Health API (`health.googleapis.com/v4`) | Sucesora de la Fitbit Web API (apagada el 2-nov-2026). Nube, scopes «Restricted». Que lea datos de OHealth: SIN VERIFICAR (casi seguro que no; es ecosistema Fitbit/Pixel) | VERIFICADO https://developers.google.com/health/about |

Desde jun-2026 los pasos del propio móvil salen con un paquete sintético en vez de `android`: al sumar pasos, no filtrar por origen o duplicarás — VERIFICADO (read-data, arriba). Nuestro `dayTotalTx` ya toma el mayor total por `source`, así que entra bien.

## 3. Puentes comparados

| | **HC Webhook** (mcnaveen) | **HCGateway** (ShuchirJ) | **Tasker + TaskerHealthConnect** | App propia |
|---|---|---|---|---|
| Coste | Gratis (APK FOSS, AGPL-3.0); 14,99 $ en Play | Gratis (GPL-3.0) | Tasker de pago (precio SIN VERIFICAR); plugin MIT | Tu tiempo |
| Vivo | v1.9.32, 4-nov-2026 | último push 12-dic-2025 | versión/fecha SIN VERIFICAR; el autor lo da por no estable | — |
| Destino | Cualquier URL, POST JSON (o gRPC) | Su propio servidor con MongoDB; compilar tú para cambiarlo | Lo que programes en Tasker (HTTP Request) | Nuestro endpoint directo |
| Auth | Cabeceras propias por webhook (`Authorization: Bearer …`) | Propia | La que pongas | La que pongas |
| Frecuencia | Programada; mínimo 15 min (dato de su ficha, SIN VERIFICAR en el README) | Cada 2 h por defecto | Lo que dispare Tasker | WorkManager periódico |
| Tipos | 31 (pasos, FC, FC reposo, HRV, sueño con fases, entrenos, kcal, peso…) | ~37 | Los que pidas | Los que pidas |
| Robustez | Ventana móvil 48 h + marca de última sync + cola de 16 MB si falla + reenvía editados/tardíos | — | Frágil, todo a mano | La que construyas |
| Riesgo de abandono | Medio-bajo (un autor, pero activo y con versión de pago) | Alto | Alto | Bajo pero cargas tú con Android |

Fuentes, todas VERIFICADO hoy: https://api.github.com/repos/mcnaveen/health-connect-webhook/releases/latest · https://raw.githubusercontent.com/mcnaveen/health-connect-webhook/main/docs/webhook.md · https://www.appbrain.com/app/health-connect-webhook-app/com.wonkru.healthconnectwebhook · https://github.com/ShuchirJ/HCGateway · https://github.com/RafhaanShah/TaskerHealthConnect

Descartados: Health Sync (exporta a Drive en CSV/FIT/GPX, sin webhook — https://healthsync.app/?p=43), Health Auto Export (solo iOS — https://github.com/Lybron/health-auto-export), Home Assistant Companion (solo último valor, sin historial — https://community.home-assistant.io/t/fitbit-garmin-samsung-and-gadgetbridge-data-into-ha-through-health-connect/1026801), Gadgetbridge (no lista OnePlus ni Wear OS — https://gadgetbridge.org/gadgets/), MacroDroid (soporte de Health Connect no encontrado).

**App propia**: requiere permisos `android.permission.health.READ_*`, actividad de política de privacidad, `<queries>` a Health Connect, `compileSdk 36` — VERIFICADO https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started. Que un APK instalado a mano pueda leer Health Connect sin pasar por Play: SIN VERIFICAR (HC Webhook publica APK fuera de Play, lo que sugiere que sí; hay un caso en GrapheneOS donde el diálogo no salía — https://discuss.grapheneos.org/d/26322-sideloaded-app-fails-to-launch-health-connect-permission). No compensa mientras HC Webhook funcione.

## 4. Recomendación

**HC Webhook (APK FOSS) + adaptador en el servidor.** Coste 0 €, mantiene cola y reintentos, manda FC en reposo como tipo propio y admite `Authorization`. La app propia solo si HC Webhook muere.

## 5. El adaptador (lo que falta en el código)

Lo que **acepta** nuestro endpoint (`src/server/services/health.ts`, VERIFICADO):

```json
{
  "source": "health_connect",
  "samples": [
    { "type": "steps", "value": 8450, "unit": "count", "start": "2026-01-15T00:00:00+01:00", "end": "2026-01-15T23:59:59+01:00" },
    { "type": "heart_rate", "value": 72, "unit": "bpm", "start": "2026-01-15T10:00:00+01:00" },
    { "type": "resting_hr", "value": 54, "unit": "bpm", "start": "2026-01-15T07:10:00+01:00" },
    { "type": "hrv", "value": 62, "unit": "ms", "start": "2026-01-15T07:10:00+01:00" },
    { "type": "sleep", "start": "2026-01-14T23:40:00+01:00", "end": "2026-01-15T07:05:00+01:00", "data": { "stages": { "deep": 85, "rem": 100, "light": 240 } } },
    { "type": "exercise", "value": 45, "unit": "min", "start": "2026-01-15T18:00:00+01:00", "end": "2026-01-15T18:45:00+01:00", "sourceId": "hc-<metadata.id>", "data": { "activity": "walking", "distanceKm": 4.1 } },
    { "type": "active_kcal", "value": 610, "unit": "kcal", "start": "2026-01-15T00:00:00+01:00", "end": "2026-01-15T23:59:59+01:00" },
    { "type": "weight", "value": 90.7, "unit": "kg", "start": "2026-01-15T07:15:00+01:00" }
  ]
}
```

Cabecera: `Authorization: Bearer fit_ing_…` (token de ingesta) — VERIFICADO (`src/app/api/ingest/health/route.ts`). Máximo 1.000 muestras por llamada; una muestra mala no tumba el lote; reenviar lo mismo no duplica (dedupe por `source` + `sourceId`).

Lo que **manda** HC Webhook (VERIFICADO, docs/webhook.md) y cómo se traduce:

| HC Webhook | Nuestro `type` | Traducción |
|---|---|---|
| `steps[] {count, start_time, end_time}` | `steps` | `value=count`, `start/end` |
| `heart_rate[] {bpm, time}` | `heart_rate` | `value=bpm`, `start=time` |
| `resting_heart_rate[] {bpm, time}` | `resting_hr` | `value=bpm`, `start=time` |
| `heart_rate_variability[] {rmssd_millis, time}` | `hrv` | `value=rmssd_millis` |
| `sleep[] {session_end_time, duration_seconds, stages[{stage,start_time,end_time}]}` | `sleep` | `end=session_end_time`, `start=end−duration`; sumar minutos por fase en `deep/rem/light` (los nombres de `stage` son el `toString()` de AndroidX: mapear `DEEP`, `REM`, `LIGHT`, SIN VERIFICAR el texto exacto) |
| `exercise[] {type, start_time, end_time, duration_seconds, distance_meters?}` | `exercise` | `value=duration/60`, `data.activity=type`, `data.distanceKm=distance/1000` |
| `active_calories[] {calories, start_time, end_time}` | `active_kcal` | `value=calories` |
| `weight[] {kilograms, time}` | `weight` | `value=kilograms` |
| `metadata.id` (si viene) | `sourceId` | `hc-<id>`, para que una edición no duplique |
| `deleted[]` | — | ignorar de momento |

**Hecho (21-nov-2026, sin commit):** `POST /api/ingest/hc-webhook` (`src/app/api/ingest/hc-webhook/route.ts` + `src/server/services/hc-webhook.ts`, tests en `tests/hc-webhook.test.ts`, 3/3 en verde).
- Mismo token de ingesta (`Authorization: Bearer fit_ing_…`). Límite 8 MB por lote.
- Traduce pasos, FC, FC en reposo, HRV, kcal activas, peso, sueño con fases y entrenos → `ingestHealth`.
- **Comidas**: `nutrition` → `logFood` con kcal y macros (`source: import`, comida según `meal_type`, idempotente por `hc:<id>`). Una comida sin kcal ni macros se salta.
- Responde 200 aunque falle alguna muestra (los fallos van en el cuerpo), para que HC Webhook no reintente el lote entero.
- Ignora de momento `deleted` y el resto de tipos (tensión, SpO2…): salen en `skipped`.

No apuntes HC Webhook a `/api/ingest/health`: ese espera `samples` y daría 400.

## 6. Pasos exactos en el S24

1. OHealth → Perfil → **Health Connect** → conectar y permitir **todo** lo que ofrezca.
2. Ajustes de Android → **Health Connect** → Permisos de apps → OHealth: comprobar que escribe Pasos, Frecuencia cardiaca, FC en reposo, Sueño, Ejercicio, Calorías.
3. Ajustes → Health Connect → **Datos y acceso**: mirar ayer en cada tipo. Apunta qué hay (sobre todo FC en reposo y fases de sueño). Si FC en reposo no aparece, lo calcularemos en el servidor desde `heart_rate` nocturno.
4. Instalar HC Webhook: https://github.com/mcnaveen/health-connect-webhook/releases → `app-foss-release.apk` (permitir «instalar apps desconocidas» solo para el navegador y quitarlo después).
5. Abrir HC Webhook → conceder permisos de lectura de Health Connect: pasos, FC, FC en reposo, HRV, sueño, ejercicio, calorías activas, peso; y **lectura en segundo plano**.
6. Ajustes de HC Webhook → **Payload timestamps: Local time**.
7. Webhooks → añadir: URL `https://<dominio-de-la-app>/api/ingest/hc-webhook` (cuando exista el adaptador), formato **JSON**, cabecera `Authorization` = `Bearer fit_ing_…` (crea el token en la app; no lo pegues en chats).
8. Programar sincronización cada **1 h** (o 15 min si lo permite) y pulsar **Test**: debe dar 2xx.
9. Ajustes del S24 → Batería → HC Webhook y OHealth en **Sin restricciones**; si no, Samsung mata las tareas en segundo plano (SIN VERIFICAR para esta app; es el comportamiento conocido de One UI).
10. Al día siguiente, comprobar en la app que `daily_activity` tiene pasos, FC en reposo y sueño.
