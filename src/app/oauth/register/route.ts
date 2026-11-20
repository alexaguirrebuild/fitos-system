// POST /oauth/register → registro dinámico de clientes (RFC 7591). JSON, sin autenticación, con tope por hora.
import { corsPreflight, OAuthError, oauthErrorResponse, oauthJson, readBodyText, registerClient } from "@/server/oauth";

export async function POST(request: Request): Promise<Response> {
  try {
    const text = await readBodyText(request, 16 * 1024);
    let body: unknown = null;
    try {
      body = text === null ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "a JSON object of at most 16 KB is required");
    return oauthJson(await registerClient(body), 201);
  } catch (error) {
    return oauthErrorResponse("register", error);
  }
}

export const OPTIONS = corsPreflight;
