/**
 * Servidor OAuth 2.1 propio delante de /api/mcp (Muse y cualquier cliente MCP remoto).
 *  - Registro dinámico (RFC 7591), metadatos (RFC 8414 y 9728), PKCE S256 obligatorio,
 *    `resource` (RFC 8707) ligado al token, refresh con rotación y detección de reúso, revocación (RFC 7009).
 *  - Códigos y tokens son opacos; en la base solo queda su SHA-256. Nunca van a un log.
 *  - Todo pasa por asSystem(): las tablas fit.oauth_* no tienen política para el rol del atleta.
 * Las funciones que tocan la base aceptan `db?: Db` al final (tests con PGlite en memoria).
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { asSystem, type Db, type Tx } from "@/db/client";
import { AppError } from "@/server/errors";

// ── Scopes ──────────────────────────────────────────────────────────────────
/** Permisos que puede pedir un agente, con el texto que ve el dueño en la pantalla de consentimiento. */
export const SCOPES = {
  "mcp:read": "Leer tu estado, tu plan, el historial de entrenos y la nutrición.",
  "mcp:log": "Registrar series, comidas, peso, check-in, pasos y cardio.",
  "mcp:plan": "Cambiar el plan y los objetivos, y aplicar ajustes de progresión.",
} as const;
export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];
export const DEFAULT_SCOPE: Scope = "mcp:read";
const isScope = (s: string): s is Scope => Object.prototype.hasOwnProperty.call(SCOPES, s);

// ── Configuración ───────────────────────────────────────────────────────────
export const CODE_TTL_S = 5 * 60;
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 60 * 24 * 60 * 60;
export const CONSENT_TTL_S = 10 * 60;
export const MAX_REGISTRATIONS_PER_HOUR = 30;
export const ACCESS_PREFIX = "fit_at_";
export const REFRESH_PREFIX = "fit_rt_";
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"] as const;
const AUTH_METHODS = ["none", "client_secret_post"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

/** Reloj inyectable: los tests lo adelantan para caducar códigos y tokens. */
export const oauthClock = { now: (): Date => new Date() };

/** Identificador del servidor de autorización: APP_URL sin barra final. */
export function issuer(): string {
  return (process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}
/** El recurso protegido (audiencia de los tokens). */
export const mcpResource = (): string => `${issuer()}/api/mcp`;
/** A dónde apunta el 401 de /api/mcp (RFC 9728 §5.1). */
export const resourceMetadataUrl = (): string => `${issuer()}/.well-known/oauth-protected-resource/mcp`;

// ── Errores ─────────────────────────────────────────────────────────────────
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "server_error";

/** Error con el código de RFC 6749 §5.2 (o RFC 7591 §3.2.2 en el registro). */
export class OAuthError extends Error {
  constructor(
    public code: OAuthErrorCode,
    public description: string,
    public status = 400,
  ) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
  }
}

// ── Criptografía ────────────────────────────────────────────────────────────
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const randomSecret = (prefix = "") => prefix + randomBytes(32).toString("base64url");
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const iso = (d: Date) => d.toISOString();
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);
const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
/** text[] como parámetro sin depender de cómo serializa arrays cada driver. */
const TEXT_ARRAY = (n: number) => `(select coalesce(array_agg(x), '{}') from jsonb_array_elements_text($${n}::jsonb) x)`;

// ── Clientes (RFC 7591) ─────────────────────────────────────────────────────
export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: AuthMethod;
}
type ClientRow = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  client_secret_hash: string | null;
  /** Scopes que el cliente declaró al registrarse (metadata.scope). */
  registered_scope?: string | null;
};
const CLIENT_COLS =
  "client_id, client_name, to_jsonb(redirect_uris) as redirect_uris, to_jsonb(grant_types) as grant_types, token_endpoint_auth_method, client_secret_hash, metadata->>'scope' as registered_scope";

const toClient = (r: ClientRow): OAuthClient => ({
  clientId: r.client_id,
  clientName: r.client_name,
  redirectUris: r.redirect_uris,
  grantTypes: r.grant_types,
  tokenEndpointAuthMethod: r.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none",
});

async function loadClient(tx: Tx, clientId: string | undefined): Promise<ClientRow | null> {
  if (!clientId || clientId.length > 200) return null;
  const rows = await tx.query<ClientRow>(`select ${CLIENT_COLS} from fit.oauth_clients where client_id = $1`, [clientId]);
  return rows[0] ?? null;
}

export async function getClient(clientId: string, db?: Db): Promise<OAuthClient | null> {
  const row = await asSystem((tx) => loadClient(tx, clientId), db);
  return row ? toClient(row) : null;
}

/** Un cliente con secreto tiene que presentarlo; uno público se identifica solo con client_id (lo ata PKCE). */
function clientAuthenticates(row: ClientRow, secret: string | undefined): boolean {
  if (row.token_endpoint_auth_method !== "client_secret_post") return true;
  return Boolean(secret && row.client_secret_hash && safeEqual(sha256Hex(secret), row.client_secret_hash));
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** null si el redirect_uri vale; si no, el motivo (se puede devolver tal cual al cliente). */
export function redirectUriProblem(raw: string): string | null {
  if (raw.length > 2000) return "redirect_uri too long";
  if (raw.includes("#")) return "fragment not allowed in redirect_uri";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "redirect_uri must be an absolute URI";
  }
  if (u.username || u.password) return "userinfo not allowed in redirect_uri";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return "redirect_uri must be https, or http on localhost / 127.0.0.1";
}

// Los campos que no usamos se ignoran: no son motivo para rechazar a un cliente.
const RegisterBody = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
  client_name: z.string().max(100).optional(),
  grant_types: z.array(z.string().max(100)).max(10).optional(),
  response_types: z.array(z.string().max(40)).max(5).optional(),
  token_endpoint_auth_method: z.string().max(60).optional(),
  scope: z.string().max(500).optional(),
  client_uri: z.string().max(2000).optional(),
  logo_uri: z.string().max(2000).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(60).optional(),
});

/** Sin caracteres de control ni marcas de dirección: el nombre se enseña en el consentimiento. */
const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim();

export interface ClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  scope: string;
  /** Solo si el cliente pidió `client_secret_post`. Se devuelve esta única vez. */
  client_secret?: string;
  client_secret_expires_at?: number;
}

/**
 * Alta de un cliente. Devuelve el documento de RFC 7591.
 * `grant_types`: hace falta `authorization_code`; lo que no soportamos se descarta y la respuesta dice lo que queda.
 * Tope de 30 altas por hora en total → AppError `limite`.
 */
export async function registerClient(metadata: unknown, db?: Db): Promise<ClientRegistration> {
  const parsed = RegisterBody.safeParse(metadata);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = String(first?.path[0] ?? "body");
    throw new OAuthError(field === "redirect_uris" ? "invalid_redirect_uri" : "invalid_client_metadata", `${field}: ${first?.message ?? "invalid"}`);
  }
  const b = parsed.data;
  for (const uri of b.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError("invalid_redirect_uri", problem);
  }
  const redirectUris = [...new Set(b.redirect_uris)];
  const method = b.token_endpoint_auth_method ?? "none";
  if (!(AUTH_METHODS as readonly string[]).includes(method)) {
    throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(", ")}`);
  }
  if (b.grant_types && !b.grant_types.includes("authorization_code")) {
    throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code");
  }
  if (b.response_types && !b.response_types.includes("code")) {
    throw new OAuthError("invalid_client_metadata", "response_types must include code");
  }
  const grantTypes = b.grant_types ? SUPPORTED_GRANTS.filter((g) => b.grant_types!.includes(g)) : [...SUPPORTED_GRANTS];
  const clientName = cleanName(b.client_name ?? "") || "Agente de IA";
  const asked = (b.scope ?? "").split(/\s+/).filter(isScope);
  const scope = (asked.length ? asked : SCOPE_NAMES).join(" ");

  const now = oauthClock.now();
  const clientId = randomUUID();
  const secret = method === "client_secret_post" ? randomSecret() : null;
  const extra = { client_uri: b.client_uri ?? null, logo_uri: b.logo_uri ?? null, software_id: b.software_id ?? null, software_version: b.software_version ?? null, scope };

  const limited = await asSystem(async (tx) => {
    // Limpieza de paso: lo caducado hace más de un día y los clientes que nunca llegaron a pedir permiso.
    const dayAgo = iso(plus(now, -86_400));
    await tx.query("delete from fit.oauth_codes where expires_at < $1::timestamptz", [dayAgo]);
    await tx.query("delete from fit.oauth_tokens where coalesce(refresh_expires_at, expires_at) < $1::timestamptz", [dayAgo]);
    await tx.query(
      `delete from fit.oauth_clients c where c.created_at < $1::timestamptz
         and not exists (select 1 from fit.oauth_codes k where k.client_id = c.client_id)
         and not exists (select 1 from fit.oauth_tokens t where t.client_id = c.client_id)`,
      [dayAgo],
    );
    const recent = await tx.query<{ n: number }>("select count(*)::int as n from fit.oauth_clients where created_at > $1::timestamptz", [iso(plus(now, -3600))]);
    if (recent[0].n >= MAX_REGISTRATIONS_PER_HOUR) return true;
    await tx.query(
      `insert into fit.oauth_clients (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, client_secret_hash, metadata, created_at)
       values ($1, $2, ${TEXT_ARRAY(3)}, ${TEXT_ARRAY(4)}, $5, $6, $7::jsonb, $8::timestamptz)`,
      [clientId, clientName, JSON.stringify(redirectUris), JSON.stringify(grantTypes), method, secret ? sha256Hex(secret) : null, JSON.stringify(extra), iso(now)],
    );
    return false;
  }, db);
  if (limited) throw new AppError("limite", "Demasiados registros de clientes en la última hora. Prueba más tarde.");

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: method as AuthMethod,
    scope,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  };
}

// ── /oauth/authorize ────────────────────────────────────────────────────────
export const AUTHORIZE_KEYS = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"] as const;
export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_KEYS)[number], string>>;

export type AuthorizeCheck =
  | { ok: true; client: OAuthClient; redirectUri: string; scope: Scope[]; state: string | null; codeChallenge: string; resource: string }
  | {
      ok: false;
      /** false: cliente o redirect_uri sin validar → se enseña en nuestra página y NUNCA se redirige. */
      redirectable: boolean;
      error: OAuthErrorCode;
      description: string;
      /** Solo cuando `redirectable`: a dónde devolver el error. */
      redirectUri?: string;
      state?: string | null;
    };

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function normalizeResource(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Vuelta al agente con los parámetros dados, `state` (si vino) e `iss` (RFC 9207). */
export function authorizeRedirect(redirectUri: string, params: Record<string, string>, state: string | null): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (state !== null) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer());
  return u.toString();
}

/**
 * Orden de RFC 6749 §4.1.2.1: mientras el cliente o el redirect_uri no estén validados, el error
 * no es redirigible (nada de redirecciones abiertas). Después, los errores vuelven al agente.
 */
export async function validateAuthorizeRequest(params: AuthorizeParams, db?: Db): Promise<AuthorizeCheck> {
  const row = await asSystem((tx) => loadClient(tx, params.client_id), db);
  if (!row) return { ok: false, redirectable: false, error: "invalid_client", description: "La aplicación que pide acceso no está registrada." };
  const client = toClient(row);
  const redirectUri = params.redirect_uri;
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, redirectable: false, error: "invalid_request", description: "La dirección de retorno no coincide con ninguna de las que registró esta aplicación." };
  }
  const rawState = params.state ?? null;
  const state = rawState !== null && rawState.length <= 2000 ? rawState : null;
  const fail = (error: OAuthErrorCode, description: string): AuthorizeCheck => ({ ok: false, redirectable: true, error, description, redirectUri, state });

  if (rawState !== null && rawState.length > 2000) return fail("invalid_request", "state too long");
  if (params.response_type !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (!params.code_challenge || !CHALLENGE_RE.test(params.code_challenge)) return fail("invalid_request", "PKCE code_challenge required");
  if (params.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  // Espacios según RFC 6749, pero hay clientes (Meta) que separan con comas o «+», o añaden scopes genéricos
  // (offline_access, openid…). Los desconocidos se ignoran; solo se rechaza si no queda ninguno nuestro.
  const requested = [...new Set((params.scope ?? "").split(/[\s,+]+/).filter(Boolean))];
  // Lo pedido manda (si un cliente pide solo lectura, solo lectura). Si no pide ninguno de los nuestros,
  // vale lo que declaró al registrarse (el cliente de Meta registra «mcp:read mcp:log»); si tampoco, lectura.
  // El dueño ve los scopes en la pantalla de consentimiento antes de aprobar.
  const asked = SCOPE_NAMES.filter((s) => requested.includes(s));
  const registered = (row.registered_scope ?? "").split(/\s+/).filter(Boolean);
  if (requested.length && !asked.length && !registered.some(isScope)) return fail("invalid_scope", `supported scopes: ${SCOPE_NAMES.join(" ")}`);
  const fromRegistration = SCOPE_NAMES.filter((s) => registered.includes(s));
  const scope = asked.length ? asked : fromRegistration.length ? fromRegistration : [DEFAULT_SCOPE];
  // RFC 8707: el token es para un recurso. Sin `resource` se entiende el MCP (clientes antiguos).
  // En este origen solo hay un recurso (el MCP): se acepta cualquier ruta del mismo origen
  // (el cliente de Meta, por ejemplo, manda el origen o «/mcp») y el token queda ligado a /api/mcp.
  const resource = mcpResource();
  if (params.resource !== undefined) {
    const asked = normalizeResource(params.resource);
    if (!asked || new URL(asked).origin !== new URL(resource).origin) return fail("invalid_target", "unknown resource");
  }

  return { ok: true, client, redirectUri, scope, state, codeChallenge: params.code_challenge, resource };
}

export interface CodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: Scope[];
  codeChallenge: string;
  resource?: string | null;
}

/** Código opaco de un solo uso (32 bytes en base64url). En la base queda su SHA-256; caduca a los 5 minutos. */
export async function createAuthorizationCode(input: CodeInput, db?: Db): Promise<string> {
  const code = randomSecret();
  const now = oauthClock.now();
  await asSystem(
    (tx) =>
      tx.query(
        `insert into fit.oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, resource, code_challenge, code_challenge_method, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'S256', $8::timestamptz)`,
        [sha256Hex(code), input.clientId, input.userId, input.redirectUri, input.scope.join(" "), input.resource ?? mcpResource(), input.codeChallenge, iso(plus(now, CODE_TTL_S))],
      ),
    db,
  );
  return code;
}

// ── Consentimiento (CSRF) ───────────────────────────────────────────────────
export interface ConsentInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: Scope[];
  state: string | null;
  codeChallenge: string;
  resource: string;
}

type Global = { __fitConsentSecret?: Buffer };
function consentKey(): Buffer {
  const base = process.env.SESSION_SECRET;
  if (base) return createHmac("sha256", base).update("fit:oauth-consent:v1").digest();
  // Misma condición que isDevAuth() de src/server/auth.ts (aquí no se importa: ese módulo solo se carga bajo demanda).
  const devAuth = process.env.AUTH_MODE === "dev" && !process.env.DATABASE_URL;
  if (process.env.NODE_ENV === "production" && !devAuth) throw new Error("Falta SESSION_SECRET: sin él no se puede firmar el consentimiento de OAuth.");
  // Desarrollo y tests: secreto efímero del proceso (un reinicio invalida las pantallas abiertas).
  const g = globalThis as Global;
  return (g.__fitConsentSecret ??= randomBytes(32));
}
const mac = (body: string) => createHmac("sha256", consentKey()).update(body).digest("base64url");

/** Firma la petición que el dueño está viendo: HMAC-SHA256 y 10 minutos de vida. La acción solo se fía de esto. */
export function signConsent(input: ConsentInput): string {
  const payload = {
    u: input.userId,
    c: input.clientId,
    r: input.redirectUri,
    s: input.scope.join(" "),
    st: input.state,
    cc: input.codeChallenge,
    rs: input.resource,
    exp: Math.floor(oauthClock.now().getTime() / 1000) + CONSENT_TTL_S,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** La petición firmada, o null si la firma no cuadra (tiempo constante), caducó o es de otro usuario. */
export function verifyConsent(token: string, userId: string): ConsentInput | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 16_000) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof p.exp !== "number" || p.exp * 1000 <= oauthClock.now().getTime()) return null;
    if (typeof p.u !== "string" || !safeEqual(p.u, userId)) return null;
    if (typeof p.c !== "string" || typeof p.r !== "string" || typeof p.s !== "string" || typeof p.cc !== "string" || typeof p.rs !== "string") return null;
    const scope = p.s.split(" ").filter(isScope);
    return { userId: p.u, clientId: p.c, redirectUri: p.r, scope, state: typeof p.st === "string" ? p.st : null, codeChallenge: p.cc, resource: p.rs };
  } catch {
    return null;
  }
}

export type ConsentDecision = { ok: true; redirectTo: string } | { ok: false; reason: "caducado" | "invalido"; message: string };

/**
 * La decisión del dueño. No se fía de nada que venga del navegador salvo la petición firmada:
 * la verifica, vuelve a validarla entera contra la base y solo entonces crea el código.
 */
export async function completeAuthorization(input: { userId: string; consent: string; approve: boolean }, db?: Db): Promise<ConsentDecision> {
  const signed = verifyConsent(input.consent, input.userId);
  if (!signed) return { ok: false, reason: "caducado", message: "La pantalla de autorización caducó o no es válida. Vuelve a la aplicación y empieza la conexión otra vez." };
  const check = await validateAuthorizeRequest(
    {
      response_type: "code",
      client_id: signed.clientId,
      redirect_uri: signed.redirectUri,
      scope: signed.scope.join(" "),
      ...(signed.state !== null ? { state: signed.state } : {}),
      code_challenge: signed.codeChallenge,
      code_challenge_method: "S256",
      resource: signed.resource,
    },
    db,
  );
  if (!check.ok) {
    if (check.redirectable && check.redirectUri) {
      return { ok: true, redirectTo: authorizeRedirect(check.redirectUri, { error: check.error, error_description: check.description }, check.state ?? null) };
    }
    return { ok: false, reason: "invalido", message: check.description };
  }
  if (!input.approve) {
    return { ok: true, redirectTo: authorizeRedirect(check.redirectUri, { error: "access_denied", error_description: "the user denied access" }, check.state) };
  }
  const code = await createAuthorizationCode(
    { clientId: check.client.clientId, userId: input.userId, redirectUri: check.redirectUri, scope: check.scope, codeChallenge: check.codeChallenge, resource: check.resource },
    db,
  );
  return { ok: true, redirectTo: authorizeRedirect(check.redirectUri, { code }, check.state) };
}

// ── /oauth/token ────────────────────────────────────────────────────────────
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  /** Falta solo si el cliente se registró sin el grant `refresh_token`. */
  refresh_token?: string;
}
type Failure = { ok: false; code: OAuthErrorCode; description: string; status?: number };
type Outcome = { ok: true; tokens: TokenResponse } | Failure;
// Dentro de la transacción los fallos se DEVUELVEN (no se lanzan): marcar el código como usado
// o revocar una concesión tiene que quedar guardado aunque la petición termine en error.
const failure = (code: OAuthErrorCode, description: string, status = 400): Failure => ({ ok: false, code, description, status });
const BAD_CLIENT = failure("invalid_client", "unknown client or bad client credentials", 401);

function unwrap(out: Outcome): TokenResponse {
  if (!out.ok) throw new OAuthError(out.code, out.description, out.status);
  return out.tokens;
}

async function revokeAll(tx: Tx, clientId: string, userId: string, now: Date): Promise<number> {
  await tx.query("update fit.oauth_codes set used_at = $3::timestamptz where client_id = $1 and user_id = $2 and used_at is null", [clientId, userId, iso(now)]);
  const rows = await tx.query(
    "update fit.oauth_tokens set revoked_at = $3::timestamptz where client_id = $1 and user_id = $2 and revoked_at is null returning id",
    [clientId, userId, iso(now)],
  );
  return rows.length;
}

async function issueTokens(tx: Tx, g: { client: ClientRow; userId: string; scope: string; resource: string | null }, now: Date): Promise<TokenResponse> {
  const access = randomSecret(ACCESS_PREFIX);
  const refresh = g.client.grant_types.includes("refresh_token") ? randomSecret(REFRESH_PREFIX) : null;
  await tx.query(
    `insert into fit.oauth_tokens (client_id, user_id, access_hash, refresh_hash, scope, resource, expires_at, refresh_expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)`,
    [g.client.client_id, g.userId, sha256Hex(access), refresh ? sha256Hex(refresh) : null, g.scope, g.resource, iso(plus(now, ACCESS_TTL_S)), refresh ? iso(plus(now, REFRESH_TTL_S)) : null, iso(now)],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, scope: g.scope, ...(refresh ? { refresh_token: refresh } : {}) };
}

export interface ExchangeInput {
  code: string;
  clientId: string;
  clientSecret?: string;
  /** OAuth 2.1 ya no lo exige en el canje (lo cubre PKCE); si viene, tiene que ser el del código. */
  redirectUri?: string;
  codeVerifier: string;
}

/** Canje del código (un solo uso) por access (1 h) y refresh (60 días). */
export async function exchangeCode(input: ExchangeInput, db?: Db): Promise<TokenResponse> {
  if (!input.code || !input.clientId || !input.codeVerifier) throw new OAuthError("invalid_request", "code, client_id and code_verifier are required");
  if (input.code.length > 512 || !VERIFIER_RE.test(input.codeVerifier)) throw new OAuthError("invalid_grant", "invalid code or code_verifier");
  const now = oauthClock.now();
  const hash = sha256Hex(input.code);
  const out = await asSystem<Outcome>(async (tx) => {
    const client = await loadClient(tx, input.clientId);
    if (!client || !clientAuthenticates(client, input.clientSecret)) return BAD_CLIENT;
    type CodeRow = { client_id: string; user_id: string; redirect_uri: string; scope: string; resource: string | null; code_challenge: string; expires_at: unknown };
    // Atómico: de dos canjes simultáneos solo uno se lleva la fila.
    const claimed = await tx.query<CodeRow>(
      `update fit.oauth_codes set used_at = $2::timestamptz where code_hash = $1 and used_at is null
       returning client_id, user_id, redirect_uri, scope, resource, code_challenge, expires_at`,
      [hash, iso(now)],
    );
    const row = claimed[0];
    if (!row) {
      // ¿Ya usado? Entonces alguien lo ha presentado dos veces: fuera los tokens que salieron de él.
      const prior = await tx.query<{ client_id: string; user_id: string }>("select client_id, user_id from fit.oauth_codes where code_hash = $1", [hash]);
      if (prior[0]) await revokeAll(tx, prior[0].client_id, prior[0].user_id, now);
      return failure("invalid_grant", "invalid, expired or already used code");
    }
    // A partir de aquí el código ya está gastado, falle lo que falle.
    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
    const valid =
      row.client_id === client.client_id &&
      toDate(row.expires_at).getTime() > now.getTime() &&
      (input.redirectUri === undefined || input.redirectUri === row.redirect_uri) &&
      safeEqual(challenge, row.code_challenge);
    if (!valid) return failure("invalid_grant", "invalid, expired or already used code");
    return { ok: true, tokens: await issueTokens(tx, { client, userId: row.user_id, scope: row.scope, resource: row.resource }, now) };
  }, db);
  return unwrap(out);
}

export interface RefreshInput {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  /** Solo puede reducir lo concedido. */
  scope?: string;
}

/** Rotación obligatoria. Un refresh ya rotado o revocado tumba toda la concesión (cliente + usuario). */
export async function refreshTokens(input: RefreshInput, db?: Db): Promise<TokenResponse> {
  if (!input.refreshToken || !input.clientId) throw new OAuthError("invalid_request", "refresh_token and client_id are required");
  const now = oauthClock.now();
  const hash = sha256Hex(input.refreshToken);
  const out = await asSystem<Outcome>(async (tx) => {
    const client = await loadClient(tx, input.clientId);
    if (!client || !clientAuthenticates(client, input.clientSecret)) return BAD_CLIENT;
    const bad = failure("invalid_grant", "invalid, expired or revoked refresh token");
    if (!input.refreshToken.startsWith(REFRESH_PREFIX) || input.refreshToken.length > 512) return bad;
    type Row = { id: string; client_id: string; user_id: string; scope: string; resource: string | null; refresh_expires_at: unknown; revoked_at: unknown };
    const rows = await tx.query<Row>("select id, client_id, user_id, scope, resource, refresh_expires_at, revoked_at from fit.oauth_tokens where refresh_hash = $1", [hash]);
    const row = rows[0];
    if (!row || row.client_id !== client.client_id) return bad;
    if (row.revoked_at !== null) {
      await revokeAll(tx, row.client_id, row.user_id, now);
      return bad;
    }
    if (!row.refresh_expires_at || toDate(row.refresh_expires_at).getTime() <= now.getTime()) return bad;
    const granted = row.scope.split(" ").filter(Boolean);
    let scope = row.scope;
    if (input.scope !== undefined && input.scope.trim() !== "") {
      const asked = [...new Set(input.scope.split(/\s+/).filter(Boolean))];
      if (!asked.every((s) => granted.includes(s))) return failure("invalid_scope", "scope can only be narrowed on refresh");
      scope = granted.filter((s) => asked.includes(s)).join(" ");
    }
    const rotated = await tx.query("update fit.oauth_tokens set revoked_at = $2::timestamptz where id = $1 and revoked_at is null returning id", [row.id, iso(now)]);
    if (!rotated.length) {
      await revokeAll(tx, row.client_id, row.user_id, now);
      return bad;
    }
    return { ok: true, tokens: await issueTokens(tx, { client, userId: row.user_id, scope, resource: row.resource }, now) };
  }, db);
  return unwrap(out);
}

// ── Uso y gestión de tokens ─────────────────────────────────────────────────
export interface AccessInfo {
  userId: string;
  clientId: string;
  scopes: Scope[];
  tokenId: string;
  /** Recurso para el que se emitió (RFC 8707). /api/mcp lo compara con el suyo. */
  resource: string | null;
  expiresAt: Date;
}

/** El token de acceso, si existe, no caducó y no está revocado. Apunta `last_used_at` como mucho una vez por minuto. */
export async function verifyAccessToken(token: string, db?: Db): Promise<AccessInfo | null> {
  if (!token || !token.startsWith(ACCESS_PREFIX) || token.length > 512) return null;
  const now = oauthClock.now();
  return asSystem(async (tx) => {
    type Row = { id: string; client_id: string; user_id: string; scope: string; resource: string | null; expires_at: unknown };
    const rows = await tx.query<Row>(
      "select id, client_id, user_id, scope, resource, expires_at from fit.oauth_tokens where access_hash = $1 and revoked_at is null and expires_at > $2::timestamptz",
      [sha256Hex(token), iso(now)],
    );
    const row = rows[0];
    if (!row) return null;
    await tx.query("update fit.oauth_tokens set last_used_at = $2::timestamptz where id = $1 and (last_used_at is null or last_used_at < $3::timestamptz)", [
      row.id,
      iso(now),
      iso(plus(now, -60)),
    ]);
    return { userId: row.user_id, clientId: row.client_id, scopes: row.scope.split(" ").filter(isScope), tokenId: row.id, resource: row.resource, expiresAt: toDate(row.expires_at) };
  }, db);
}

/** RFC 7009: vale un access o un refresh; cae la pareja entera. true si había algo que revocar. */
export async function revokeToken(token: string, db?: Db): Promise<boolean> {
  if (!token || token.length > 512) return false;
  const hash = sha256Hex(token);
  const rows = await asSystem(
    (tx) =>
      tx.query("update fit.oauth_tokens set revoked_at = $2::timestamptz where (access_hash = $1 or refresh_hash = $1) and revoked_at is null returning id", [
        hash,
        iso(oauthClock.now()),
      ]),
    db,
  );
  return rows.length > 0;
}

export interface Grant {
  clientId: string;
  clientName: string | null;
  scopes: Scope[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Agentes conectados del atleta: una fila por cliente con acceso vivo. */
export async function listGrants(userId: string, db?: Db): Promise<Grant[]> {
  const live = "t.revoked_at is null and coalesce(t.refresh_expires_at, t.expires_at) > $2::timestamptz";
  type Row = { client_id: string; client_name: string | null; scopes: string | null; created_at: unknown; last_used_at: unknown };
  const rows = await asSystem(
    (tx) =>
      tx.query<Row>(
        `select t.client_id, c.client_name, string_agg(t.scope, ' ') filter (where ${live}) as scopes,
                min(t.created_at) as created_at, max(t.last_used_at) as last_used_at
           from fit.oauth_tokens t join fit.oauth_clients c on c.client_id = t.client_id
          where t.user_id = $1
          group by t.client_id, c.client_name
         having count(*) filter (where ${live}) > 0
          order by min(t.created_at)`,
        [userId, iso(oauthClock.now())],
      ),
    db,
  );
  return rows.map((r) => {
    const held = new Set((r.scopes ?? "").split(" "));
    return {
      clientId: r.client_id,
      clientName: r.client_name,
      scopes: SCOPE_NAMES.filter((s) => held.has(s)),
      createdAt: toDate(r.created_at),
      lastUsedAt: r.last_used_at ? toDate(r.last_used_at) : null,
    };
  });
}

/** «Desconectar»: revoca todos los tokens y códigos pendientes de ese cliente para el atleta. Devuelve cuántos tokens cayeron. */
export async function revokeGrant(userId: string, clientId: string, db?: Db): Promise<number> {
  return asSystem((tx) => revokeAll(tx, clientId, userId, oauthClock.now()), db);
}

// ── Metadatos de descubrimiento ─────────────────────────────────────────────
/** RFC 8414. */
export function authorizationServerMetadata() {
  const iss = issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: [...SUPPORTED_GRANTS],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...SCOPE_NAMES],
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...SCOPE_NAMES],
    bearer_methods_supported: ["header"],
    resource_name: "FITOS SYSTEM · entrenamiento y nutrición",
  };
}

/** Cabecera WWW-Authenticate del 401 de /api/mcp. Con `invalid_token` cuando el token vino pero no vale. */
export function bearerChallenge(error?: "invalid_token"): string {
  const meta = `resource_metadata="${resourceMetadataUrl()}"`;
  return error ? `Bearer error="${error}", error_description="The access token is invalid or expired", ${meta}` : `Bearer ${meta}`;
}

// ── HTTP de los endpoints que llaman los agentes ────────────────────────────
// Sin cookies: se autentican con client_id, PKCE y los tokens del cuerpo. CORS abierto y sin credenciales.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
};
const NO_STORE: Record<string, string> = { "Cache-Control": "no-store", Pragma: "no-cache" };

export const oauthJson = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...NO_STORE, ...extra } });

export const corsPreflight = (): Response => new Response(null, { status: 204, headers: CORS_HEADERS });

/** Traduce cualquier error a la respuesta de RFC 6749 §5.2. El detalle de un fallo interno solo va al log, y nunca un token. */
export function oauthErrorResponse(label: string, error: unknown): Response {
  if (error instanceof OAuthError) return oauthJson({ error: error.code, error_description: error.description }, error.status);
  if (error instanceof AppError && error.code === "limite") {
    return oauthJson({ error: "temporarily_unavailable", error_description: "too many requests, try again later" }, 429, { "Retry-After": "3600" });
  }
  console.error(`[oauth] ${label}:`, error instanceof Error ? error.message : "error desconocido");
  return oauthJson({ error: "server_error" }, 500);
}

/** Texto del cuerpo con tope; null si se pasa. */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Formulario urlencoded (RFC 6749) como objeto plano. También se acepta un objeto JSON, porque
 * algunos clientes de conectores lo mandan así. Un campo repetido no es una petición válida.
 */
export async function readForm(request: Request): Promise<Record<string, string> | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const text = await readBodyText(request, 16 * 1024);
  if (text === null) return null;
  const out: Record<string, string> = {};
  if (type === "application/json") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return null;
    }
  }
  if (type !== "application/x-www-form-urlencoded") return null;
  for (const [k, v] of new URLSearchParams(text)) {
    if (k in out) return null;
    out[k] = v;
  }
  return out;
}

/** Credenciales del cliente por HTTP Basic (RFC 6749 §2.3.1), por si un cliente insiste en mandarlas así. */
export function basicClientCredentials(request: Request): { clientId: string; clientSecret?: string } | null {
  const b64 = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!b64) return null;
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  try {
    const clientId = decodeURIComponent(colon < 0 ? decoded : decoded.slice(0, colon));
    const clientSecret = colon < 0 ? undefined : decodeURIComponent(decoded.slice(colon + 1));
    return clientId ? { clientId, clientSecret: clientSecret || undefined } : null;
  } catch {
    return null;
  }
}
