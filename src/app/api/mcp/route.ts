// POST /api/mcp → servidor MCP (Streamable HTTP, sin estado) detrás del OAuth propio.
// Cada petición trae su token: se comprueba, se monta un servidor con las herramientas que sus
// scopes permiten y se responde en JSON. Sin token o con uno que no vale → 401 con la cabecera
// que le dice al agente dónde autorizarse (RFC 9728 §5.1): así descubre Muse el servidor OAuth.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withUser } from "@/db/client";
import { allTools, buildMcpServer } from "@/server/mcp/server";
import { bearerChallenge, mcpResource, readBodyText, verifyAccessToken } from "@/server/oauth";

const MAX_BODY_BYTES = 1024 * 1024;

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}): Response =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });

/** La misma forma falte el token, sea inventado, esté caducado o sea de otro recurso; solo cambia `error`. */
function unauthorized(presented: boolean): Response {
  return Response.json(
    { error: presented ? "invalid_token" : "unauthorized", error_description: "Authorization required: OAuth 2.1 bearer token for this MCP server" },
    { status: 401, headers: { "WWW-Authenticate": bearerChallenge(presented ? "invalid_token" : undefined), "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  // Algunos clientes mandan el esquema en minúsculas («bearer …»).
  const bearer = /^bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return unauthorized(false);

  let auth: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    auth = await verifyAccessToken(bearer);
  } catch (error) {
    console.error("[mcp] no se pudo comprobar el token:", error instanceof Error ? error.message : "error desconocido");
    return rpcError(503, -32603, "Service unavailable", { "Retry-After": "30" });
  }
  // El token solo vale para el recurso con el que se emitió (RFC 8707).
  if (!auth || auth.resource !== mcpResource()) return unauthorized(true);

  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return rpcError(413, -32600, "Request body too large (max 1 MB)");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error: invalid JSON");
  }

  // El transporte exige `Accept: application/json, text/event-stream` y `Content-Type: application/json`.
  // Hay clientes de conectores que no los mandan así: JSON-RPC siempre es JSON, y aquí siempre se responde JSON.
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const normalized = new Request(request.url, { method: "POST", headers });

  const ctx = { userId: auth.userId, clientId: auth.clientId, scopes: auth.scopes };
  const server = buildMcpServer(ctx, allTools, {
    // Una línea por cada escritura hecha por un agente, como el propio atleta (RLS: solo su fila).
    audit: async (tool, args) => {
      await withUser(ctx.userId, (tx) =>
        tx.query("insert into fit.audit_log (user_id, actor, action, payload) values ($1, $2, $3, $4::jsonb)", [ctx.userId, `mcp:${ctx.clientId}`, tool, JSON.stringify(args ?? {})]),
      );
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(normalized, { parsedBody: body });
  } finally {
    void server.close();
  }
}

// Servidor sin estado: no hay flujo SSE que abrir ni sesión que cerrar.
function methodNotAllowed(request: Request): Response {
  void request.url; // dato de la petición: esta respuesta no se prerenderiza
  return rpcError(405, -32000, "Method not allowed: this MCP server is stateless, use POST", { Allow: "POST" });
}
export { methodNotAllowed as GET, methodNotAllowed as DELETE };
