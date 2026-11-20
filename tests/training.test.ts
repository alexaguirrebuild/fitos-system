import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { AppError } from "@/server/errors";
import { getAnkleStatus, logInjuryPain } from "@/server/services/athlete";
import { addAlias, findAlternatives, resolveExercise, searchExercises } from "@/server/services/library";
import { activateProgram, advanceMicrocycle, getActivePlan, getNextSession, listProgramTemplates, setDeload } from "@/server/services/plan";
import {
  addExerciseToWorkout, deleteSet, finishWorkout, getExerciseHistory, getWorkoutView, logSet, logSoreness, startWorkout, swapExercise, updateSet,
  type LogSetResult, type WorkoutView,
} from "@/server/services/training";

let db: Db;
let a: string; // historia principal
let b: string; // microciclo de 14 días, estancamiento y series basura
let dir: string;

const rx = (exercise: string, sets: number, rep_min: number, rep_max: number, rir_target = 2) =>
  ({ exercise, sets, rep_min, rep_max, rir_target, rest_seconds: 120, warmup_kind: "completo" });

const wheel = {
  slug: "test-rueda", name: "Rueda de prueba", goal: "definicion", source: "test",
  mesocycles: [{
    name: "Bloque 1", block_type: "hipertrofia", focus: "intensidad", microcycle_days: 7, microcycles_planned: 2,
    sessions: [
      { name: "Torso A", exercises: [rx("press-banca", 4, 4, 6), rx("curl-biceps", 3, 10, 12, 1)] },
      { name: "Pierna A", exercises: [rx("sentadilla", 3, 5, 8), rx("prensa", 3, 8, 12)] },
      { name: "Descanso", is_rest: true },
      { name: "Torso B", exercises: [rx("press-banca-inclinado", 3, 8, 10), rx("extension-triceps", 3, 10, 12, 1)] },
    ],
  }],
};
const long = {
  slug: "test-14d", name: "Microciclo de 14 días", goal: "volumen",
  mesocycles: [{ name: "Bloque largo", microcycle_days: 14, microcycles_planned: 2, sessions: [{ name: "Única", exercises: [rx("curl-biceps", 3, 8, 12)] }] }],
};

async function seedLibrary(db: Db) {
  await asSystem(async (tx) => {
    await tx.query(`insert into fit.muscle_groups (id, name, region, default_mev, default_mrv) values
      ('pectoral', 'Pectoral', 'torso', 8, 20), ('triceps', 'Tríceps', 'brazo', 6, 18), ('biceps', 'Bíceps', 'brazo', 8, 20),
      ('cuadriceps', 'Cuádriceps', 'pierna', 8, 18)`);
    await tx.query(`insert into fit.exercises
      (slug, name, aliases, primary_muscle, secondary_muscles, kind, movement_pattern, equipment, stability, base_cost, load_step, warmup_kind, ankle_load) values
      ('press-banca', 'Press banca', '{bench}', 'pectoral', '{triceps}', 'compuesto', 'empuje_h', 'barra', 'bilateral_libre', 1.2, 2.5, 'completo', 'ninguna'),
      ('press-banca-inclinado', 'Press banca inclinado', '{}', 'pectoral', '{triceps}', 'compuesto', 'empuje_h', 'barra', 'bilateral_libre', 1.0, 2.5, 'reducido', 'ninguna'),
      ('sentadilla', 'Sentadilla', '{squat}', 'cuadriceps', '{}', 'compuesto', 'dominante_rodilla', 'barra', 'bilateral_libre', 1.5, 2.5, 'completo', 'alta'),
      ('prensa', 'Prensa', '{}', 'cuadriceps', '{}', 'compuesto', 'dominante_rodilla', 'maquina', 'bilateral_guiado', 1.0, 5, 'reducido', 'baja'),
      ('curl-biceps', 'Curl de bíceps', '{}', 'biceps', '{}', 'aislamiento', 'flexion_codo', 'mancuernas', 'bilateral_libre', 1.0, 1, 'reducido', 'ninguna'),
      ('extension-triceps', 'Extensión de tríceps', '{}', 'triceps', '{}', 'aislamiento', 'extension_codo', 'polea', 'bilateral_guiado', 1.0, 2.5, 'reducido', 'ninguna')`);
  }, db);
}

const ok = (r: LogSetResult) => {
  if (!r.ok) throw new Error("logSet devolvió problemas: " + JSON.stringify(r.problems));
  return r;
};
const block = (v: WorkoutView, slug: string) => v.exercises.find((x) => x.exercise.slug === slug)!;
const count = async (user: string, table: string) =>
  (await withUser(user, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from fit.${table}`), db))[0].n;

/** Una sesión completa de una plantilla: mismas series en cada ejercicio y cierre. */
async function session(user: string, date: string, templateId: string | undefined, work: Record<string, [number, number, number, number]>, extra = {}) {
  const v = await startWorkout(user, { date, sessionTemplateId: templateId }, db);
  for (const [exercise, [kg, reps, rir, n]] of Object.entries(work))
    for (let k = 0; k < n; k++) ok(await logSet(user, { workoutId: v.workout.id, exercise, kg, reps, rir, force: true }, db));
  return finishWorkout(user, { workoutId: v.workout.id, srpe: 7, durationMin: 80, ...extra }, db);
}

beforeAll(async () => {
  db = await openMemoryDb();
  await seedLibrary(db);
  const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('a@test.local'), ('b@test.local') returning id"), db);
  [a, b] = rows.map((r) => r.id);
  dir = mkdtempSync(path.join(tmpdir(), "fit-programs-"));
  writeFileSync(path.join(dir, "test-rueda.json"), JSON.stringify(wheel));
  writeFileSync(path.join(dir, "test-14d.json"), JSON.stringify(long));
  writeFileSync(path.join(dir, "rota.json"), JSON.stringify({ slug: "rota", name: "Sin mesociclos" }));
});
afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("librería", () => {
  it("busca sin acentos ni mayúsculas y filtra por tobillo", async () => {
    expect((await searchExercises(a, { q: "TRICEPS" }, db)).map((e) => e.slug)).toContain("extension-triceps");
    const legs = await searchExercises(a, { muscle: "cuadriceps" }, db);
    expect(legs.map((e) => e.slug).sort()).toEqual(["prensa", "sentadilla"]);
    expect((await searchExercises(a, { muscle: "cuadriceps", ankleSafe: true }, db)).map((e) => e.slug)).toEqual(["prensa"]);
  });

  it("resuelve lo exacto y no adivina lo ambiguo", async () => {
    expect((await resolveExercise(a, "squat", db)).match?.slug).toBe("sentadilla");
    expect((await resolveExercise(a, { text: "PRESS BANCA" }, db)).match?.slug).toBe("press-banca");
    const amb = await resolveExercise(a, "press", db);
    expect(amb.match).toBeUndefined();
    expect(amb.candidates.map((e) => e.slug).sort()).toEqual(["press-banca", "press-banca-inclinado"]);
    expect((await resolveExercise(a, "remo en punta", db)).candidates).toEqual([]);
  });

  it("alternativas: mismo músculo y patrón, ordenadas por coste", async () => {
    const [squat] = await searchExercises(a, { q: "sentadilla" }, db);
    const alts = await findAlternatives(a, { exerciseId: squat.id, ankleSafe: true }, db);
    expect(alts.map((e) => e.slug)).toEqual(["prensa"]);
    expect(alts[0].fatigueCost).toBeLessThan(1.5 * 1.1);
  });
});

describe("plan", () => {
  it("lista las plantillas de la carpeta y aparta las que no validan", () => {
    const r = listProgramTemplates({ dir });
    expect(r.templates.map((t) => t.slug)).toEqual(["test-14d", "test-rueda"]);
    expect(r.invalid.map((x) => x.file)).toEqual(["rota.json"]);
  });

  it("no activa un programa con ejercicios que no están en la librería", async () => {
    const template = { ...wheel, mesocycles: [{ ...wheel.mesocycles[0], sessions: [{ name: "X", exercises: [rx("no-existe", 3, 8, 10), rx("tampoco", 3, 8, 10)] }] }] };
    const err = await activateProgram(a, { slug: "test-rueda", startDate: "2026-11-02" }, db, { template }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("entrada_invalida");
    expect(err.message).toContain("no-existe, tampoco");
    expect(await count(a, "macrocycles")).toBe(0);
  });

  it("activa el programa con microciclos encadenados, sesiones y pautas", async () => {
    const plan = await activateProgram(a, { slug: "test-rueda", startDate: "2026-11-02" }, db, { dir });
    expect(plan.macrocycle).toMatchObject({ status: "activo", goal: "definicion", startDate: "2026-11-02", endDate: "2026-11-15" });
    expect(plan.microcycles.map((m) => [m.position, m.startDate, m.endDate])).toEqual([[1, "2026-11-02", "2026-11-08"], [2, "2026-11-09", "2026-11-15"]]);
    expect(plan.sessions.map((s) => s.name)).toEqual(["Torso A", "Pierna A", "Descanso", "Torso B"]);
    expect(plan.sessions[0].prescriptions.map((p) => [p.exercise.slug, p.sets, p.repMin, p.repMax, p.rirTarget])).toEqual([["press-banca", 4, 4, 6, 2], ["curl-biceps", 3, 10, 12, 1]]);
    expect((await getActivePlan(a, "2026-11-10", db))?.microcycle.position).toBe(2);
  });

  it("microciclo de 14 días: fechas, microciclo actual y pasado de fecha", async () => {
    const plan = await activateProgram(b, { slug: "test-14d", startDate: "2026-11-02" }, db, { dir });
    expect(plan.microcycles.map((m) => [m.lengthDays, m.startDate, m.endDate])).toEqual([[14, "2026-11-02", "2026-11-15"], [14, "2026-11-16", "2026-11-29"]]);
    expect((await getActivePlan(b, "2026-11-15", db))?.microcycle.position).toBe(1);
    expect((await getActivePlan(b, "2026-11-17", db))?.microcycle.position).toBe(2);
    const late = await getActivePlan(b, "2026-12-20", db);
    expect([late?.microcycle.position, late?.beyondEnd]).toEqual([2, true]);
    const next = await getNextSession(b, "2026-11-17", db);
    expect([next.reason, next.session?.name, next.dayOfMicrocycle, next.plannedInMicrocycle]).toEqual(["primera", "Única", 2, 1]);
  });

  it("marca la descarga y adelanta el microciclo re-encadenando fechas", async () => {
    const plan = (await getActivePlan(b, "2026-11-05", db))!;
    expect((await setDeload(b, { microcycleId: plan.microcycles[1].id, isDeload: true }, db)).isDeload).toBe(true);
    const moved = await advanceMicrocycle(b, { date: "2026-11-12" }, db);
    expect(moved.microcycles.map((m) => [m.startDate, m.endDate])).toEqual([["2026-11-02", "2026-11-11"], ["2026-11-12", "2026-11-25"]]);
    expect(moved.microcycle.position).toBe(2);
    expect(moved.macrocycle.endDate).toBe("2026-11-25");
    await expect(advanceMicrocycle(b, { date: "2026-11-20" }, db)).rejects.toMatchObject({ code: "conflicto" });
  });
});

describe("entreno: de la sesión a la progresión", () => {
  let torsoA: string, piernaA: string, torsoB: string;

  it("la rueda empieza por la primera sesión", async () => {
    const next = await getNextSession(a, "2026-11-02", db);
    expect([next.reason, next.session?.name, next.doneInMicrocycle, next.plannedInMicrocycle]).toEqual(["primera", "Torso A", 0, 3]);
    const plan = (await getActivePlan(a, "2026-11-02", db))!;
    [torsoA, piernaA, , torsoB] = plan.sessions.map((s) => s.id);
  });

  it("empezar la sesión trae la pauta; sin historial la sugerencia es «primera»", async () => {
    const v = await startWorkout(a, { date: "2026-11-02", sessionTemplateId: torsoA }, db);
    expect(v.workout).toMatchObject({ status: "en_curso", name: "Torso A", date: "2026-11-02" });
    expect(v.exercises.map((x) => [x.exercise.slug, x.origin, x.prescription?.sets])).toEqual([["press-banca", "plan", 4], ["curl-biceps", "plan", 3]]);
    expect(block(v, "press-banca").suggestion).toMatchObject({ rule: "primera", kg: null, repsTarget: [4, 4, 4, 4] });
    // Empezar otra vez devuelve la misma sesión.
    expect((await startWorkout(a, { date: "2026-11-02", sessionTemplateId: torsoA }, db)).workout.id).toBe(v.workout.id);
    expect((await getNextSession(a, "2026-11-02", db)).reason).toBe("en_curso");
  });

  it("registra series, calcula e1RM y propone la siguiente", async () => {
    const { workout } = await startWorkout(a, { date: "2026-11-02", sessionTemplateId: torsoA }, db);
    const first = ok(await logSet(a, { workoutId: workout.id, exercise: "press banca", kg: 80, reps: 6, rir: 2 }, db));
    expect(first.set).toMatchObject({ setIndex: 1, kg: 80, reps: 6, rir: 2, e1rmConfidence: "alta", effectiveReps: 3, ruleApplied: "primera", repsTarget: 4 });
    expect(first.set.e1rm).toBeCloseTo(80 * (1 + 8 / 30), 1);
    expect(first.isPr).toBe(false);
    expect(first.next).toMatchObject({ exerciseName: "Press banca", setNumber: 2, kg: 80, reps: 4, rir: 2, restSeconds: 120 });

    // La misma serie en menos de 20 s no se guarda dos veces.
    const dup = ok(await logSet(a, { workoutId: workout.id, exercise: "press banca", kg: 80, reps: 6, rir: 2 }, db));
    expect(dup.duplicate).toBe(true);
    expect(dup.set.id).toBe(first.set.id);
    expect(dup.warnings.join(" ")).toContain("repetida");
    expect(await count(a, "workout_sets")).toBe(1);

    for (let k = 0; k < 3; k++) ok(await logSet(a, { workoutId: workout.id, exercise: "bench", kg: 80, reps: 6, rir: 2, force: true }, db));
    const last = ok(await logSet(a, { workoutId: workout.id, exercise: "curl-biceps", kg: 12, reps: 12, rir: 1 }, db));
    expect(last.totals).toMatchObject({ sets: 5, hardSets: 5, tonnage: 4 * 80 * 6 + 12 * 12, byMuscle: { pectoral: 4, triceps: 2, biceps: 1 } });
    expect(last.next).toMatchObject({ exerciseName: "Curl de bíceps", setNumber: 2, kg: 12 });
  });

  it("un nombre ambiguo no escribe nada", async () => {
    const before = [await count(a, "workout_sets"), await count(a, "workouts"), await count(a, "exercises")];
    const r = await logSet(a, { exercise: "press", kg: 60, reps: 8, date: "2026-12-01" }, db);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0].field).toBe("exercise");
      expect(r.problems[0].candidates?.map((c) => c.slug).sort()).toEqual(["press-banca", "press-banca-inclinado"]);
    }
    expect([await count(a, "workout_sets"), await count(a, "workouts"), await count(a, "exercises")]).toEqual(before);
  });

  it("corrige y borra series", async () => {
    const { workout } = await startWorkout(a, { date: "2026-11-02", sessionTemplateId: torsoA }, db);
    const extra = ok(await logSet(a, { workoutId: workout.id, exercise: "curl-biceps", kg: 12, reps: 10, rir: 3 }, db));
    const fixed = await updateSet(a, { setId: extra.set.id, reps: 12, rir: 1 }, db);
    expect(fixed).toMatchObject({ reps: 12, rir: 1, effectiveReps: 4 });
    expect(fixed.e1rm).toBeCloseTo(12 * ((1 + 13 / 30 + 36 / 24) / 2), 1); // 13 reps al fallo: media Epley-Brzycki
    const third = ok(await logSet(a, { workoutId: workout.id, exercise: "curl-biceps", kg: 12, reps: 11, rir: 1 }, db));
    const junk = ok(await logSet(a, { workoutId: workout.id, exercise: "curl-biceps", kg: 99, reps: 1 }, db));
    expect(await deleteSet(a, junk.set.id, db)).toMatchObject({ deleted: true });
    expect(third.set.setIndex).toBe(3);
  });

  it("cerrar la sesión calcula carga, tonelaje y series por grupo", async () => {
    const { workout } = await startWorkout(a, { date: "2026-11-02", sessionTemplateId: torsoA }, db);
    const s = await finishWorkout(a, { workoutId: workout.id, srpe: 7, durationMin: 80, notes: "Bien" }, db);
    expect(s.workout).toMatchObject({ status: "hecha", srpe: 7, durationMin: 80, load: 560 });
    expect([s.load, s.hardSets, s.tonnage]).toEqual([560, 7, 4 * 80 * 6 + 12 * (12 + 12 + 11)]);
    expect(s.setsByMuscle).toEqual({ pectoral: 4, triceps: 2, biceps: 3 });
    expect(s.prs).toEqual([]); // primera vez: no hay marca anterior que batir
  });

  it("la rueda avanza, salta el descanso y vuelve al principio", async () => {
    let next = await getNextSession(a, "2026-11-03", db);
    expect([next.reason, next.session?.id, next.doneInMicrocycle]).toEqual(["siguiente", piernaA, 1]);
    await session(a, "2026-11-03", piernaA, { sentadilla: [100, 5, 2, 3], prensa: [150, 10, 2, 3] }, { kneeSleeves: true });
    next = await getNextSession(a, "2026-11-05", db);
    expect([next.session?.id, next.restBetween, next.lastDone?.name]).toEqual([torsoB, 1, "Pierna A"]);
    await session(a, "2026-11-05", torsoB, { "press-banca-inclinado": [60, 8, 2, 3], "extension-triceps": [25, 10, 1, 3] });
    next = await getNextSession(a, "2026-11-06", db);
    expect([next.session?.id, next.restBetween, next.doneInMicrocycle]).toEqual([torsoA, 0, 3]);
  });

  it("al llegar al tope del rango en todas las series, la sesión siguiente sube la carga", async () => {
    const v = await startWorkout(a, { date: "2026-11-06", sessionTemplateId: torsoA }, db);
    const press = block(v, "press-banca");
    expect(press.suggestion).toMatchObject({ rule: "subir_carga", kg: 82.5, repsTarget: [4, 4, 4, 4], rirTarget: 2 });
    expect(press.lastSession).toEqual({ date: "2026-11-02", sets: Array(4).fill({ kg: 80, reps: 6, rir: 2 }) });
    expect(press.plates).toEqual({ plates: [25, 5, 1.25], perSide: 31.25, exact: true });
    expect(press.warmup.length).toBeGreaterThanOrEqual(3);
    expect(press.warmup.every((w) => w.kg < 82.5)).toBe(true);
    expect(press.bestE1rm?.value).toBeCloseTo(101.33, 1);
    // El curl no llegó a 12 en la tercera: misma carga y una repetición más.
    expect(block(v, "curl-biceps").suggestion).toMatchObject({ rule: "sumar_rep", kg: 12, repsTarget: [12, 12, 12] });
    expect(block(v, "curl-biceps").plates).toBeNull();
    expect(v.next).toMatchObject({ exerciseName: "Press banca", kg: 82.5, reps: 4 });
  });

  it("detecta el récord de e1RM y lo anota al cerrar", async () => {
    const { workout } = await startWorkout(a, { date: "2026-11-06", sessionTemplateId: torsoA }, db);
    const r = ok(await logSet(a, { workoutId: workout.id, exercise: "press-banca", kg: 82.5, reps: 6, rir: 2 }, db));
    expect(r.set).toMatchObject({ kgTarget: 82.5, repsTarget: 4, rirTarget: 2, ruleApplied: "subir_carga" });
    expect(r.isPr).toBe(true);
    expect(r.pr?.previous).toBeCloseTo(101.33, 1);
    expect(r.pr?.e1rm).toBeCloseTo(104.5, 1);
    const low = ok(await logSet(a, { workoutId: workout.id, exercise: "press-banca", kg: 60, reps: 5, rir: 2 }, db));
    expect(low.isPr).toBe(false);
    const s = await finishWorkout(a, { workoutId: workout.id, srpe: 8, durationMin: 70 }, db);
    expect(s.prs.map((p) => [p.name, p.kg, p.reps])).toEqual([["Press banca", 82.5, 6]]);
    expect(s.annotations.filter((n) => n.rule === "pr").map((n) => n.title)).toEqual(["Récord en Press banca: 104,5 kg de 1RM estimado"]);
    // Cerrar dos veces no duplica las anotaciones.
    await finishWorkout(a, { workoutId: workout.id, srpe: 8, durationMin: 70 }, db);
    expect(await count(a, "annotations")).toBe(s.annotations.length);
  });

  it("historial de un ejercicio con e1RM por sesión", async () => {
    const h = await getExerciseHistory(a, { exercise: "bench" }, db);
    expect(h.sessions.map((s) => [s.date, s.sets.length])).toEqual([["2026-11-06", 2], ["2026-11-02", 4]]);
    expect(h.best).toMatchObject({ date: "2026-11-06" });
    expect(h.trend.direction).toBe("sin_datos");
    await expect(getExerciseHistory(a, { exercise: "press" }, db)).rejects.toMatchObject({ code: "ambiguo" });
  });

  it("un ejercicio desconocido se crea sin clasificar y se avisa", async () => {
    const r = ok(await logSet(a, { exercise: "remo en punta", kg: 50, reps: 10, rir: 2, date: "2026-11-07" }, db));
    expect(r.warnings.join(" ")).toMatch(/sin clasificar/);
    expect(r.warnings.join(" ")).toMatch(/sesión libre/);
    expect(r.exercise.slug).toBe("remo-en-punta");
    const v = await getWorkoutView(a, r.workoutId, db);
    expect(v.workout.name).toBe("Sesión libre");
    expect(v.exercises[0]).toMatchObject({ origin: "manual", prescription: null });
    expect(v.exercises[0].exercise.primaryMuscle).toBeNull();
    // La siguiente serie sin sesión indicada cae en la misma sesión en curso.
    const again = ok(await logSet(a, { exercise: "remo en punta", kg: 50, reps: 9, rir: 2, date: "2026-11-07" }, db));
    expect(again.workoutId).toBe(r.workoutId);
    expect(again.set.setIndex).toBe(2);
  });

  it("añade y cambia ejercicios dentro de la sesión", async () => {
    const free = await startWorkout(a, { date: "2026-11-08", name: "Extra" }, db);
    const [squat] = await searchExercises(a, { q: "sentadilla" }, db);
    const [press] = await searchExercises(a, { q: "prensa" }, db);
    let v = await addExerciseToWorkout(a, { workoutId: free.workout.id, exercise: "squat" }, db);
    expect(v.exercises.map((x) => x.exercise.slug)).toEqual(["sentadilla"]);
    v = await swapExercise(a, { workoutId: free.workout.id, fromExerciseId: squat.id, toExerciseId: press.id }, db);
    expect(v.exercises[0]).toMatchObject({ origin: "cambio", replaces: { id: squat.id, name: "Sentadilla" } });
    expect(v.exercises[0].exercise.slug).toBe("prensa");
    await expect(addExerciseToWorkout(a, { workoutId: free.workout.id, exercise: "press" }, db)).rejects.toMatchObject({ code: "ambiguo" });
  });

  it("regla del tobillo: marca la sentadilla, propone la prensa y topa la carga al 75 %", async () => {
    expect((await getAnkleStatus(a, "2026-11-10", db)).rule.restricted).toBe(false);
    const pain = await logInjuryPain(a, { zone: "Tobillo", pain: 5, date: "2026-11-10" }, db);
    expect(pain).toMatchObject({ created: true, zone: "tobillo" });
    expect(pain.ankle?.rule).toMatchObject({ restricted: true, squatCapPct: 75, impactAllowed: false });

    const v = await startWorkout(a, { date: "2026-11-10", sessionTemplateId: piernaA }, db);
    const squat = block(v, "sentadilla");
    expect(squat.ankleWarning).toMatchObject({ loadCapPct: 75, alternative: { slug: "prensa", name: "Prensa" } });
    expect(squat.ankleWarning?.message).toContain("Prensa");
    // e1RM de 100 × 5 con RIR 2 = 123,3 kg → 75 % = 92,5 kg. La progresión pedía repetir 100 kg.
    expect(squat.loadCap).toEqual({ pct: 75, kg: 92.5, reason: "tobillo" });
    expect(squat.suggestion).toMatchObject({ rule: "sumar_rep", kg: 92.5 });
    expect(block(v, "prensa").ankleWarning).toBeNull();
    expect(block(v, "prensa").suggestion?.kg).toBe(150);

    const over = ok(await logSet(a, { workoutId: v.workout.id, exercise: "sentadilla", kg: 95, reps: 5, rir: 2 }, db));
    expect(over.warnings.join(" ")).toContain("tope de 92,5 kg");
  });

  it("dolor al día siguiente de pierna: la sentadilla pierde una serie y la prensa no", async () => {
    const leg = ok(await logSet(a, { exercise: "sentadilla", kg: 90, reps: 5, rir: 2, date: "2026-12-01" }, db));
    await finishWorkout(a, { workoutId: leg.workoutId, srpe: 7, durationMin: 50 }, db);
    const base = await startWorkout(a, { date: "2026-12-20", sessionTemplateId: piernaA }, db);
    const baseSets = { sentadilla: block(base, "sentadilla").suggestion!.sets, prensa: block(base, "prensa").suggestion!.sets };
    expect(baseSets.sentadilla).toBeGreaterThan(1);
    await finishWorkout(a, { workoutId: base.workout.id, srpe: 5, durationMin: 5 }, db);

    await logInjuryPain(a, { zone: "tobillo", pain: 5, moment: "dia_siguiente", date: "2026-12-02" }, db);
    const v = await startWorkout(a, { date: "2026-12-21", sessionTemplateId: piernaA }, db);
    expect(v.ankle.rule.dropTopSet).toBe(true);
    const squat = block(v, "sentadilla");
    expect(squat.suggestion!.sets).toBe(baseSets.sentadilla - 1);
    expect(squat.suggestion!.repsTarget).toHaveLength(squat.suggestion!.sets);
    expect(squat.suggestion!.why).toContain("Tobillo: dolió al día siguiente de la última pierna, hoy sin top set.");
    expect(block(v, "prensa").suggestion!.sets).toBe(baseSets.prensa);
    expect(block(v, "prensa").suggestion!.why).not.toContain("sin top set");
  });

  it("cola sin conexión: el mismo clientId no inserta otra serie y la hora real se guarda", async () => {
    const v = await startWorkout(a, { date: "2026-11-12" }, db);
    const doneAt = "2026-11-12T10:15:00.000Z";
    const first = ok(await logSet(a, { workoutId: v.workout.id, exercise: "curl-biceps", kg: 20, reps: 10, rir: 2, clientId: "c-1", doneAt }, db));
    expect(first.duplicate).toBe(false);
    expect(new Date(first.set.doneAt!).toISOString()).toBe(doneAt);
    expect(first.set.setIndex).toBe(1);
    const before = await count(a, "workout_sets");
    // Reenvío (la respuesta se perdió): mismo clientId, aunque pasen más de 20 s y cambie la carga: no se escribe.
    const again = ok(await logSet(a, { workoutId: v.workout.id, exercise: "curl-biceps", kg: 25, reps: 8, clientId: "c-1" }, db));
    expect(again.duplicate).toBe(true);
    expect(again.set.id).toBe(first.set.id);
    expect(again.set).toMatchObject({ kg: 20, reps: 10 });
    expect(await count(a, "workout_sets")).toBe(before);
    // Otro clientId sí inserta; y la fecha de la sesión no cambia con doneAt.
    const next = ok(await logSet(a, { workoutId: v.workout.id, exercise: "curl-biceps", kg: 20, reps: 9, rir: 1, clientId: "c-2", doneAt: "2026-11-12T10:18:00.000Z", force: true }, db));
    expect(next.duplicate).toBe(false);
    expect(await count(a, "workout_sets")).toBe(before + 1);
    expect((await getWorkoutView(a, v.workout.id, db)).workout.date).toBe("2026-11-12");
  });

  it("material: compara rodilleras con y sin, y dice que la muestra es pequeña", async () => {
    const { workout } = await startWorkout(a, { date: "2026-11-10", sessionTemplateId: piernaA }, db);
    const s = await finishWorkout(a, { workoutId: workout.id, srpe: 6, durationMin: 50, kneeSleeves: false }, db);
    const note = s.annotations.find((n) => n.rule === "material_rodilleras");
    expect(note?.scope).toBe("material");
    expect(note?.title).toBe("Sentadilla: 123,3 kg con rodilleras, 117,2 kg sin rodilleras");
    expect(note?.body).toContain("(1 sesión)");
    expect(note?.body).toContain("Muestra pequeña");
    expect(s.annotations.some((n) => n.rule === "material_cinturon")).toBe(false);
  });

  it("al añadir un alias a un ejercicio común se clona como propio sin partir el historial", async () => {
    const [common] = await searchExercises(a, { q: "press banca" }, db);
    expect(common.userId).toBeNull();
    const r = await addAlias(a, { exerciseId: common.id, alias: "banca plana" }, db);
    expect(r.cloned).toBe(true);
    expect(r.exercise).toMatchObject({ userId: a, slug: "press-banca" });
    expect(r.exercise.aliases).toEqual(["bench", "banca plana"]);
    expect((await resolveExercise(a, "Banca plana", db)).match?.id).toBe(r.exercise.id);
    expect((await getExerciseHistory(a, { exercise: "banca plana" }, db)).sessions).toHaveLength(2);
    expect((await searchExercises(a, { q: "press banca" }, db)).filter((e) => e.slug === "press-banca")).toHaveLength(1);
    // El otro atleta sigue viendo el común, sin el alias.
    expect((await resolveExercise(b, "banca plana", db)).match).toBeUndefined();
    await expect(addAlias(a, { exerciseId: r.exercise.id, alias: "squat" }, db)).rejects.toMatchObject({ code: "conflicto" });
  });

  it("agujetas por grupo, con los grupos validados", async () => {
    expect(await logSoreness(a, { date: "2026-11-04", scores: { cuadriceps: 4, pectoral: 2 } }, db)).toEqual({ date: "2026-11-04", scores: { cuadriceps: 4, pectoral: 2 } });
    await logSoreness(a, { date: "2026-11-04", scores: { cuadriceps: 3 } }, db);
    expect(await count(a, "soreness_logs")).toBe(2);
    await expect(logSoreness(a, { scores: { rodilla: 3 } }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });
});

describe("anotaciones automáticas del motor", () => {
  it("estancado: tres sesiones con la misma carga sin sumar repeticiones", async () => {
    const days = ["2026-11-03", "2026-11-05", "2026-11-07"];
    const out = [];
    for (const d of days) out.push(await session(b, d, undefined, { "curl-biceps": [10, 10, 2, 3] }));
    expect(out[1].annotations.some((n) => n.rule === "estancado")).toBe(false);
    expect(out[2].annotations.filter((n) => n.rule === "estancado").map((n) => [n.severity, n.title])).toEqual([["aviso", "Curl de bíceps: 3 sesiones sin sumar"]]);
  });

  it("series basura: más de 10 series efectivas de un grupo en una sesión", async () => {
    const s = await session(b, "2026-11-09", undefined, { "curl-biceps": [10, 10, 2, 12] });
    const note = s.annotations.find((n) => n.rule === "series_basura");
    expect(note?.title).toBe("Bíceps: 12 series efectivas en una sesión");
    expect(note?.body).toContain("Sobran 2");
    expect(s.setsByMuscle).toEqual({ biceps: 12 });
  });

  it("cada atleta solo ve sus sesiones", async () => {
    const mine = await startWorkout(b, { date: "2026-11-11" }, db);
    await expect(getWorkoutView(a, mine.workout.id, db)).rejects.toMatchObject({ code: "no_encontrado" });
    await expect(logSet(a, { workoutId: mine.workout.id, exercise: "curl-biceps", kg: 10, reps: 10 }, db)).rejects.toMatchObject({ code: "no_encontrado" });
  });
});
