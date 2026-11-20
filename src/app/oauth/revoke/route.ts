// POST /oauth/revoke → revocación (RFC 7009). Vale un access o un refresh. Responde 200 exista o no
// el token (no se confirma nada a quien pregunta); solo un fallo interno responde 503.
import { corsPreflight, oauthJson, readForm, revokeToken } from "@/server/oauth";

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readForm(request);
    if (form?.token) await revokeToken(form.token);
    return oauthJson({});
  } catch (error) {
    console.error("[oauth] revoke:", error instanceof Error ? error.message : "error desconocido");
    return oauthJson({ error: "temporarily_unavailable" }, 503, { "Retry-After": "30" });
  }
}

export const OPTIONS = corsPreflight;
