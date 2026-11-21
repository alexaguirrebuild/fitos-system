# Drive: estructura de carpetas y subida desde Muse

Investigado el 21-nov-2026. Cada afirmación lleva **VERIFICADO** (leído hoy, con URL o fichero del repo) o **SIN VERIFICAR**.

## 1. Estructura propuesta

El código ya fija parte de la ruta (`src/server/services/media.ts`): todo cuelga de `DRIVE_ROOT_FOLDER_ID` → `Sistema Físico/<macrociclo>/…` — VERIFICADO (`DRIVE_APP_FOLDER`, `buildVideoPath`, `buildPhotoPath`).

```
<DRIVE_ROOT_FOLDER_ID>/
└── Sistema Físico/
    ├── <macrociclo>/                    ← lo crea la app (macrociclo activo o «Sin macrociclo»)
    │   ├── Fotos/                       ← progreso: AAAA-MM-DD_<frontal|lateral|trasera|otra>.jpg   (ya en código)
    │   └── Vídeos/<ejercicio>/          ← AAAA-MM-DD_<ejercicio>_<kg>kgx<reps>.mp4                (ya en código)
    ├── Comidas/AAAA-MM/                 ← AAAA-MM-DDTHHMM_<comida>.jpg          (PROPUESTA, no existe en código)
    ├── InBody/                          ← AAAA-MM-DD_inbody.jpg|pdf             (PROPUESTA)
    └── _Entrada/                        ← lo que llega sin clasificar (Muse, capturas) (PROPUESTA)
```

Por qué así:
- **Fotos de progreso y vídeos por macrociclo**: comparar dentro de un bloque es lo habitual; el nombre empieza por fecha y se ordena solo.
- **Comidas por mes, no por macrociclo**: son muchas (3-5 al día) y se consultan por fecha, no por bloque.
- **InBody plano**: 1-2 al mes; una sola carpeta basta.
- **`_Entrada/`**: si Muse no sabe qué es una imagen, la deja aquí en vez de adivinar.

Las fotos de físico son datos de salud: la carpeta raíz **no se comparte** con nadie y el enlace no se pega en ningún chat salvo a Alex.

Material actual en la carpeta de Drive `16QUYb-…` (listado hoy con rclone): 12 JPG + 1 PDF. Sugerencia de reparto: `20261121_1215*.jpg` (4) → `Fotos/`; `20261120_222553.jpg` (InBody) → `InBody/2026-11-20_inbody.jpg`; las 8 de máquinas → no son del usuario, pueden quedarse fuera o en `_Entrada/gimnasio/`. Ver `docs/GIMNASIO.md`.

## 2. Cómo sube una imagen un agente por WhatsApp (Muse, cliente MCP remoto)

Hoy: «por MCP no viaja el fichero. Muse registra el enlace de Drive con `register_photo` y `register_video`; la subida del binario se hace desde la app» — VERIFICADO (`docs/MUSE.md`, línea 148).

Qué permite MCP:
- Los **argumentos** de una herramienta son JSON (objeto validado por `inputSchema`); un binario solo puede ir como texto, es decir, **base64 en un string**. — VERIFICADO que los binarios de los *resultados* van en base64 (`"data": "base64-encoded-data"` en content `image`/`audio`) y que existen `resource_link` y recursos embebidos (https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Que el input sea solo JSON: SIN VERIFICAR en esa página (la página no lo dice; es lo que implica JSON-RPC).
- MCP no fija **límite de tamaño** — VERIFICADO que la página de tools no menciona ninguno. Los límites los ponen el cliente, el modelo y el servidor.

Dos vías posibles:

| Vía | Cómo | Pros | Contras |
|---|---|---|---|
| **A. base64 en argumento** (`upload_photo {pose, mimeType, dataBase64}`) | Muse mete la imagen en el argumento | Una sola llamada | El base64 pasa por el contexto del modelo: una foto de móvil de 3 MB son ~4 MB de texto (+33 %) y ~1 M+ tokens. **Inviable sin reducir antes.** — cálculo propio |
| **B. URL a descargar** (`upload_photo_from_url {pose, url}`) | Muse pasa la URL del medio (la que da la API de WhatsApp o un enlace firmado); el servidor la descarga y la sube a Drive en streaming | El binario no toca el modelo; `uploadFile` ya acepta `ReadableStream` | El servidor hace una petición saliente a una URL que viene de fuera: hay que acotarla (ver abajo) |

**Recomendación: vía B**, con vía A solo para miniaturas (≤ 1 MB de base64) si hiciera falta.

Límites razonables (propuesta, SIN VERIFICAR contra Muse):
- Imagen: ≤ 15 MB, `image/jpeg|png|webp|heic`. Vídeo: ≤ 200 MB, `video/mp4|quicktime`. Base64 en argumento: ≤ 1 MB decodificado.
- WhatsApp recomprime las fotos al enviarlas (salvo «como documento»): SIN VERIFICAR hoy.

Suelo de seguridad para la vía B (obligatorio, es contenido de fuera + salida a internet):
- Solo `https`, lista de hosts permitidos (el CDN de medios de WhatsApp/Meta que use Muse y `drive.google.com` si acaso), sin redirecciones a otros hosts, nada de IPs privadas ni `localhost` (evita SSRF).
- Comprobar `Content-Type` y cortar la descarga al pasar el límite, no después.
- La herramienta solo sube a la ruta que calcula `buildPhotoPath`; el nombre de fichero nunca sale de la URL.
- Scope MCP de escritura de medios separado del de lectura.

## 3. Qué necesita el servidor

Variables (nombres, nunca valores): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_ROOT_FOLDER_ID` — VERIFICADO (`src/server/drive.ts`, `DRIVE_ENV`). Sin ellas, fotos y vídeos quedan como `pendiente` y el fichero no se guarda — VERIFICADO (`media.ts`, `NOT_CONFIGURED`).

Scope `https://www.googleapis.com/auth/drive.file`: «Create new Drive files, or modify existing files, that you open with an app…», clasificado **Non-sensitive** — VERIFICADO (https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

**Ojo, choque con el código actual** (inferencia, SIN VERIFICAR con una prueba): con `drive.file` la app solo ve lo que ella creó o lo que se le abrió con el Picker. Si `DRIVE_ROOT_FOLDER_ID` es una carpeta creada a mano por Alex, `ensureFolderPath` probablemente no podrá buscar ni crear dentro (404/403). Dos salidas: (a) que la app cree la carpeta raíz la primera vez y se guarde ese id como `DRIVE_ROOT_FOLDER_ID`; (b) usar el scope `drive` completo (restringido, más riesgo). Recomiendo (a). Probarlo antes de dar Drive por hecho.

**Refresh token y modo «Testing»**: con la pantalla de consentimiento *External* en estado *Testing*, el refresh token caduca a los **7 días** — VERIFICADO (https://developers.google.com/identity/protocols/oauth2#expiration). Hay que **publicar la app (In production)**; con un scope no sensible no debería pedir verificación de Google — SIN VERIFICAR.

El remoto `drive:` de rclone usa el client_id compartido de rclone, que «will stop working during 2026» — VERIFICADO (aviso que imprimió rclone hoy). El cliente OAuth propio de abajo sirve también para rclone.

## 4. Pasos para que Alex cree el cliente OAuth (Google Cloud)

Interfaz de Google Cloud: rutas de menú SIN VERIFICAR hoy (cambian a menudo).

1. https://console.cloud.google.com → crear proyecto `sistema-fisico`.
2. *APIs y servicios → Biblioteca* → **Google Drive API** → Habilitar.
3. *Google Auth Platform → Branding / Audiencia*: tipo **External**, nombre «Sistema Físico», tu correo de soporte. Añádete como usuario de prueba.
4. *Data access / Scopes* → añadir solo `.../auth/drive.file`.
5. *Clients → Create client* → tipo **Web application**. URI de redirección: `https://developers.google.com/oauthplayground`. Guarda el **Client ID** y el **Client secret** (no los pegues en chats ni en el repo).
6. *Audiencia* → **Publish app** (pasar a *In production*), para que el refresh token no caduque a los 7 días.
7. Sacar el refresh token: https://developers.google.com/oauthplayground → engranaje → «Use your own OAuth credentials» (pega ID y secret) → en el paso 1 escribe `https://www.googleapis.com/auth/drive.file` → Authorize → acepta con tu cuenta → paso 2 «Exchange authorization code for tokens» → copia el **refresh_token**.
8. Crear la carpeta raíz **desde la app** (salida (a) de arriba) o, como prueba rápida, con el Playground: `POST https://www.googleapis.com/drive/v3/files` con cuerpo `{"name":"Sistema Físico (raíz)","mimeType":"application/vnd.google-apps.folder"}` → copia el `id`.
9. Mete las cuatro variables en el gestor de secretos del despliegue (no en el repo): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_ROOT_FOLDER_ID`.
10. Prueba: subir una foto desde la app y comprobar que aparece en `Sistema Físico/<macrociclo>/Fotos/` con estado `subido`.
