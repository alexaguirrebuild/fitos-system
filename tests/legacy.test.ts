import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { importLegacy, matchExercise, normalizeText, type LegacyEntreno } from "@/server/legacy-import";
import { seedCatalog } from "@/server/seed";

// El export real vive fuera del repo (datos personales). Si no está, las pruebas con datos reales se saltan.
const DIR = process.env.LEGACY_EXPORT_DIR ?? path.join(process.cwd(), "..", "VIDA", "_datos", "supabase-2026-11-15");
const real = existsSync(path.join(DIR, "entrenos.json"));

let db: Db;
let user: string;

beforeAll(async () => {
  db = await openMemoryDb();
  await seedCatalog(db);
  [{ id: user }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('legacy@test.local') returning id"), db);
});
afterAll(async () => db.close());

describe("semillas", () => {
  it("carga el catálogo y es idempotente", async () => {
    const again = await seedCatalog(db);
    expect(again.muscles).toBe(17);
    expect(again.exercises).toBeGreaterThan(120);
    expect(again.glossary).toBeGreaterThan(50);
    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from fit.exercises where user_id is null");
    expect(n).toBe(again.exercises);
    // Los alimentos sin código de barras (fruta y verdura a granel) tampoco se duplican.
    const [{ f }] = await db.query<{ f: number }>("select count(*)::int as f from fit.foods where user_id is null");
    expect(f).toBe(again.foods);
  });
});

describe("enlace de nombres en texto libre", () => {
  const cat = [
    { id: "katana", phrases: ["extension de triceps katana en polea", "katana"] },
    { id: "cuerda", phrases: ["triceps en polea con cuerda", "triceps polea alta"] },
    { id: "squat", phrases: ["sentadilla high bar", "sq hb"] },
  ];
  it("gana la frase conocida más larga y no adivina", () => {
    expect(normalizeText("Sq HB — sacas muy bien")).toBe("sq hb sacas muy bien");
    expect(matchExercise("Sq hb sacas muy bien y primeras reps volando", cat)).toBe("squat");
    expect(matchExercise("Miércoles poco tiempo fast triceps polea alta y katana", cat)).toBe("cuerda");
    expect(matchExercise("Duermes 4h otra vez xd", cat)).toBeNull();
  });
});

describe("importación del histórico", () => {
  const sample: LegacyEntreno[] = [
    { fecha: "2026-07-01", dia: "Pierna B", data: { sub: "Fuerza", srpe: 8, dur: 90, tonelaje: 5000, efectivas: 6,
      ejercicios: [
        { n: "Sq hb top set", grupo: "Cuádriceps", sch: "4 × 4-6", rir: 3, nota: "Rodilleras", sets: [{ kg: 150, reps: 5, rir: 2 }, { kg: "130", reps: "9", rir: 4 }] },
        { n: "cosa rara sin nombre", sets: [{ kg: 20, reps: 12, rir: 1 }, { kg: 20, reps: null, rir: 1 }] },
        { n: "vacío", sets: [] },
      ] } },
  ];
  it("conserva fecha, series, texto original y fila íntegra", async () => {
    const r = await importLegacy(user, { entrenos: sample }, db);
    expect(r).toMatchObject({ workouts: 1, sets: 3, exercises: 2, linked: 1, unlinked: 1, skippedSets: 1 });
    const w = await withUser(user, (tx) => tx.query<{ date: string; load: number; legacy: { fecha: string } }>("select date, load, legacy from fit.workouts"), db);
    expect(w[0]).toMatchObject({ date: "2026-07-01", load: 720 });
    expect(w[0].legacy.fecha).toBe("2026-07-01");
    const s = await withUser(user, (tx) => tx.query<{ exercise_name_raw: string; e1rm: number; e1rm_confidence: string; linked: boolean }>(
      "select exercise_name_raw, e1rm, e1rm_confidence, exercise_id is not null as linked from fit.workout_sets order by exercise_position, set_index"), db);
    expect(s[0]).toMatchObject({ exercise_name_raw: "Sq hb top set", linked: true, e1rm_confidence: "alta" });
    expect(s[0].e1rm).toBeCloseTo(150 * (1 + 7 / 30), 1);
    expect(s[2]).toMatchObject({ exercise_name_raw: "cosa rara sin nombre", linked: false });
  });
  it("repetir la importación no duplica", async () => {
    await importLegacy(user, { entrenos: sample }, db);
    const [c] = await withUser(user, (tx) => tx.query<{ w: number; s: number }>(
      "select (select count(*)::int from fit.workouts) as w, (select count(*)::int from fit.workout_sets) as s"), db);
    expect(c).toEqual({ w: 1, s: 3 });
  });

  it.skipIf(!real)("export real del 15-nov-2026: 102 sesiones y todas sus series", async () => {
    const entrenos = JSON.parse(readFileSync(path.join(DIR, "entrenos.json"), "utf8")) as LegacyEntreno[];
    const estadoRaw = JSON.parse(readFileSync(path.join(DIR, "estado.json"), "utf8"));
    const estado = Array.isArray(estadoRaw) ? estadoRaw[0] : estadoRaw;
    const expectedSets = entrenos.reduce((a, r) => a + (r.data.ejercicios ?? []).reduce((b, e) => b + (e.sets ?? []).length, 0), 0);
    const [{ id }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('real@test.local') returning id"), db);
    const r1 = await importLegacy(id, { entrenos, estado }, db);
    const r2 = await importLegacy(id, { entrenos, estado }, db);
    expect(r1.workouts).toBe(entrenos.length);
    expect(r1.sets + r1.skippedSets).toBe(expectedSets);
    expect(r2.sets).toBe(r1.sets);
    const [c] = await withUser(id, (tx) => tx.query<{ w: number; s: number; first: string; last: string; ck: number }>(
      `select (select count(*)::int from fit.workouts) as w, (select count(*)::int from fit.workout_sets) as s,
              (select min(date)::text from fit.workouts) as first, (select max(date)::text from fit.workouts) as last,
              (select count(*)::int from fit.checkins) as ck`), db);
    expect(c.w).toBe(entrenos.length);
    expect(c.s).toBe(r1.sets);
    expect(c.ck).toBeGreaterThan(0);
    console.log(`[legacy real] sesiones=${c.w} series=${c.s} descartadas=${r1.skippedSets} de ${c.first} a ${c.last} · ejercicios enlazados ${r1.linked}/${r1.exercises} · check-ins ${c.ck}`);
  });
});
