import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { asSystem, getDb, withUser } from "@/db/client";
import { AppError } from "@/server/errors";
import { defineTool } from "@/server/mcp/registry";
import { allTools } from "@/server/mcp/server";
import { completeAuthorization, createAuthorizationCode, exchangeCode, mcpResource, registerClient, signConsent, validateAuthorizeRequest, type Scope } from "@/server/oauth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient as sdkRegisterClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { GET as mcpGet, POST as mcpPost } from "@/app/api/mcp/route";
import { GET as asMetadata, OPTIONS as asOptions } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as prMetadata } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as prMetadataMcp } from "@/app/.well-known/oauth-protected-resource/mcp/route";
import { POST as registerPost } from "@/app/oauth/register/route";
import { POST as revokePost } from "@/app/oauth/revoke/route";
import { POST as tokenPost } from "@/app/oauth/token/route";

// Las rutas usan la conexión del proceso: PGlite en memoria, nunca la base real.
delete process.env.DATABASE_URL;
process.env.PGLITE_DIR = "memory";
process.env.APP_URL = "https://fit.test/";

const APP = "https://fit.test";
const REDIRECT = "https://agente.example/callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

let user: string;
let nextId = 1;

async function tokenFor(scope: Scope[], resource: string = mcpResource()) {
  const client = await registerClient({ client_name: "Muse", redirect_uris: [REDIRECT] });
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode({ clientId: client.client_id, userId: user, redirectUri: REDIRECT, scope, codeChallenge: challenge, resource });
  const tokens = await exchangeCode({ code, clientId: client.client_id, redirectUri: REDIRECT, codeVerifier: verifier });
  return { clientId: client.client_id, access: tokens.access_token, refresh: tokens.refresh_token! };
}

const mcpRequest = (headers: Record<string, string>, body: string) => new Request(`${APP}/api/mcp`, { method: "POST", headers, body });
const rpcBody = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) });

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };
async function rpc(token: string, method: string, params?: unknown): Promise<Rpc> {
  const res = await mcpPost(
    mcpRequest({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, rpcBody(method, params)),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Rpc;
}
const toolNames = (r: Rpc) => (r.result!.tools as Array<{ name: string }>).map((t) => t.name);

beforeAll(async () => {
  const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email, name) values ('mcp@test.local', 'Atleta de prueba') returning id"));
  user = rows[0].id;
  // Herramientas de prueba: una de escritura con otro scope y una que falla con un error de dominio.
  allTools.push(
    defineTool({
      name: "test_log_note",
      title: "Nota de prueba",
      description: "Solo para tests.",
      scope: "mcp:log",
      readOnly: false,
      input: z.object({ note: z.string().min(1) }),
      handler: async (ctx, args) => ({ saved: args.note, by: ctx.userId }),
    }),
    defineTool({
      name: "test_ambiguous",
      title: "Ambigua",
      description: "Solo para tests.",
      scope: "mcp:read",
      readOnly: true,
      input: z.object({ crash: z.boolean().optional() }),
      handler: async (_ctx, args) => {
        if (args.crash) throw new Error("detalle interno con /ruta/secreta");
        throw new AppError("ambiguo", "Hay varios ejercicios que encajan. ¿Cuál?", { candidatos: ["curl-bayesian", "curl-martillo"] });
      },
    }),
  );
});
// El tope de 30 altas por hora es global: se envejecen las de cada test para que no lo alcance el fichero entero.
afterEach(async () => {
  await asSystem((tx) => tx.query("update fit.oauth_clients set created_at = created_at - interval '2 hours'"));
});
afterAll(async () => (await getDb()).close());

describe("POST /api/mcp: autenticación", () => {
  it("sin token → 401 con WWW-Authenticate que apunta a los metadatos", async () => {
    const res = await mcpPost(mcpRequest({ "content-type": "application/json" }, rpcBody("initialize")));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("token inventado, revocado o de otro recurso → 401 con error=invalid_token", async () => {
    const revoked = await tokenFor(["mcp:read"]);
    await revokePost(new Request(`${APP}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: revoked.access }) }));
    const foreign = await tokenFor(["mcp:read"], "https://otro.test/api/mcp");
    for (const token of ["fit_at_" + "x".repeat(43), "cualquier-cosa", revoked.access, foreign.access, revoked.refresh]) {
      const res = await mcpPost(mcpRequest({ authorization: `Bearer ${token}`, "content-type": "application/json" }, rpcBody("tools/list")));
      expect(res.status).toBe(401);
      const header = res.headers.get("www-authenticate")!;
      expect(header).toContain('error="invalid_token"');
      expect(header).toContain(`resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`);
    }
  });

  it("GET y DELETE → 405 con Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = mcpGet(new Request(`${APP}/api/mcp`, { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("cuerpo de más de 1 MB → 413; JSON roto → 400", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const headers = { authorization: `Bearer ${access}`, "content-type": "application/json" };
    const big = await mcpPost(mcpRequest(headers, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } })));
    expect(big.status).toBe(413);
    const broken = await mcpPost(mcpRequest(headers, "{no es json"));
    expect(broken.status).toBe(400);
  });
});

describe("POST /api/mcp: protocolo y herramientas", () => {
  it("initialize", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const r = await rpc(access, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(r.result).toMatchObject({ serverInfo: { name: "sistema-fisico" }, capabilities: { tools: expect.anything() } });
  });

  it("tolera `bearer` en minúsculas y que falten Accept y Content-Type", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const res = await mcpPost(mcpRequest({ authorization: `bearer ${access}` }, rpcBody("tools/list")));
    expect(res.status).toBe(200);
    expect(toolNames((await res.json()) as Rpc)).toContain("whoami");
  });

  it("tools/list solo enseña las herramientas de los scopes del token", async () => {
    const read = await tokenFor(["mcp:read"]);
    const names = toolNames(await rpc(read.access, "tools/list"));
    expect(names).toEqual(expect.arrayContaining(["whoami", "server_guide", "test_ambiguous"]));
    expect(names).not.toContain("test_log_note");

    const log = await tokenFor(["mcp:read", "mcp:log"]);
    const listed = await rpc(log.access, "tools/list");
    expect(toolNames(listed)).toContain("test_log_note");
    const tools = listed.result!.tools as Array<{ name: string; annotations: Record<string, boolean>; inputSchema: { properties: Record<string, unknown> } }>;
    expect(tools.find((t) => t.name === "whoami")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const write = tools.find((t) => t.name === "test_log_note")!;
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(write.inputSchema.properties).toHaveProperty("note");

    // Solo mcp:log: no ve las de lectura.
    const onlyLog = await tokenFor(["mcp:log"]);
    expect(toolNames(await rpc(onlyLog.access, "tools/list"))).toEqual(["test_log_note"]);
  });

  it("tools/call whoami", async () => {
    const { access, clientId } = await tokenFor(["mcp:read"]);
    const r = await rpc(access, "tools/call", { name: "whoami", arguments: {} });
    expect(r.result!.isError).toBeFalsy();
    const data = r.result!.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ athlete_id: user, name: "Atleta de prueba", client_id: clientId, scopes: ["mcp:read"], timezone: "Europe/Madrid", version: "0.1.0" });
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const content = r.result!.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual(data);
  });

  it("tools/call server_guide devuelve el texto de reglas", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const r = await rpc(access, "tools/call", { name: "server_guide", arguments: {} });
    const content = r.result!.content as Array<{ text: string }>;
    expect(content[0].text).toContain("Nunca inventes calorías");
  });

  it("una herramienta fuera de los scopes del token no se puede llamar", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const r = await rpc(access, "tools/call", { name: "test_log_note", arguments: { note: "hola" } });
    expect(Boolean(r.error) || r.result?.isError === true).toBe(true);
    expect(JSON.stringify(r)).not.toContain('"saved"');
    const audit = await withUser(user, (tx) => tx.query("select 1 from fit.audit_log where action = 'test_log_note'"));
    expect(audit).toEqual([]);
  });

  it("una escritura deja una línea en audit_log; una lectura no", async () => {
    const { access, clientId } = await tokenFor(["mcp:read", "mcp:log"]);
    await rpc(access, "tools/call", { name: "whoami", arguments: {} });
    const r = await rpc(access, "tools/call", { name: "test_log_note", arguments: { note: "press banca 80x5" } });
    expect(r.result!.structuredContent).toEqual({ saved: "press banca 80x5", by: user });
    const audit = await withUser(user, (tx) => tx.query<{ actor: string; action: string; payload: unknown }>("select actor, action, payload from fit.audit_log order by id"));
    expect(audit).toEqual([{ actor: `mcp:${clientId}`, action: "test_log_note", payload: { note: "press banca 80x5" } }]);
  });

  it("argumentos no válidos → error sin ejecutar ni auditar", async () => {
    const { access } = await tokenFor(["mcp:read", "mcp:log"]);
    const before = (await withUser(user, (tx) => tx.query("select 1 from fit.audit_log"))).length;
    const r = await rpc(access, "tools/call", { name: "test_log_note", arguments: { note: 7 } });
    expect(Boolean(r.error) || r.result?.isError === true).toBe(true);
    expect((await withUser(user, (tx) => tx.query("select 1 from fit.audit_log"))).length).toBe(before);
  });

  it("un AppError llega como isError con el mensaje y sus detalles", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const r = await rpc(access, "tools/call", { name: "test_ambiguous", arguments: {} });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.structuredContent).toEqual({ error: "ambiguo", message: "Hay varios ejercicios que encajan. ¿Cuál?", details: { candidatos: ["curl-bayesian", "curl-martillo"] } });
  });

  it("cualquier otro error → mensaje genérico, sin detalle interno", async () => {
    const { access } = await tokenFor(["mcp:read"]);
    const r = await rpc(access, "tools/call", { name: "test_ambiguous", arguments: { crash: true } });
    expect(r.result!.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("secreta");
    expect((r.result!.structuredContent as { error: string }).error).toBe("interno");
  });
});

describe("descubrimiento", () => {
  it("recurso protegido (RFC 9728), con y sin sufijo /mcp", async () => {
    const expected = { resource: `${APP}/api/mcp`, authorization_servers: [APP], scopes_supported: ["mcp:read", "mcp:log", "mcp:plan"], bearer_methods_supported: ["header"] };
    for (const [handler, path] of [
      [prMetadata, "/.well-known/oauth-protected-resource"],
      [prMetadataMcp, "/.well-known/oauth-protected-resource/mcp"],
    ] as const) {
      const res = await handler(new Request(`${APP}${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toMatchObject(expected);
    }
  });

  it("servidor de autorización (RFC 8414): URLs coherentes con APP_URL", async () => {
    const res = await asMetadata(new Request(`${APP}/.well-known/oauth-authorization-server`));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: APP,
      authorization_endpoint: `${APP}/oauth/authorize`,
      token_endpoint: `${APP}/oauth/token`,
      registration_endpoint: `${APP}/oauth/register`,
      revocation_endpoint: `${APP}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
    const pre = asOptions();
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("rutas OAuth por HTTP", () => {
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    new Request(`${APP}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });

  it("registro → canje → refresh → MCP → revocación", async () => {
    const reg = await registerPost(new Request(`${APP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Muse", redirect_uris: [REDIRECT] }) }));
    expect(reg.status).toBe(201);
    expect(reg.headers.get("access-control-allow-origin")).toBe("*");
    const client = (await reg.json()) as { client_id: string };

    const { verifier, challenge } = pkce();
    const code = await createAuthorizationCode({ clientId: client.client_id, userId: user, redirectUri: REDIRECT, scope: ["mcp:read"], codeChallenge: challenge });
    const res = await tokenPost(form("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const tokens = (await res.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });

    const refreshed = await tokenPost(form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }));
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect(toolNames(await rpc(next.access_token, "tools/list"))).toContain("whoami");

    const revoked = await revokePost(form("/oauth/revoke", { token: next.access_token }));
    expect(revoked.status).toBe(200);
    const after = await mcpPost(mcpRequest({ authorization: `Bearer ${next.access_token}` }, rpcBody("tools/list")));
    expect(after.status).toBe(401);
  });

  it("errores con los códigos de RFC 6749", async () => {
    const bad = await tokenPost(form("/oauth/token", { grant_type: "authorization_code", code: "inventado", client_id: "no-existe", code_verifier: "a".repeat(43) }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "invalid_client" });
    expect(bad.headers.get("cache-control")).toBe("no-store");

    const grantType = await tokenPost(form("/oauth/token", { grant_type: "password", username: "a", password: "b" }));
    expect(grantType.status).toBe(400);
    expect(await grantType.json()).toMatchObject({ error: "unsupported_grant_type" });

    const noBody = await tokenPost(new Request(`${APP}/oauth/token`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hola" }));
    expect(await noBody.json()).toMatchObject({ error: "invalid_request" });

    const reg = await registerPost(new Request(`${APP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://malo.example/cb"] }) }));
    expect(reg.status).toBe(400);
    expect(await reg.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("revocar responde 200 aunque el token no exista o falte", async () => {
    expect((await revokePost(form("/oauth/revoke", { token: "no-existe" }))).status).toBe(200);
    expect((await revokePost(form("/oauth/revoke", {}))).status).toBe(200);
  });
});

describe("un cliente MCP de verdad (el del SDK), sin red", () => {
  // `fetch` que entrega cada petición al manejador de su ruta, como haría Next.
  const routes: Record<string, (req: Request) => Response | Promise<Response>> = {
    "POST /api/mcp": mcpPost,
    "GET /api/mcp": mcpGet,
    "DELETE /api/mcp": mcpGet,
    "GET /.well-known/oauth-protected-resource": prMetadata,
    "GET /.well-known/oauth-protected-resource/mcp": prMetadataMcp,
    "GET /.well-known/oauth-authorization-server": asMetadata,
    "POST /oauth/register": registerPost,
    "POST /oauth/token": tokenPost,
    "POST /oauth/revoke": revokePost,
  };
  const inProcessFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const handler = routes[`${req.method} ${new URL(req.url).pathname}`];
    return handler ? handler(req) : new Response("Not found", { status: 404 });
  };

  it("descubre, se registra, autoriza con PKCE, canjea, llama a una herramienta y refresca", async () => {
    const serverUrl = `${APP}/api/mcp`;
    // 1. El 401 dice dónde están los metadatos.
    const challenge = await inProcessFetch(serverUrl, { method: "POST", headers: { "content-type": "application/json" }, body: rpcBody("initialize") });
    expect(challenge.status).toBe(401);
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
    expect(resourceMetadataUrl?.href).toBe(`${APP}/.well-known/oauth-protected-resource/mcp`);

    // 2. Descubrimiento.
    const resourceMeta = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl }, inProcessFetch);
    expect(resourceMeta.resource).toBe(serverUrl);
    const issuer = resourceMeta.authorization_servers![0];
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: inProcessFetch });
    expect(metadata?.issuer).toBe(APP);
    // Un cliente que ignora la cabecera y prueba la raíz también los encuentra.
    expect((await discoverOAuthProtectedResourceMetadata(serverUrl, undefined, inProcessFetch)).resource).toBe(serverUrl);

    // 3. Registro dinámico.
    const clientInformation = await sdkRegisterClient(issuer, {
      metadata,
      clientMetadata: { client_name: "Cliente SDK", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      fetchFn: inProcessFetch,
    });

    // 4. Autorización: la URL que abriría el navegador, y lo que hace la pantalla de consentimiento.
    const resource = new URL(serverUrl);
    const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata, clientInformation, redirectUrl: REDIRECT, scope: "mcp:read", state: "estado-1", resource });
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${APP}/oauth/authorize`);
    const check = await validateAuthorizeRequest(Object.fromEntries(authorizationUrl.searchParams));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const consent = signConsent({ userId: user, clientId: check.client.clientId, redirectUri: check.redirectUri, scope: check.scope, state: check.state, codeChallenge: check.codeChallenge, resource: check.resource });
    const decision = await completeAuthorization({ userId: user, consent, approve: true });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const back = new URL(decision.redirectTo);
    expect(back.searchParams.get("state")).toBe("estado-1");

    // 5. Canje.
    const tokens = await exchangeAuthorization(issuer, { metadata, clientInformation, authorizationCode: back.searchParams.get("code")!, codeVerifier, redirectUri: REDIRECT, resource, fetchFn: inProcessFetch });
    expect(tokens.token_type).toBe("Bearer");

    // 6. El cliente MCP habla con el servidor.
    const client = new Client({ name: "cliente-sdk", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { fetch: inProcessFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    expect(client.getServerVersion()?.name).toBe("sistema-fisico");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["whoami", "server_guide"]));
    expect(tools.map((t) => t.name)).not.toContain("test_log_note");
    const who = await client.callTool({ name: "whoami", arguments: {} });
    expect(who.structuredContent).toMatchObject({ athlete_id: user, client_id: clientInformation.client_id, scopes: ["mcp:read"] });
    await client.close();

    // 7. Refresh con rotación.
    const refreshed = await refreshAuthorization(issuer, { metadata, clientInformation, refreshToken: tokens.refresh_token!, resource, fetchFn: inProcessFetch });
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  });
});
