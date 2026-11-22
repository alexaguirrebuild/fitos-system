/**
 * Una sola interfaz de base de datos con dos motores:
 *  - producción: Postgres de Supabase por DATABASE_URL (pg)
 *  - local y tests: PGlite (Postgres real en WASM, sin Docker), en .data/pglite o en memoria
 * Todo acceso a datos del atleta pasa por withUser(), que activa RLS con su id.
 */
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;
export interface Tx {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Tx {
  driver: "pg" | "pglite";
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const DEV_STUB = path.join(process.cwd(), "supabase", "dev", "000_local_stub.sql");

type SslOptions = { rejectUnauthorized: boolean; ca?: string } | undefined;
let insecureWarned = false;

/**
 * TLS hacia Postgres. Local: sin TLS. Remoto: verificación activada.
 *  - DATABASE_CA_CERT: certificado raíz en PEM (admite saltos de línea escapados); se usa como `ca`.
 *  - DATABASE_SSL_INSECURE=1: desactiva la verificación (solo para salir del paso; avisa una vez).
 */
export function sslOptions(url: string, env: Record<string, string | undefined> = process.env): SslOptions {
  if (/localhost|127\.0\.0\.1/.test(url)) return undefined;
  if (env.DATABASE_SSL_INSECURE === "1") {
    if (!insecureWarned) {
      insecureWarned = true;
      console.warn("[db] DATABASE_SSL_INSECURE=1: la conexión a Postgres NO verifica el certificado del servidor.");
    }
    return { rejectUnauthorized: false };
  }
  const ca = env.DATABASE_CA_CERT?.trim();
  return ca ? { rejectUnauthorized: true, ca: ca.replace(/\\n/g, "\n") } : { rejectUnauthorized: true };
}

async function openPg(url: string): Promise<Db> {
  const pg = await import("pg");
  // date → 'AAAA-MM-DD' (sin zonas horarias de por medio); numeric e int8 → número.
  pg.types.setTypeParser(1082, (v: string) => v);
  pg.types.setTypeParser(1700, (v: string) => parseFloat(v));
  pg.types.setTypeParser(20, (v: string) => parseInt(v, 10));
  const pool = new pg.Pool({ connectionString: url, max: 5, ssl: sslOptions(url) });
  return {
    driver: "pg",
    query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
    exec: async (sql) => void (await pool.query(sql)),
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const out = await fn({ query: async (sql, params) => (await c.query(sql, params as unknown[])).rows });
        await c.query("commit");
        return out;
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const parsers = {
    [types.DATE]: (v: string) => v,
    [types.NUMERIC]: (v: string) => parseFloat(v),
    [types.INT8]: (v: string) => parseInt(v, 10),
  };
  const lite = dataDir ? new PGlite(dataDir, { parsers }) : new PGlite({ parsers });
  await lite.waitReady;
  return {
    driver: "pglite",
    query: async (sql, params) => (await lite.query(sql, params as unknown[])).rows as never[],
    exec: async (sql) => void (await lite.exec(sql)),
    tx: (fn) =>
      lite.transaction(async (t) => fn({ query: async (sql, params) => (await t.query(sql, params as unknown[])).rows as never[] })) as Promise<never>,
    close: () => lite.close(),
  };
}

/** Aplica las migraciones pendientes en orden. En PGlite crea antes los roles y auth.uid() que Supabase ya trae. */
export async function migrate(db: Db): Promise<string[]> {
  if (db.driver === "pglite") await db.exec(readFileSync(DEV_STUB, "utf8"));
  await db.exec("create table if not exists public.fit_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from public.fit_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await db.exec(`begin;\n${readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")}\ninsert into public.fit_migrations (name) values ('${f}');\ncommit;`);
    applied.push(f);
  }
  return applied;
}

/** Migraciones del repo que `migrate` aplicaría en esta base. Solo lee (transacción `read only`). */
export async function pendingMigrations(db: Db): Promise<string[]> {
  const done = await db.tx(async (tx) => {
    await tx.query("set transaction read only");
    const [{ t }] = await tx.query<{ t: string | null }>("select to_regclass('public.fit_migrations')::text as t");
    return new Set(t ? (await tx.query<{ name: string }>("select name from public.fit_migrations")).map((r) => r.name) : []);
  });
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();
}

type Global = { __fitDb?: Promise<Db> };
const g = globalThis as Global;

/** Conexión única por proceso (sobrevive al recargado en caliente de Next). */
export function getDb(): Promise<Db> {
  if (!g.__fitDb) {
    g.__fitDb = (async () => {
      const url = process.env.DATABASE_URL;
      if (url) return openPg(url);
      const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
      const db = await openPglite(dir === "memory" ? undefined : dir);
      await migrate(db); // en local, la base se crea sola al arrancar
      return db;
    })();
  }
  return g.__fitDb;
}

export async function openMemoryDb(): Promise<Db> {
  const db = await openPglite(undefined);
  await migrate(db);
  return db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ejecuta `fn` como el atleta `userId`: rol `authenticated` + auth.uid() = userId. RLS decide qué ve. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>, db?: Db): Promise<T> {
  if (!UUID.test(userId)) throw new Error("userId no es un uuid");
  const d = db ?? (await getDb());
  return d.tx(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await tx.query("set local role authenticated");
    return fn(tx);
  });
}

/** Camino del sistema (rol propietario): alta del atleta, OAuth, tokens de ingesta. Nunca para datos del atleta. */
export async function asSystem<T>(fn: (tx: Tx) => Promise<T>, db?: Db): Promise<T> {
  const d = db ?? (await getDb());
  return d.tx(fn);
}
