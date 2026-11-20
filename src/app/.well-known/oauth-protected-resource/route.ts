// GET /.well-known/oauth-protected-resource → metadatos del recurso /api/mcp (RFC 9728).
// Es la variante sin sufijo, para los clientes que la piden en la raíz. La que anuncia el 401 es …/mcp.
import { CORS_HEADERS, corsPreflight, protectedResourceMetadata } from "@/server/oauth";

export async function GET(request: Request): Promise<Response> {
  void request.url; // dato de la petición: la respuesta se calcula con el APP_URL de ejecución, no se prerenderiza
  return Response.json(protectedResourceMetadata(), { headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" } });
}

export const OPTIONS = corsPreflight;
