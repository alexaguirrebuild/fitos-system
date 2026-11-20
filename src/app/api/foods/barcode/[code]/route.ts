/**
 * GET /api/foods/barcode/[code] — busca un producto por código de barras (local → Open Food Facts).
 * Sesión del dueño. 200 con el alimento; 404 con el motivo, para abrir el alta manual con el código puesto.
 */
import { AppError } from "@/server/errors";
import { lookupBarcode } from "@/server/services/foods";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { getSessionUserId } = await import("@/server/auth");
    const userId = await getSessionUserId();
    if (!userId) return json({ error: "no_autorizado", message: "Inicia sesión." }, 401);

    const { code } = await ctx.params;
    const r = await lookupBarcode(userId, { barcode: code });
    if (r.food) return json({ food: r.food, origin: r.origin, barcode: r.barcode });
    return json({ reason: r.reason, cause: r.cause, barcode: r.barcode }, 404);
  } catch (e) {
    if (e instanceof AppError) {
      const status = e.code === "entrada_invalida" ? 400 : e.code === "no_autorizado" ? 401 : e.code === "externo" ? 502 : 400;
      return json({ error: e.code, message: e.message }, status);
    }
    console.error("[foods/barcode]", e instanceof Error ? e.message : "error desconocido");
    return json({ error: "interno", message: "No se pudo buscar el producto." }, 500);
  }
}
