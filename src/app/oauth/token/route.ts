// POST /oauth/token → canje del código con PKCE y rotación del refresh (RFC 6749 §4.1.3 y §6).
// Formulario urlencoded (se tolera JSON). El cliente se identifica con client_id; con secreto, por
// client_secret_post (se tolera HTTP Basic). Respuesta siempre con `Cache-Control: no-store`.
import { basicClientCredentials, corsPreflight, exchangeCode, OAuthError, oauthErrorResponse, oauthJson, readForm, refreshTokens } from "@/server/oauth";

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readForm(request);
    if (!form) throw new OAuthError("invalid_request", "application/x-www-form-urlencoded body required");
    const basic = basicClientCredentials(request);
    const clientId = form.client_id ?? basic?.clientId ?? "";
    const clientSecret = form.client_secret ?? basic?.clientSecret;

    if (form.grant_type === "authorization_code") {
      return oauthJson(await exchangeCode({ code: form.code ?? "", clientId, clientSecret, redirectUri: form.redirect_uri, codeVerifier: form.code_verifier ?? "" }));
    }
    if (form.grant_type === "refresh_token") {
      return oauthJson(await refreshTokens({ refreshToken: form.refresh_token ?? "", clientId, clientSecret, scope: form.scope }));
    }
    if (!form.grant_type) throw new OAuthError("invalid_request", "grant_type required");
    throw new OAuthError("unsupported_grant_type", "supported: authorization_code, refresh_token");
  } catch (error) {
    return oauthErrorResponse("token", error);
  }
}

export const OPTIONS = corsPreflight;
