/**
 * POST /api/media/upload — sube un vídeo de entreno o una foto de progreso a Drive y guarda sus metadatos.
 * multipart/form-data: `file` (video/* o image/*, máx. 300 MB) y `meta` (JSON con los campos de RegisterVideoInput o RegisterPhotoInput).
 * Sesión del dueño. Si Drive no está configurado responde 200 con status 'pendiente' y los nombres de las variables que faltan.
 */
import { AppError, type ErrorCode } from "@/server/errors";
import { uploadPhoto, uploadVideo, type RegisterPhotoInput, type RegisterVideoInput } from "@/server/services/media";

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
/** El multipart añade cabeceras y el campo `meta` al tamaño del fichero. */
const MULTIPART_SLACK_BYTES = 1024 * 1024;

export const maxDuration = 300;

const STATUS: Record<ErrorCode, number> = {
  entrada_invalida: 400, no_autorizado: 401, no_encontrado: 404, ambiguo: 409, conflicto: 409, limite: 413, externo: 502,
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const tooBig = () => json({ error: "limite", message: "El fichero pasa de 300 MB." }, 413);

export async function POST(request: Request) {
  try {
    const { getSessionUserId } = await import("@/server/auth");
    const userId = await getSessionUserId();
    if (!userId) return json({ error: "no_autorizado", message: "Inicia sesión." }, 401);

    if (!/^multipart\/form-data/i.test(request.headers.get("content-type") ?? ""))
      return json({ error: "entrada_invalida", message: "Manda el fichero como multipart/form-data, en el campo `file`." }, 400);
    if (Number(request.headers.get("content-length") ?? "0") > MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES) return tooBig();

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "entrada_invalida", message: "No se pudo leer el formulario." }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "entrada_invalida", message: "Falta el fichero en el campo `file`." }, 400);
    if (file.size === 0) return json({ error: "entrada_invalida", message: "El fichero está vacío." }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return tooBig();
    const isVideo = file.type.startsWith("video/");
    if (!isVideo && !file.type.startsWith("image/"))
      return json({ error: "entrada_invalida", message: "Solo se aceptan vídeos (video/*) e imágenes (image/*)." }, 415);

    let meta: unknown = {};
    const rawMeta = form.get("meta");
    if (typeof rawMeta === "string" && rawMeta.trim()) {
      try {
        meta = JSON.parse(rawMeta);
      } catch {
        return json({ error: "entrada_invalida", message: "El campo `meta` no es JSON válido." }, 400);
      }
    }

    const upload = { name: file.name, mimeType: file.type, body: file.stream() as ReadableStream<Uint8Array> };
    if (isVideo) {
      const r = await uploadVideo(userId, meta as RegisterVideoInput, upload);
      return json({ kind: "video", status: r.status, message: r.message, missing: r.missing, video: r.video });
    }
    const r = await uploadPhoto(userId, meta as RegisterPhotoInput, upload);
    return json({ kind: "photo", status: r.status, message: r.message, missing: r.missing, photo: r.photo });
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.code, message: e.message }, STATUS[e.code] ?? 400);
    console.error("[media/upload]", e instanceof Error ? e.message : "error desconocido");
    return json({ error: "interno", message: "No se pudo subir el fichero." }, 500);
  }
}
