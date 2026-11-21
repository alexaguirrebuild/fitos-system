import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, type Db } from "@/db/client";
import { AppError } from "@/server/errors";
import {
  authorizationServerMetadata,
  completeAuthorization,
  createAuthorizationCode,
  exchangeCode,
  listGrants,
  mcpResource,
  OAuthError,
  oauthClock,
  refreshTokens,
  registerClient,
  revokeGrant,
  revokeToken,
  signConsent,
  validateAuthorizeRequest,
  verifyAccessToken,
  verifyConsent,
  type Scope,
} from "@/server/oauth";

const APP = "https://fit.test";
const REDIRECT = "https://agente.example/callback";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const realNow = oauthClock.now;
const travel = (seconds: number) => {
  oauthClock.now = () => new Date(Date.now() + seconds * 1000);
};
/** Espera un OAuthError con ese código (y estado HTTP, si se da). */
async function expectOAuth(p: Promise<unknown>, code: string, status?: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe(code);
  if (status) expect((err as OAuthError).status).toBe(status);
}

let db: Db;
let user: string;
let other: string;

beforeAll(async () => {
  process.env.APP_URL = APP;
  db = await openMemoryDb();
  const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('oauth@test.local'), ('otro@test.local') returning id"), db);
  [user, other] = rows.map((r) => r.id);
});
afterEach(async () => {
  oauthClock.now = realNow;
  // El tope de 30 altas por hora es global: se envejecen las de cada test para que no lo alcance el fichero entero.
  await db.query("update fit.oauth_clients set created_at = created_at - interval '2 hours'");
});
afterAll(async () => db.close());

const newClient = (extra: Record<string, unknown> = {}) => registerClient({ client_name: "Muse", redirect_uris: [REDIRECT], ...extra }, db);

/** Cliente + código listo para canjear. */
async function grant(scope: Scope[] = ["mcp:read"], clientExtra: Record<string, unknown> = {}) {
  const client = await newClient(clientExtra);
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode({ clientId: client.client_id, userId: user, redirectUri: REDIRECT, scope, codeChallenge: challenge, resource: mcpResource() }, db);
  return { client, verifier, challenge, code };
}
async function tokensFor(scope: Scope[] = ["mcp:read"]) {
  const g = await grant(scope);
  const tokens = await exchangeCode({ code: g.code, clientId: g.client.client_id, redirectUri: REDIRECT, codeVerifier: g.verifier }, db);
  return { ...g, tokens };
}

describe("registro dinámico (RFC 7591)", () => {
  it("registra un cliente público y devuelve el documento", async () => {
    const c = await newClient({ redirect_uris: [REDIRECT, "http://localhost:8765/cb", "http://127.0.0.1/cb"] });
    expect(c.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c).toMatchObject({ client_name: "Muse", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    expect(c.redirect_uris).toHaveLength(3);
    expect(c.client_secret).toBeUndefined();
  });

  it("con client_secret_post devuelve el secreto una vez y guarda solo su hash", async () => {
    const c = await newClient({ token_endpoint_auth_method: "client_secret_post" });
    expect(c.client_secret).toBeTruthy();
    const rows = await db.query<{ client_secret_hash: string }>("select client_secret_hash from fit.oauth_clients where client_id = $1", [c.client_id]);
    expect(rows[0].client_secret_hash).toBe(sha256(c.client_secret!));
    expect(JSON.stringify(await db.query("select * from fit.oauth_clients where client_id = $1", [c.client_id]))).not.toContain(c.client_secret!);
  });

  it("descarta los grants que no soporta y limpia el nombre", async () => {
    const c = await newClient({ client_name: "  Mu‮se\u0007 ", grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"] });
    expect(c.grant_types).toEqual(["authorization_code"]);
    expect(c.client_name).toBe("Muse");
  });

  it("rechaza redirect_uris no válidos", async () => {
    await expectOAuth(newClient({ redirect_uris: ["http://agente.example/callback"] }), "invalid_redirect_uri");
    await expectOAuth(newClient({ redirect_uris: ["https://agente.example/callback#frag"] }), "invalid_redirect_uri");
    await expectOAuth(newClient({ redirect_uris: ["myapp://callback"] }), "invalid_redirect_uri");
    await expectOAuth(newClient({ redirect_uris: ["https://user:pw@agente.example/cb"] }), "invalid_redirect_uri");
    await expectOAuth(newClient({ redirect_uris: [] }), "invalid_redirect_uri");
    await expectOAuth(newClient({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }), "invalid_redirect_uri");
    await expectOAuth(registerClient({ client_name: "sin redirect" }, db), "invalid_redirect_uri");
  });

  it("rechaza metadatos no válidos", async () => {
    await expectOAuth(newClient({ client_name: "x".repeat(101) }), "invalid_client_metadata");
    await expectOAuth(newClient({ token_endpoint_auth_method: "client_secret_basic" }), "invalid_client_metadata");
    await expectOAuth(newClient({ grant_types: ["client_credentials"] }), "invalid_client_metadata");
    await expectOAuth(newClient({ response_types: ["token"] }), "invalid_client_metadata");
  });

  it("corta a los 30 registros por hora con el error `limite`", async () => {
    const db2 = await openMemoryDb();
    try {
      for (let i = 0; i < 30; i++) await registerClient({ redirect_uris: [REDIRECT] }, db2);
      const err = await registerClient({ redirect_uris: [REDIRECT] }, db2).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("limite");
      // Pasada la hora vuelve a dejar; y al día, los que nunca pidieron permiso se limpian.
      travel(3601);
      await registerClient({ redirect_uris: [REDIRECT] }, db2);
      travel(2 * 86_400);
      await registerClient({ redirect_uris: [REDIRECT] }, db2);
      const n = await db2.query<{ n: number }>("select count(*)::int as n from fit.oauth_clients");
      expect(n[0].n).toBe(1);
    } finally {
      await db2.close();
    }
  });
});

describe("validación de /oauth/authorize", () => {
  const base = async () => {
    const client = await newClient();
    return { response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "xyz" };
  };

  it("acepta una petición correcta; sin scope concede mcp:read", async () => {
    const r = await validateAuthorizeRequest({ ...(await base()), resource: mcpResource() }, db);
    expect(r).toMatchObject({ ok: true, redirectUri: REDIRECT, scope: ["mcp:read"], state: "xyz", resource: `${APP}/api/mcp` });
    const r2 = await validateAuthorizeRequest({ ...(await base()), scope: "mcp:plan mcp:read" }, db);
    expect(r2).toMatchObject({ ok: true, scope: ["mcp:read", "mcp:plan"] });
  });

  it("tolera lo que manda el cliente de Meta: comas, scopes ajenos, host truncado y scopes del registro", async () => {
    const p = await base();
    expect(await validateAuthorizeRequest({ ...p, scope: "mcp:read,mcp:log" }, db)).toMatchObject({ ok: true, scope: ["mcp:read", "mcp:log"] });
    expect(await validateAuthorizeRequest({ ...p, scope: "mcp:read offline_access" }, db)).toMatchObject({ ok: true, scope: ["mcp:read"] });
    expect(await validateAuthorizeRequest({ ...p, resource: "https://fit/api/mcp" }, db)).toMatchObject({ ok: true, resource: `${APP}/api/mcp` });
    const meta = await newClient({ scope: "mcp:read mcp:log" });
    expect(await validateAuthorizeRequest({ ...p, client_id: meta.client_id }, db)).toMatchObject({ ok: true, scope: ["mcp:read", "mcp:log"] });
  });

  it("cliente desconocido o redirect_uri no registrado: error NO redirigible", async () => {
    const p = await base();
    for (const bad of [
      { ...p, client_id: "no-existe" },
      { ...p, redirect_uri: "https://atacante.example/callback" },
      { ...p, redirect_uri: `${REDIRECT}/` },
      { ...p, redirect_uri: undefined },
    ]) {
      const r = await validateAuthorizeRequest(bad, db);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.redirectable).toBe(false);
        expect(r.redirectUri).toBeUndefined();
      }
    }
  });

  it("el resto de errores vuelven al agente con su código", async () => {
    const p = await base();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...p, response_type: "token" }, "unsupported_response_type"],
      [{ ...p, code_challenge: undefined }, "invalid_request"],
      [{ ...p, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...p, code_challenge_method: undefined }, "invalid_request"],
      [{ ...p, scope: "admin" }, "invalid_scope"],
      [{ ...p, resource: "https://otro.example/api/mcp" }, "invalid_target"],
    ];
    for (const [params, error] of cases) {
      const r = await validateAuthorizeRequest(params, db);
      expect(r).toMatchObject({ ok: false, redirectable: true, error, redirectUri: REDIRECT, state: "xyz" });
    }
  });
});

describe("canje del código", () => {
  it("flujo completo: código → tokens con PKCE correcto", async () => {
    const { client, tokens } = await tokensFor(["mcp:read", "mcp:log"]);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:log" });
    expect(tokens.access_token).toMatch(/^fit_at_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^fit_rt_[A-Za-z0-9_-]{43}$/);
    const info = await verifyAccessToken(tokens.access_token, db);
    expect(info).toMatchObject({ userId: user, clientId: client.client_id, scopes: ["mcp:read", "mcp:log"], resource: `${APP}/api/mcp` });
    // En la base solo hay hashes.
    const dump = JSON.stringify([await db.query("select * from fit.oauth_tokens"), await db.query("select * from fit.oauth_codes")]);
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token!);
    expect(dump).toContain(sha256(tokens.access_token));
  });

  it("PKCE incorrecto: falla y además gasta el código", async () => {
    const g = await grant();
    await expectOAuth(exchangeCode({ code: g.code, clientId: g.client.client_id, redirectUri: REDIRECT, codeVerifier: pkce().verifier }, db), "invalid_grant");
    await expectOAuth(exchangeCode({ code: g.code, clientId: g.client.client_id, redirectUri: REDIRECT, codeVerifier: g.verifier }, db), "invalid_grant");
  });

  it("código reutilizado: el segundo intento falla y revoca lo emitido", async () => {
    const { client, code, verifier, tokens } = await tokensFor();
    expect(await verifyAccessToken(tokens.access_token, db)).not.toBeNull();
    await expectOAuth(exchangeCode({ code, clientId: client.client_id, redirectUri: REDIRECT, codeVerifier: verifier }, db), "invalid_grant");
    expect(await verifyAccessToken(tokens.access_token, db)).toBeNull();
    await expectOAuth(refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id }, db), "invalid_grant");
  });

  it("código caducado (5 min)", async () => {
    const g = await grant();
    travel(5 * 60 + 1);
    await expectOAuth(exchangeCode({ code: g.code, clientId: g.client.client_id, redirectUri: REDIRECT, codeVerifier: g.verifier }, db), "invalid_grant");
  });

  it("otro cliente, otro redirect_uri o un código inventado no canjean", async () => {
    const a = await grant();
    const b = await newClient();
    await expectOAuth(exchangeCode({ code: a.code, clientId: b.client_id, redirectUri: REDIRECT, codeVerifier: a.verifier }, db), "invalid_grant");
    const c = await grant();
    await expectOAuth(exchangeCode({ code: c.code, clientId: c.client.client_id, redirectUri: "https://agente.example/otro", codeVerifier: c.verifier }, db), "invalid_grant");
    await expectOAuth(exchangeCode({ code: "inventado", clientId: c.client.client_id, redirectUri: REDIRECT, codeVerifier: c.verifier }, db), "invalid_grant");
    await expectOAuth(exchangeCode({ code: c.code, clientId: "no-existe", redirectUri: REDIRECT, codeVerifier: c.verifier }, db), "invalid_client", 401);
  });

  it("sin redirect_uri en el canje también vale (OAuth 2.1: lo cubre PKCE)", async () => {
    const g = await grant();
    const t = await exchangeCode({ code: g.code, clientId: g.client.client_id, codeVerifier: g.verifier }, db);
    expect(t.access_token).toBeTruthy();
  });

  it("un cliente con secreto tiene que presentarlo", async () => {
    const g = await grant(["mcp:read"], { token_endpoint_auth_method: "client_secret_post" });
    await expectOAuth(exchangeCode({ code: g.code, clientId: g.client.client_id, redirectUri: REDIRECT, codeVerifier: g.verifier }, db), "invalid_client", 401);
    await expectOAuth(exchangeCode({ code: g.code, clientId: g.client.client_id, clientSecret: "malo", redirectUri: REDIRECT, codeVerifier: g.verifier }, db), "invalid_client", 401);
    // Un fallo de autenticación del cliente no gasta el código.
    const t = await exchangeCode({ code: g.code, clientId: g.client.client_id, clientSecret: g.client.client_secret, redirectUri: REDIRECT, codeVerifier: g.verifier }, db);
    expect(t.access_token).toBeTruthy();
  });
});

describe("refresh", () => {
  it("rota: el refresh nuevo vale y la pareja anterior deja de valer", async () => {
    const { client, tokens } = await tokensFor();
    const next = await refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id }, db);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(await verifyAccessToken(next.access_token, db)).toMatchObject({ userId: user, scopes: ["mcp:read"] });
    expect(await verifyAccessToken(tokens.access_token, db)).toBeNull();
    const again = await refreshTokens({ refreshToken: next.refresh_token!, clientId: client.client_id }, db);
    expect(await verifyAccessToken(again.access_token, db)).not.toBeNull();
  });

  it("reutilizar un refresh ya rotado revoca toda la concesión", async () => {
    const { client, tokens } = await tokensFor();
    const next = await refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id }, db);
    await expectOAuth(refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id }, db), "invalid_grant");
    expect(await verifyAccessToken(next.access_token, db)).toBeNull();
    await expectOAuth(refreshTokens({ refreshToken: next.refresh_token!, clientId: client.client_id }, db), "invalid_grant");
    expect((await listGrants(user, db)).find((g) => g.clientId === client.client_id)).toBeUndefined();
  });

  it("el scope solo puede reducirse", async () => {
    const { client, tokens } = await tokensFor(["mcp:read", "mcp:log"]);
    // Pedir de más falla y no gasta el refresh.
    await expectOAuth(refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id, scope: "mcp:read mcp:plan" }, db), "invalid_scope");
    const narrowed = await refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id, scope: "mcp:read" }, db);
    expect(narrowed.scope).toBe("mcp:read");
    expect((await verifyAccessToken(narrowed.access_token, db))?.scopes).toEqual(["mcp:read"]);
    // Lo reducido no vuelve a crecer.
    await expectOAuth(refreshTokens({ refreshToken: narrowed.refresh_token!, clientId: client.client_id, scope: "mcp:read mcp:log" }, db), "invalid_scope");
  });

  it("refresh caducado (60 días), de otro cliente o inventado", async () => {
    const { tokens, client } = await tokensFor();
    const b = await newClient();
    await expectOAuth(refreshTokens({ refreshToken: tokens.refresh_token!, clientId: b.client_id }, db), "invalid_grant");
    await expectOAuth(refreshTokens({ refreshToken: "fit_rt_inventado", clientId: client.client_id }, db), "invalid_grant");
    // Un access no sirve como refresh.
    await expectOAuth(refreshTokens({ refreshToken: tokens.access_token, clientId: client.client_id }, db), "invalid_grant");
    travel(60 * 86_400 + 1);
    await expectOAuth(refreshTokens({ refreshToken: tokens.refresh_token!, clientId: client.client_id }, db), "invalid_grant");
  });
});

describe("tokens de acceso", () => {
  it("caducado (1 h) → null", async () => {
    const { tokens } = await tokensFor();
    travel(3599);
    expect(await verifyAccessToken(tokens.access_token, db)).not.toBeNull();
    travel(3601);
    expect(await verifyAccessToken(tokens.access_token, db)).toBeNull();
  });

  it("revocado → null, con el access o con el refresh", async () => {
    const a = await tokensFor();
    expect(await revokeToken(a.tokens.access_token, db)).toBe(true);
    expect(await verifyAccessToken(a.tokens.access_token, db)).toBeNull();
    await expectOAuth(refreshTokens({ refreshToken: a.tokens.refresh_token!, clientId: a.client.client_id }, db), "invalid_grant");
    const b = await tokensFor();
    expect(await revokeToken(b.tokens.refresh_token!, db)).toBe(true);
    expect(await verifyAccessToken(b.tokens.access_token, db)).toBeNull();
    expect(await revokeToken("fit_at_inventado", db)).toBe(false);
  });

  it("inventado, vacío o un refresh usado como access → null", async () => {
    const { tokens } = await tokensFor();
    expect(await verifyAccessToken("", db)).toBeNull();
    expect(await verifyAccessToken("fit_at_" + "a".repeat(43), db)).toBeNull();
    expect(await verifyAccessToken(tokens.refresh_token!, db)).toBeNull();
  });

  it("last_used_at se apunta como mucho una vez por minuto", async () => {
    const { tokens } = await tokensFor();
    const read = async () => (await db.query<{ last_used_at: Date | null }>("select last_used_at from fit.oauth_tokens where access_hash = $1", [sha256(tokens.access_token)]))[0].last_used_at;
    expect(await read()).toBeNull();
    await verifyAccessToken(tokens.access_token, db);
    const first = new Date(String(await read())).getTime();
    travel(30);
    await verifyAccessToken(tokens.access_token, db);
    expect(new Date(String(await read())).getTime()).toBe(first);
    travel(61);
    await verifyAccessToken(tokens.access_token, db);
    expect(new Date(String(await read())).getTime()).toBeGreaterThan(first);
  });

  it("listGrants agrupa por cliente y revokeGrant desconecta", async () => {
    const a = await tokensFor(["mcp:read", "mcp:plan"]);
    await refreshTokens({ refreshToken: a.tokens.refresh_token!, clientId: a.client.client_id }, db);
    const mine = (await listGrants(user, db)).filter((g) => g.clientId === a.client.client_id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ clientName: "Muse", scopes: ["mcp:read", "mcp:plan"] });
    expect(mine[0].createdAt).toBeInstanceOf(Date);
    expect(await listGrants(other, db)).toEqual([]);
    // Otro atleta no puede desconectar lo que no es suyo.
    expect(await revokeGrant(other, a.client.client_id, db)).toBe(0);
    expect(await revokeGrant(user, a.client.client_id, db)).toBe(1);
    expect((await listGrants(user, db)).find((g) => g.clientId === a.client.client_id)).toBeUndefined();
  });
});

describe("consentimiento firmado", () => {
  const input = async () => {
    const client = await newClient();
    return { userId: user, clientId: client.client_id, redirectUri: REDIRECT, scope: ["mcp:read", "mcp:log"] as Scope[], state: "st-1", codeChallenge: pkce().challenge, resource: mcpResource() };
  };

  it("firma y verifica", async () => {
    const i = await input();
    expect(verifyConsent(signConsent(i), user)).toEqual(i);
  });

  it("rechaza la firma manipulada, la de otro usuario y la caducada", async () => {
    const i = await input();
    const token = signConsent(i);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), r: "https://atacante.example/cb", s: "mcp:read mcp:log mcp:plan" })).toString("base64url");
    expect(verifyConsent(`${forged}.${sig}`, user)).toBeNull();
    expect(verifyConsent(`${body}.${sig.slice(0, -2)}AA`, user)).toBeNull();
    expect(verifyConsent(body, user)).toBeNull();
    expect(verifyConsent(token, other)).toBeNull();
    travel(10 * 60 + 1);
    expect(verifyConsent(token, user)).toBeNull();
  });

  it("autorizar crea un código canjeable y vuelve con state e iss", async () => {
    const client = await newClient();
    const { verifier, challenge } = pkce();
    const consent = signConsent({ userId: user, clientId: client.client_id, redirectUri: REDIRECT, scope: ["mcp:read"], state: "st-2", codeChallenge: challenge, resource: mcpResource() });
    const done = await completeAuthorization({ userId: user, consent, approve: true }, db);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const back = new URL(done.redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-2");
    expect(back.searchParams.get("iss")).toBe(APP);
    const t = await exchangeCode({ code: back.searchParams.get("code")!, clientId: client.client_id, redirectUri: REDIRECT, codeVerifier: verifier }, db);
    expect(await verifyAccessToken(t.access_token, db)).toMatchObject({ userId: user, scopes: ["mcp:read"] });
  });

  it("cancelar vuelve con access_denied y no crea código", async () => {
    const i = await input();
    const before = (await db.query<{ n: number }>("select count(*)::int as n from fit.oauth_codes"))[0].n;
    const done = await completeAuthorization({ userId: user, consent: signConsent(i), approve: false }, db);
    expect(done.ok).toBe(true);
    if (done.ok) expect(new URL(done.redirectTo).searchParams.get("error")).toBe("access_denied");
    expect((await db.query<{ n: number }>("select count(*)::int as n from fit.oauth_codes"))[0].n).toBe(before);
  });

  it("no crea código con firma manipulada, de otra sesión o si el cliente ya no existe", async () => {
    const i = await input();
    const token = signConsent(i);
    expect(await completeAuthorization({ userId: user, consent: token + "x", approve: true }, db)).toMatchObject({ ok: false, reason: "caducado" });
    expect(await completeAuthorization({ userId: other, consent: token, approve: true }, db)).toMatchObject({ ok: false, reason: "caducado" });
    await db.query("delete from fit.oauth_clients where client_id = $1", [i.clientId]);
    expect(await completeAuthorization({ userId: user, consent: token, approve: true }, db)).toMatchObject({ ok: false, reason: "invalido" });
  });
});

describe("metadatos", () => {
  it("el servidor de autorización anuncia lo que hay", () => {
    expect(authorizationServerMetadata()).toMatchObject({
      issuer: APP,
      authorization_endpoint: `${APP}/oauth/authorize`,
      token_endpoint: `${APP}/oauth/token`,
      registration_endpoint: `${APP}/oauth/register`,
      revocation_endpoint: `${APP}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["mcp:read", "mcp:log", "mcp:plan"],
    });
  });
});
