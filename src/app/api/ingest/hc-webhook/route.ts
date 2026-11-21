/**
 * POST /api/ingest/hc-webhook — entrada directa de la app HC Webhook (Health Connect → JSON).
 * Auth: `Authorization: Bearer fit_ing_…` (token de ingesta), puesto como cabecera personalizada en HC Webhook.
 * Responde 200 aunque alguna muestra falle (si no, HC Webhook reintentaría el lote entero); 401/413/400 si el sobre no vale.
 */
import { AppError, type ErrorCode } from "@/server/errors";
import { resolveIngestToken } from "@/server/ingest-auth";
import { audit } from "@/server/services/annotations";
import { ingestHcWebhook } from "@/server/services/hc-webhook";

/** La primera sincronización trae 48 h de todo; con FC a resolución completa pesa más que un lote del atajo. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const STATUS: Record<ErrorCode, number> = {
  entrada_invalida: 400, no_autorizado: 401, no_encontrado: 404, ambiguo: 409, conflicto: 409, limite: 413, externo: 502,
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const tooBig = () => json({ error: "limite", message: "El cuerpo pasa de 8 MB. Baja la resolución de FC en HC Webhook." }, 413);

async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function POST(request: Request) {
  try {
    // «Bearer fit_ing_…» o el token a pelo: en la app del móvil es fácil olvidar el «Bearer ».
    const bearer = /^(?:Bearer\s+)?(fit_ing_\S+)$/i.exec((request.headers.get("authorization") ?? "").trim())?.[1];
    const who = bearer ? await resolveIngestToken(bearer) : null;
    if (!who) return json({ error: "no_autorizado", message: "Falta un token de ingesta válido en la cabecera Authorization." }, 401);

    if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return tooBig();
    const text = await readLimited(request, MAX_BODY_BYTES);
    if (text === null) return tooBig();
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ error: "entrada_invalida", message: "El cuerpo no es JSON válido." }, 400); }

    const result = await ingestHcWebhook(who.userId, body);
    await audit(who.userId, `ingest:${who.tokenId}`, "ingest.hc_webhook", {
      processed: result.health.processed, foods: result.foods.logged, errors: result.health.errors + result.foods.errors.length, days: result.health.days,
      // Tipos que llegan y no se importan (p. ej. «nutrition sin kcal ni macros»): para saber si falta el dato o lo descartamos.
      ...(result.skipped.length && { skipped: result.skipped.slice(0, 20) }),
    }).catch(() => {});
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.code, message: e.message }, STATUS[e.code] ?? 400);
    console.error("[ingest/hc-webhook]", e instanceof Error ? e.message : "error desconocido");
    return json({ error: "interno", message: "No se pudo procesar el lote. Inténtalo otra vez." }, 500);
  }
}
