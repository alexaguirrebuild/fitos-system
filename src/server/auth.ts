/**
 * Sesión del dueño. Un solo usuario, sin Supabase Auth:
 *  - contraseña con scrypt (node:crypto), el hash vive en OWNER_PASSWORD_HASH
 *  - sesión en una cookie httpOnly con un JWT HS256 (jose) firmado con SESSION_SECRET
 *  - 5 intentos fallidos por IP + email en 15 minutos (fit.login_attempts)
 * Modo dev (AUTH_MODE=dev y sin DATABASE_URL): atleta local `dev@local`, sin contraseña.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { asSystem, type Db } from "@/db/client";
import { AppError } from "@/server/errors";

export const SESSION_COOKIE = "fit_session";
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const WINDOW_MINUTES = 15;
const DEV_EMAIL = "dev@local";
const BAD_LOGIN = "Email o contraseña incorrectos.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ───────────────────────── Contraseña ───────────────────────── */

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

function derive(password: string, salt: Buffer, keylen: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, keylen, o, (err, key) => (err ? reject(err) : resolve(key))));
}
// Node limita scrypt a 32 MB por defecto; N=32768 y r=8 necesitan justo eso, así que se da margen.
const scryptOptions = (N: number, r: number, p: number): ScryptOptions => ({ N, r, p, maxmem: 256 * N * r });

/** Hash con formato `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new AppError("entrada_invalida", "La contraseña necesita al menos 8 caracteres.");
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.keylen, scryptOptions(SCRYPT.N, SCRYPT.r, SCRYPT.p));
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Comparación en tiempo constante. Un hash mal formado devuelve false, nunca lanza. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = hash.split("$");
  const [N, R, P] = [Number(n), Number(r), Number(p)];
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0 || !Number.isInteger(R) || R < 1 || R > 32 || !Number.isInteger(P) || P < 1 || P > 16)
    return false;
  const expected = Buffer.from(keyB64, "base64");
  if (expected.length < 16) return false;
  try {
    const key = await derive(password, Buffer.from(saltB64, "base64"), expected.length, scryptOptions(N, R, P));
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ───────────────────────── Modo dev ───────────────────────── */

/** Solo con AUTH_MODE=dev y sin DATABASE_URL: nunca contra la base de producción. */
export const isDevAuth = () => process.env.AUTH_MODE === "dev" && !process.env.DATABASE_URL;

async function ensureAthlete(email: string, db?: Db): Promise<string> {
  const rows = await asSystem((tx) => tx.query<{ id: string }>(
    "insert into fit.athletes (email) values ($1) on conflict (email) do update set email = excluded.email returning id", [email]), db);
  return rows[0].id;
}

export async function ensureDevUser(db?: Db): Promise<string> {
  if (!isDevAuth()) throw new AppError("no_autorizado", "El modo dev no está activo.");
  return ensureAthlete(DEV_EMAIL, db);
}

/* ───────────────────────── Token de sesión ───────────────────────── */

function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET ?? "";
  if (secret.length >= 32) return new TextEncoder().encode(secret);
  if (isDevAuth()) return new TextEncoder().encode("solo-desarrollo-local-sin-secreto-real-0000");
  throw new AppError("externo", "Falta SESSION_SECRET o tiene menos de 32 caracteres. Genera uno con: openssl rand -base64 48");
}

export async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(sessionKey());
}

/** userId si el token es válido y no ha caducado; si no, null. */
export async function verifySessionToken(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" && UUID.test(payload.sub) ? payload.sub : null;
  } catch (e) {
    if (e instanceof AppError) throw e; // falta el secreto: es un fallo de configuración, no un token malo
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

/* ───────────────────────── Login ───────────────────────── */

const attemptKey = (ip: string, email: string) => createHash("sha256").update(`${ip}|${email}`).digest("hex");

function sameText(a: string, b: string): boolean {
  const [x, y] = [createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()];
  return timingSafeEqual(x, y);
}

export type LoginResult = { userId: string; token: string };

/**
 * Comprueba email y contraseña contra OWNER_EMAIL / OWNER_PASSWORD_HASH.
 * El mensaje de error es el mismo si falla el email o la contraseña.
 */
export async function login(email: string, password: string, ip: string, db?: Db): Promise<LoginResult> {
  const mail = String(email ?? "").trim().toLowerCase();
  const ownerEmail = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
  const ownerHash = process.env.OWNER_PASSWORD_HASH ?? "";

  if (isDevAuth() && !ownerHash) {
    const userId = await ensureDevUser(db);
    return { userId, token: await signSessionToken(userId) };
  }
  if (!ownerEmail || !ownerHash) throw new AppError("externo", "Faltan OWNER_EMAIL y OWNER_PASSWORD_HASH en la configuración.");
  sessionKey(); // falla pronto y claro si el secreto no está

  const key = attemptKey(ip || "desconocida", mail);
  const [{ fails }] = await asSystem((tx) => tx.query<{ fails: number }>(
    `select count(*)::int as fails from fit.login_attempts
     where key = $1 and not ok and created_at > now() - interval '${WINDOW_MINUTES} minutes'
       and created_at > coalesce((select max(created_at) from fit.login_attempts where key = $1 and ok), '-infinity'::timestamptz)`, [key]), db);
  if (fails >= MAX_FAILS) throw new AppError("limite", `Demasiados intentos. Espera ${WINDOW_MINUTES} minutos.`);

  // Se verifica siempre la contraseña, acierte o no el email, para no delatar cuál falla por el tiempo.
  const passOk = await verifyPassword(String(password ?? ""), ownerHash);
  const ok = sameText(mail, ownerEmail) && passOk;
  await asSystem(async (tx) => {
    await tx.query("insert into fit.login_attempts (key, ok) values ($1, $2)", [key, ok]);
    if (ok) await tx.query("delete from fit.login_attempts where created_at < now() - interval '7 days'");
  }, db);
  if (!ok) throw new AppError("no_autorizado", BAD_LOGIN);

  const userId = await ensureAthlete(ownerEmail, db);
  return { userId, token: await signSessionToken(userId) };
}

/* ───────────────────────── Servidor de Next ───────────────────────── */

/** Atleta de la petición en curso (Server Components, Server Functions y Route Handlers). Null sin sesión válida. */
export async function getSessionUserId(): Promise<string | null> {
  if (isDevAuth()) return ensureDevUser();
  // Import dinámico: `next/headers` solo existe dentro de una petición de Next, y así el módulo se puede probar fuera.
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) throw new AppError("no_autorizado", "Inicia sesión.");
  return userId;
}
