/**
 * POST /api/ingest/health — entrada de datos del reloj / Health Connect / atajo del móvil.
 * Auth: `Authorization: Bearer fit_ing_…` (token de ingesta) o la sesión del dueño.
 * Respuestas siempre en JSON y sin trazas: 200, 400, 401, 413.
 */
import { AppError, type ErrorCode } from "@/server/errors";
import { INGEST_TOKEN_PREFIX, resolveIngestToken } from "@/server/ingest-auth";
import { audit } from "@/server/services/annotations";
import { HEALTH_INGEST_EXAMPLE, HEALTH_SAMPLE_TYPES, MAX_HEALTH_SAMPLES, ingestHealth } from "@/server/services/health";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const STATUS: Record<ErrorCode, number> = {
  entrada_invalida: 400, no_autorizado: 401, no_encontrado: 404, ambiguo: 409, conflicto: 409, limite: 413, externo: 502,
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const tooBig = () => json({ error: "limite", message: "El cuerpo pasa de 2 MB. Parte el lote." }, 413);

/** Ejemplo de cuerpo (sin datos reales) para configurar el atajo del móvil. */
export async function GET() {
  return Response.json({
    method: "POST",
    headers: { Authorization: `Bearer ${INGEST_TOKEN_PREFIX}…`, "Content-Type": "application/json" },
    limits: { maxBytes: MAX_BODY_BYTES, maxSamples: MAX_HEALTH_SAMPLES },
    types: HEALTH_SAMPLE_TYPES,
    notes: [
      "start y end en ISO 8601 con zona u offset.",
      "sleep y exercise: la duración sale de end − start, o de value en minutos.",
      "Reenviar la misma muestra no la duplica: se identifica por sourceId o, si falta, por tipo + inicio + fin + valor.",
    ],
    example: HEALTH_INGEST_EXAMPLE,
  });
}

async function authenticate(request: Request): Promise<{ userId: string; actor: string } | null> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
  if (bearer) {
    const hit = await resolveIngestToken(bearer);
    return hit ? { userId: hit.userId, actor: `ingest:${hit.tokenId}` } : null;
  }
  const { getSessionUserId } = await import("@/server/auth");
  const userId = await getSessionUserId();
  return userId ? { userId, actor: "app" } : null;
}

/** Lee el cuerpo como texto sin pasar del límite. null si se pasa. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function POST(request: Request) {
  try {
    const who = await authenticate(request);
    if (!who) return json({ error: "no_autorizado", message: "Hace falta un token de ingesta válido o la sesión iniciada." }, 401);

    if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return tooBig();
    const text = await readLimited(request, MAX_BODY_BYTES);
    if (text === null) return tooBig();

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "entrada_invalida", message: "El cuerpo no es JSON válido." }, 400);
    }

    // ingestHealth valida el sobre y cada muestra con zod; los errores por muestra vuelven en `errors`.
    const result = await ingestHealth(who.userId, body as Parameters<typeof ingestHealth>[1]);
    await audit(who.userId, who.actor, "ingest.health", {
      processed: result.processed, skipped: result.skipped, errors: result.errors.length, days: result.days,
    }).catch(() => {});
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.code, message: e.message }, STATUS[e.code] ?? 400);
    console.error("[ingest/health]", e instanceof Error ? e.message : "error desconocido");
    return json({ error: "interno", message: "No se pudo procesar el lote. Inténtalo otra vez." }, 500);
  }
}
