// Presupuesto de consultas del botón «Empezar». Cada consulta es una ida y vuelta a la base: si este
// número sube, la acción vuelve a ser lenta (el 22-nov eran 23 por calcular una vista que se tiraba).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, type Db, type Tx } from "@/db/client";
import { activateProgram, getActivePlan } from "@/server/services/plan";
import { getWorkoutView, openWorkout, startWorkout } from "@/server/services/training";

let raw: Db;
let db: Db;
let a: string;
let dir: string;
let n = 0;

/** Envuelve la base y cuenta idas y vueltas; abrir y cerrar la transacción cuentan como dos. */
function counting(base: Db): Db {
  const wrap = (t: Tx): Tx => ({ query: (sql, p) => { n++; return t.query(sql, p); } });
  return { ...base, query: wrap(base).query, tx: (fn) => { n += 2; return base.tx((t) => fn(wrap(t))); } };
}
async function measure<T>(f: () => Promise<T>): Promise<{ out: T; n: number }> {
  n = 0;
  const out = await f();
  return { out, n };
}

const rx = (exercise: string) => ({ exercise, sets: 3, rep_min: 8, rep_max: 10, rir_target: 2, rest_seconds: 120, warmup_kind: "completo" });
const program = {
  slug: "test-presupuesto", name: "Presupuesto", goal: "definicion",
  mesocycles: [{ name: "Bloque", microcycle_days: 7, microcycles_planned: 2, sessions: [
    { name: "Torso", exercises: [rx("press-banca"), rx("curl-biceps"), rx("press-banca")] }, // repetido: una fila por ejercicio
    { name: "Descanso", is_rest: true },
  ] }],
};

beforeAll(async () => {
  raw = await openMemoryDb();
  db = counting(raw);
  await asSystem(async (tx) => {
    await tx.query("insert into fit.muscle_groups (id, name, region, default_mev, default_mrv) values ('pectoral', 'Pectoral', 'torso', 8, 20), ('biceps', 'Bíceps', 'brazo', 8, 20)");
    await tx.query(`insert into fit.exercises (slug, name, primary_muscle, kind, equipment, warmup_kind) values
      ('press-banca', 'Press banca', 'pectoral', 'compuesto', 'barra', 'completo'),
      ('curl-biceps', 'Curl de bíceps', 'biceps', 'aislamiento', 'mancuernas', 'reducido')`);
  }, raw);
  [{ id: a }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('presupuesto@test.local') returning id"), raw);
  dir = mkdtempSync(path.join(tmpdir(), "fit-presupuesto-"));
  writeFileSync(path.join(dir, "test-presupuesto.json"), JSON.stringify(program));
  await activateProgram(a, { slug: "test-presupuesto", startDate: "2026-11-02" }, raw, { dir });
});
afterAll(async () => {
  await raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("«Empezar» en /entreno", () => {
  let torso: string;

  it("abrir la sesión del plan cuesta 10 consultas y no calcula la vista", async () => {
    torso = (await getActivePlan(a, "2026-11-02", raw))!.sessions[0].id;
    // Sin fecha, como la acción: la zona horaria del atleta es una consulta más.
    const { out, n: q } = await measure(() => openWorkout(a, { sessionTemplateId: torso }, db));
    expect(q).toBe(10);
    const v = await getWorkoutView(a, out.workoutId, raw);
    expect(v.workout).toMatchObject({ status: "en_curso", name: "Torso", sessionTemplateId: torso });
    expect(v.exercises.map((x) => [x.exercise.slug, x.origin])).toEqual([["press-banca", "plan"], ["curl-biceps", "plan"]]);
  });

  it("volver a pulsar devuelve la misma sesión en 6 consultas", async () => {
    const first = await openWorkout(a, { sessionTemplateId: torso }, raw);
    const { out, n: q } = await measure(() => openWorkout(a, { sessionTemplateId: torso }, db));
    expect(out.workoutId).toBe(first.workoutId);
    expect(q).toBe(6);
  });

  it("una sesión libre cuesta 7 consultas", async () => {
    const { n: q } = await measure(() => openWorkout(a, { name: "Libre" }, db));
    expect(q).toBe(7);
  });

  it("guarda la disposición del día y el microciclo que toca, igual que startWorkout", async () => {
    await asSystem((tx) => tx.query("insert into fit.checkins (user_id, date, readiness) values ($1, '2026-11-10', 72)", [a]), raw);
    const { workoutId } = await openWorkout(a, { sessionTemplateId: torso, date: "2026-11-10" }, raw);
    const v = await startWorkout(a, { sessionTemplateId: torso, date: "2026-11-10" }, raw);
    expect(v.workout.id).toBe(workoutId);
    expect(v.workout.readinessBefore).toBe(72);
    const plan = (await getActivePlan(a, "2026-11-10", raw))!;
    expect(v.workout.microcycleId).toBe(plan.microcycle.id);
    expect(plan.microcycle.position).toBe(2);
  });
});
