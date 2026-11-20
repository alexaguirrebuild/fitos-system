import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";

let db: Db;
let a: string;
let b: string;

beforeAll(async () => {
  db = await openMemoryDb();
  const rows = await asSystem(
    (tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('a@test.local'), ('b@test.local') returning id"),
    db,
  );
  [a, b] = rows.map((r) => r.id);
});
afterAll(async () => db.close());

describe("migraciones y RLS (Postgres real en PGlite)", () => {
  it("aplica las migraciones y crea el esquema", async () => {
    const t = await db.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = 'fit'");
    expect(t[0].n).toBeGreaterThanOrEqual(35);
    const m = await db.query("select name from public.fit_migrations order by name");
    expect(m.length).toBeGreaterThanOrEqual(3);
  });

  it("todas las tablas de fit tienen RLS activado", async () => {
    const off = await db.query<{ relname: string }>(
      "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'fit' and c.relkind = 'r' and not c.relrowsecurity",
    );
    expect(off.map((r) => r.relname)).toEqual([]);
  });

  it("cada atleta solo ve sus filas", async () => {
    await withUser(a, (tx) => tx.query("insert into fit.workouts (date, srpe, duration_min) values ('2026-11-20', 7, 85)"), db);
    const mine = await withUser(a, (tx) => tx.query<{ load: number; date: string }>("select load, date from fit.workouts"), db);
    expect(mine).toEqual([{ load: 595, date: "2026-11-20" }]);
    const theirs = await withUser(b, (tx) => tx.query("select * from fit.workouts"), db);
    expect(theirs).toEqual([]);
  });

  it("no se puede escribir a nombre de otro ni tocar la ficha ajena", async () => {
    await expect(
      withUser(b, (tx) => tx.query("insert into fit.workouts (user_id, date) values ($1, '2026-11-20')", [a]), db),
    ).rejects.toThrow(/row-level security/i);
    const upd = await withUser(b, (tx) => tx.query("update fit.athletes set name = 'x' where id = $1 returning id", [a]), db);
    expect(upd).toEqual([]);
    const seen = await withUser(b, (tx) => tx.query<{ email: string }>("select email from fit.athletes"), db);
    expect(seen.map((r) => r.email)).toEqual(["b@test.local"]);
  });

  it("las tablas de acceso son invisibles para el rol del atleta", async () => {
    await expect(withUser(a, (tx) => tx.query("select * from fit.oauth_tokens"), db)).rejects.toThrow(/permission denied/i);
    await expect(withUser(a, (tx) => tx.query("select * from fit.ingest_tokens"), db)).rejects.toThrow(/permission denied/i);
  });

  it("el catálogo común se lee pero no se modifica", async () => {
    await asSystem(async (tx) => {
      await tx.query("insert into fit.muscle_groups (id, name, region, default_mev, default_mrv) values ('biceps', 'Bíceps', 'brazo', 12, 24)");
      await tx.query("insert into fit.exercises (slug, name, primary_muscle) values ('curl-bayesian', 'Curl bayesian', 'biceps')");
    }, db);
    const seen = await withUser(a, (tx) => tx.query<{ slug: string }>("select slug from fit.exercises"), db);
    expect(seen).toEqual([{ slug: "curl-bayesian" }]);
    const upd = await withUser(a, (tx) => tx.query("update fit.exercises set name = 'x' returning id"), db);
    expect(upd).toEqual([]);
    await withUser(a, (tx) => tx.query("insert into fit.exercises (user_id, slug, name) values ($1, 'mio', 'Mío')", [a]), db);
    const own = await withUser(b, (tx) => tx.query("select slug from fit.exercises where slug = 'mio'"), db);
    expect(own).toEqual([]);
  });

  it("los tipos llegan limpios: fecha como texto y numeric como número", async () => {
    await withUser(a, (tx) => tx.query("insert into fit.body_metrics (date, weight_kg, waist_cm) values ('2026-11-20', 92.4, 100)"), db);
    const r = await withUser(a, (tx) => tx.query("select date, weight_kg, waist_cm from fit.body_metrics"), db);
    expect(r).toEqual([{ date: "2026-11-20", weight_kg: 92.4, waist_cm: 100 }]);
  });

  it("una transacción fallida no deja el rol cambiado", async () => {
    await expect(withUser(a, (tx) => tx.query("select * from fit.no_existe"), db)).rejects.toThrow();
    const who = await db.query<{ current_user: string }>("select current_user");
    expect(who[0].current_user).not.toBe("authenticated");
  });
});
