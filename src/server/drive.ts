/**
 * Cliente mínimo de Google Drive v3 por fetch (sin SDK): token por refresh token, carpetas y subida resumable por trozos.
 * Nunca escribe tokens ni cuerpos de respuesta en logs ni en mensajes de error.
 */
import { AppError, invalid } from "@/server/errors";
import type { FetchLike } from "@/server/off";

const DRIVE_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "DRIVE_ROOT_FOLDER_ID"] as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Trozo de subida: múltiplo de 256 KiB, como pide Drive. */
export const DRIVE_CHUNK_BYTES = 8 * 1024 * 1024;

export type DriveOptions = { fetchImpl?: FetchLike };

/** Nombres (nunca valores) de las variables de entorno que faltan. */
export const missingDriveEnv = (): string[] => DRIVE_ENV.filter((k) => !process.env[k]?.trim());
export const isDriveConfigured = (): boolean => missingDriveEnv().length === 0;

let cachedToken: { value: string; expiresAt: number } | null = null;
const folderCache = new Map<string, string>();

/** Para tests y para cuando se cambian las credenciales en caliente. */
export function resetDriveCache(): void {
  cachedToken = null;
  folderCache.clear();
}

const doFetch = (o: DriveOptions): FetchLike => o.fetchImpl ?? (globalThis.fetch as FetchLike);

async function call(o: DriveOptions, what: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await doFetch(o)(url, init);
  } catch {
    throw new AppError("externo", `No se pudo conectar con Google Drive (${what}).`);
  }
}

/** Access token a partir del refresh token. Se guarda en memoria hasta un minuto antes de caducar. */
export async function getAccessToken(o: DriveOptions = {}): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const missing = missingDriveEnv();
  if (missing.length) throw new AppError("externo", `Drive no está configurado: falta ${missing.join(", ")}.`);
  const res = await call(o, "renovar el acceso", TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!, grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new AppError("externo", `Google rechazó la renovación del acceso a Drive (${res.status}). Revisa el refresh token.`);
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!json || typeof json.access_token !== "string") throw new AppError("externo", "Google no devolvió un token de acceso para Drive.");
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000 };
  return cachedToken.value;
}

const escapeQ = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Busca o crea cada nivel bajo DRIVE_ROOT_FOLDER_ID y devuelve el id de la última carpeta. */
export async function ensureFolderPath(segments: string[], o: DriveOptions = {}): Promise<string> {
  const token = await getAccessToken(o);
  const auth = { Authorization: `Bearer ${token}` };
  let parent = process.env.DRIVE_ROOT_FOLDER_ID!;
  let key = parent;
  for (const raw of segments) {
    const name = raw.trim();
    if (!name) throw invalid("Nombre de carpeta vacío en la ruta de Drive.");
    key += `/${name}`;
    const hit = folderCache.get(key);
    if (hit) { parent = hit; continue; }
    const q = `name = '${escapeQ(name)}' and '${escapeQ(parent)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const find = await call(o, "buscar la carpeta", `${FILES_URL}?${new URLSearchParams({ q, fields: "files(id,name)", pageSize: "1", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`, { headers: auth });
    if (!find.ok) throw new AppError("externo", `Drive respondió ${find.status} al buscar la carpeta «${name}».`);
    const found = (await find.json().catch(() => null)) as { files?: { id?: string }[] } | null;
    let id = found?.files?.[0]?.id;
    if (!id) {
      const make = await call(o, "crear la carpeta", `${FILES_URL}?fields=id&supportsAllDrives=true`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
      });
      if (!make.ok) throw new AppError("externo", `Drive respondió ${make.status} al crear la carpeta «${name}».`);
      id = ((await make.json().catch(() => null)) as { id?: string } | null)?.id;
      if (!id) throw new AppError("externo", `Drive no devolvió el id de la carpeta «${name}».`);
    }
    folderCache.set(key, id);
    parent = id;
  }
  return parent;
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Trocea un Buffer o un stream en bloques de `size` bytes (el último puede ser menor). */
async function* chunksOf(body: Uint8Array | ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    for (let o = 0; o < body.length; o += size) yield body.subarray(o, Math.min(o + size, body.length));
    return;
  }
  const reader = body.getReader();
  let parts: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let v = value;
    while (v.length) {
      const take = Math.min(size - len, v.length);
      parts.push(v.subarray(0, take));
      len += take;
      v = v.subarray(take);
      if (len === size) { yield concat(parts, len); parts = []; len = 0; }
    }
  }
  if (len) yield concat(parts, len);
}

export type DriveFile = { id: string; name: string | null; webViewLink: string | null };
export type UploadFileInput = { name: string; mimeType: string; body: ReadableStream<Uint8Array> | Buffer | Uint8Array; parentId: string };

/**
 * Subida resumable: abre la sesión y manda el fichero por trozos (PUT con Content-Range).
 * Con un stream no hace falta saber el tamaño: el total se declara en el último trozo.
 */
export async function uploadFile(input: UploadFileInput, o: DriveOptions & { chunkBytes?: number } = {}): Promise<DriveFile> {
  const chunkBytes = o.chunkBytes ?? DRIVE_CHUNK_BYTES;
  if (chunkBytes % (256 * 1024) !== 0) throw invalid("El trozo de subida a Drive tiene que ser múltiplo de 256 KiB.");
  const token = await getAccessToken(o);
  const auth = { Authorization: `Bearer ${token}` };
  const start = await call(o, "abrir la subida", `${UPLOAD_URL}?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": input.mimeType },
    body: JSON.stringify({ name: input.name, mimeType: input.mimeType, parents: [input.parentId] }),
  });
  const session = start.headers.get("location");
  if (!start.ok || !session) throw new AppError("externo", `Drive respondió ${start.status} al abrir la subida.`);

  const put = (chunk: Uint8Array, offset: number, total: number | null) =>
    call(o, "subir el fichero", session, {
      method: "PUT",
      redirect: "manual", // Drive contesta 308 a los trozos intermedios: no es una redirección
      headers: { ...auth, "Content-Type": input.mimeType, "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${total ?? "*"}` },
      body: chunk as unknown as BodyInit,
    });

  let offset = 0;
  let pending: Uint8Array | null = null;
  for await (const chunk of chunksOf(input.body, chunkBytes)) {
    if (pending) {
      const res = await put(pending, offset, null);
      if (res.status !== 308) throw new AppError("externo", `Drive respondió ${res.status} a mitad de la subida.`);
      offset += pending.length;
    }
    pending = chunk;
  }
  if (!pending) throw invalid("El fichero está vacío: no se sube.");
  const last = await put(pending, offset, offset + pending.length);
  if (last.status !== 200 && last.status !== 201) throw new AppError("externo", `Drive respondió ${last.status} al cerrar la subida.`);
  const file = (await last.json().catch(() => null)) as { id?: string; name?: string; webViewLink?: string } | null;
  if (!file?.id) throw new AppError("externo", "Drive no devolvió el id del fichero subido.");
  return { id: file.id, name: file.name ?? null, webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view` };
}
