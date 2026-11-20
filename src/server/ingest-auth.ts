/**
 * Tokens de ingesta (reloj, atajo del móvil). El token en claro se enseña UNA vez al crearlo;
 * en la base solo vive su SHA-256. La tabla no es visible para el rol del atleta: todo va por asSystem.
 */
import { createHash, randomBytes } from "node:crypto";
import { asSystem, type Db } from "@/db/client";
import { invalid } from "@/server/errors";

export const INGEST_TOKEN_PREFIX = "fit_ing_";
const TOKEN_RE = /^fit_ing_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: Date | string | null) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export type IngestTokenInfo = { id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type TokenRow = { id: string; name: string; scopes: string[]; created_at: Date | string; last_used_at: Date | string | null; revoked_at: Date | string | null };
const toInfo = (r: TokenRow): IngestTokenInfo => ({ id: r.id, name: r.name, scopes: r.scopes, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at) });

/** Crea un token y lo devuelve en claro. No se puede volver a leer: si se pierde, se revoca y se crea otro. */
export async function createIngestToken(userId: string, name: string, db?: Db): Promise<IngestTokenInfo & { token: string }> {
  if (!UUID_RE.test(userId)) throw invalid("userId no es un uuid.");
  const label = String(name ?? "").trim().slice(0, 80);
  if (!label) throw invalid("El token necesita un nombre («Reloj», «Atajo del móvil»).");
  const token = INGEST_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const rows = await asSystem(
    (tx) => tx.query<TokenRow>(
      "insert into fit.ingest_tokens (user_id, name, token_hash) values ($1::uuid, $2, $3) returning id, name, scopes, created_at, last_used_at, revoked_at",
      [userId, label, sha256(token)],
    ), db);
  return { ...toInfo(rows[0]), token };
}

/** Resuelve un token en claro a su atleta. null si no existe o está revocado. Apunta el último uso. */
export async function resolveIngestToken(token: string, db?: Db): Promise<{ userId: string; tokenId: string } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const rows = await asSystem(
    (tx) => tx.query<{ id: string; user_id: string }>(
      "update fit.ingest_tokens set last_used_at = now() where token_hash = $1 and revoked_at is null returning id, user_id",
      [sha256(token)],
    ), db);
  return rows[0] ? { userId: rows[0].user_id, tokenId: rows[0].id } : null;
}

export async function listIngestTokens(userId: string, db?: Db): Promise<IngestTokenInfo[]> {
  if (!UUID_RE.test(userId)) throw invalid("userId no es un uuid.");
  const rows = await asSystem(
    (tx) => tx.query<TokenRow>(
      "select id, name, scopes, created_at, last_used_at, revoked_at from fit.ingest_tokens where user_id = $1::uuid order by created_at desc",
      [userId],
    ), db);
  return rows.map(toInfo);
}

/** Revoca un token del atleta. Devuelve false si no existe, no es suyo o ya estaba revocado. */
export async function revokeIngestToken(userId: string, tokenId: string, db?: Db): Promise<boolean> {
  if (!UUID_RE.test(userId) || !UUID_RE.test(tokenId)) return false;
  const rows = await asSystem(
    (tx) => tx.query("update fit.ingest_tokens set revoked_at = now() where id = $1::uuid and user_id = $2::uuid and revoked_at is null returning id", [tokenId, userId]),
    db);
  return rows.length > 0;
}
