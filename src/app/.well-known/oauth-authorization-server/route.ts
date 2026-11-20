// GET /.well-known/oauth-authorization-server → metadatos del servidor de autorización (RFC 8414).
import { authorizationServerMetadata, CORS_HEADERS, corsPreflight } from "@/server/oauth";

export async function GET(request: Request): Promise<Response> {
  void request.url; // dato de la petición: la respuesta se calcula con el APP_URL de ejecución, no se prerenderiza
  return Response.json(authorizationServerMetadata(), { headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" } });
}

export const OPTIONS = corsPreflight;
