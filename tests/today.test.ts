import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { seedCatalog } from "@/server/seed";
import { addDays, todayIn } from "@/server/time";
import {
  activateProgram, finishWorkout, getToday, logBodyMetrics, logInjuryPain, logSet, logSteps, recalcTargets, saveCheckin, saveOnboarding, startWorkout,
  type TodayView,
} from "@/server/services";

let db: Db;
let empty: string; // recién creado, sin nada
let a: string; // con ficha completa y programa

// Fechas reales: así «hoy» del atleta coincide con la fecha consultada y la regla de las 15:00 se puede probar.
const D = todayIn("Europe/Madrid");
const MORNING = new Date(`${D}T08:00:00Z`); // 09:00 o 10:00 en Madrid
const AFTERNOON = new Date(`${D}T15:30:00Z`); // 16:30 o 17:30 en Madrid

const count = async (user: string, table: string) =>
  (await withUser(user, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from fit.${table}`), db))[0].n;
const HREFS = ["/onboarding", "/bienestar", "/progreso", "/entreno", "/nutricion", "/cardio"];
const goodCheckin = { date: D, sleepQuality: 8, sleepHours: 8, stress: 3, motivation: 8, pain: 2, fatigue: 3 };
const lowCheckin = { date: D, sleepQuality: 5, stress: 7, motivation: 4, pain: 5, fatigue: 7 }; // readiness 41

beforeAll(async () => {
  db = await openMemoryDb();
  await seedCatalog(db);
  const rows = await asSystem((tx) => tx.query<{ id: string }>(
    "insert into fit.athletes (email, name) values ('vacio@test.local', null), ('hoy@test.local', 'Alex') returning id"), db);
  [empty, a] = rows.map((r) => r.id);
});
afterAll(async () => db.close());

describe("getToday: atleta vacío", () => {
  it("no lanza, deja los bloques sin datos y pide el onboarding", async () => {
    const t = await getToday(empty, {}, db);
    expect(t.date).toBe(D);
    expect(t.isToday).toBe(true);
    expect(["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]).toContain(t.weekday);
    expect(t.athlete.onboardingComplete).toBe(false);
    expect(t.athlete.missing.map((m) => m.field)).toEqual(expect.arrayContaining(["heightCm", "weightKg", "program"]));
    expect(t.checkin).toBeNull();
    expect(t.needsCheckin).toBe(true);
    expect(t.training?.plan).toBeNull();
    expect(t.training?.todayKind).toBe("sin_plan");
    expect(t.training?.next).toBeNull();
    expect(t.training?.inProgress).toBeNull();
    expect(t.nutrition?.target).toBeNull();
    expect(t.weight).toMatchObject({ lastKg: null, lastDate: null, daysSinceWeighIn: null });
    expect(t.load?.acwr.reliable).toBe(false);
    expect(t.annotations).toEqual([]);
    expect(t.nextAction).toMatchObject({ kind: "onboarding", href: "/onboarding" });
    expect(t.nextAction.detail).toContain("¿");
  });

  it("valida la fecha", async () => {
    await expect(getToday(empty, { date: "ayer" }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });
});

describe("getToday: con plan activo", () => {
  let today: TodayView;

  beforeAll(async () => {
    const o = await saveOnboarding(a, {
      heightCm: 174, birthDate: "2004-03-10", sex: "H", hrRest: 58, bedtime: "23:30", adhdMedication: false, weeklyFoodBudgetEur: 60,
      stores: ["mercadona"], goalWeightKg: 74, weightKg: 80, waistCm: 86, measuredOn: addDays(D, -3),
      ankle: { status: "abierta", painToday: 1 },
    }, db);
    expect(o.status.missing.map((m) => m.field)).toEqual(["program"]);
    await activateProgram(a, { slug: "torso-pierna-6d", startDate: D }, db);
    // Historial del primer ejercicio de la sesión que toca: 4 × 5 con 80 kg, tres días antes, en una sesión libre.
    const w = await startWorkout(a, { date: addDays(D, -3), name: "Libre" }, db);
    for (let k = 0; k < 4; k++) {
      const r = await logSet(a, { workoutId: w.workout.id, exercise: "press-banca", kg: 80, reps: 5, rir: 2, force: true }, db);
      expect(r.ok).toBe(true);
    }
    await finishWorkout(a, { workoutId: w.workout.id, srpe: 7, durationMin: 60 }, db);
  });

  it("orden de lo pendiente: check-in, luego pesada, luego la sesión", async () => {
    const before = { workouts: await count(a, "workouts"), entries: await count(a, "workout_exercises"), sets: await count(a, "workout_sets") };

    let t = await getToday(a, {}, db, { now: MORNING });
    expect(t.athlete).toMatchObject({ name: "Alex", onboardingComplete: true, missing: [] });
    expect(t.nextAction).toMatchObject({ kind: "checkin", href: "/bienestar" });

    await saveCheckin(a, goodCheckin, db);
    t = await getToday(a, {}, db, { now: MORNING });
    expect(t.checkin).toMatchObject({ band: "completa" });
    expect(t.needsCheckin).toBe(false);
    expect(t.weight).toMatchObject({ lastKg: 80, lastDate: addDays(D, -3), daysSinceWeighIn: 3, goalKg: 74 });
    expect(t.nextAction).toMatchObject({ kind: "pesaje", href: "/progreso" });

    await logBodyMetrics(a, { date: D, weightKg: 79.6 }, db);
    today = await getToday(a, {}, db, { now: MORNING });
    expect(today.weight).toMatchObject({ lastKg: 79.6, daysSinceWeighIn: 0 });
    expect(today.weight!.toGoalKg).toBeGreaterThan(5);
    expect(today.nextAction).toMatchObject({ kind: "empezar_sesion", label: "Empieza: Torso A", href: "/entreno" });
    expect(today.nextAction.detail).toContain("Press banca a 80 kg");

    // Solo lectura: mirar «Hoy» no abre sesiones ni escribe series.
    expect({ workouts: await count(a, "workouts"), entries: await count(a, "workout_exercises"), sets: await count(a, "workout_sets") }).toEqual(before);
  });

  it("resume el plan y sugiere la sesión con sus cargas", () => {
    const tr = today.training!;
    expect(tr.plan).toMatchObject({
      macrocycle: { goal: "definicion", startDate: D },
      mesocycle: { position: 1, of: 1, blockType: "hipertrofia" },
      microcycle: { position: 1, of: 6, lengthDays: 7, day: 1, isDeload: false, sessionsDone: 0, sessionsPlanned: 6, startDate: D, endDate: addDays(D, 6) },
    });
    expect(tr.plan!.sessions.map((s) => s.name)).toEqual(["Torso A", "Pierna A", "Cardio + Core", "Torso B", "Pierna B", "Brazo + Hombro", "Descanso"]);
    expect(tr.plan!.sessions.filter((s) => s.isRest).map((s) => s.name)).toEqual(["Descanso"]);
    expect(tr).toMatchObject({ todayKind: "entreno", isDeload: false, trainedToday: false, inProgress: null });
    expect(tr.next).toMatchObject({ reason: "primera", name: "Torso A", isCardio: false });
    expect(tr.next!.exercises).toHaveLength(7);

    const bench = tr.next!.exercises[0];
    expect(bench).toMatchObject({ slug: "press-banca", sets: 4, repMin: 4, repMax: 6, setsDone: 0, done: false });
    expect(bench.suggestion).toMatchObject({ rule: "sumar_rep", kg: 80, sets: 4, repsTarget: [6, 5, 5, 5], stalled: false });
    expect(bench.suggestion!.why).toContain("80 kg");
    expect(bench.lastSession).toMatchObject({ date: addDays(D, -3) });
    expect(bench.lastSession!.sets).toHaveLength(4);

    // Sin historial no se inventa carga.
    const noHistory = tr.next!.exercises[1];
    expect(noHistory.suggestion).toMatchObject({ rule: "primera", kg: null });
    expect(noHistory.lastSession).toBeNull();
  });

  it("resume nutrición, actividad, carga y tobillo", async () => {
    expect(today.ankle).toMatchObject({ pain: 1, restricted: false, impactAllowed: true, squatCapPct: null });
    expect(today.nutrition).toMatchObject({ dayType: "on", target: null, items: 0 });
    expect(today.activity).toMatchObject({ z2: { minutes: 0, targetMin: 150, remainingMin: 150 }, cardioToday: false });
    expect(today.activity!.steps.goal).toBeGreaterThan(0);
    expect(today.load).toMatchObject({ acwr: { reliable: false }, deload: { deload: false } });
    for (const t of [today, await getToday(empty, {}, db)]) expect(HREFS).toContain(t.nextAction.href);
  });

  it("un check-in bajo (readiness < 50) cambia las sugerencias", async () => {
    const c = await saveCheckin(a, lowCheckin, db);
    expect(c.readiness).toBe(41);
    const t = await getToday(a, {}, db, { now: MORNING });
    expect(t.checkin).toMatchObject({ readiness: 41, band: "solo_efectivas" });
    const bench = t.training!.next!.exercises[0];
    expect(bench.suggestion).toMatchObject({ rule: "readiness_bajo", kg: 80, repsTarget: [5, 5, 5, 5], rirTarget: 3 });
    expect(bench.suggestion!.why).toContain("Readiness 41");
    expect(t.nextAction.kind).toBe("empezar_sesion");

    // Por debajo de 30 no se entrena pesado: la acción pasa a ser Z2 o descanso.
    await saveCheckin(a, { date: D, sleepQuality: 2, stress: 9, motivation: 2, pain: 7, fatigue: 9 }, db);
    const z2 = await getToday(a, {}, db, { now: MORNING });
    expect(z2.checkin!.band).toBe("z2");
    expect(z2.training!.next!.exercises[0].suggestion).toMatchObject({ rule: "solo_z2", kg: null, sets: 0 });
    expect(z2.nextAction).toMatchObject({ kind: "cardio", href: "/cardio" });
    await saveCheckin(a, goodCheckin, db);
  });

  it("con sesión en curso: continuar, con el progreso y la siguiente serie", async () => {
    const templateId = today.training!.next!.sessionTemplateId;
    const w = await startWorkout(a, { date: D, sessionTemplateId: templateId }, db);
    const s = await logSet(a, { workoutId: w.workout.id, exercise: "press-banca", kg: 80, reps: 6, rir: 2 }, db);
    expect(s.ok).toBe(true);

    const t = await getToday(a, {}, db, { now: MORNING });
    const tr = t.training!;
    expect(tr.todayKind).toBe("entreno");
    expect(tr.next).toMatchObject({ reason: "en_curso", name: "Torso A" });
    expect(tr.next!.exercises[0]).toMatchObject({ slug: "press-banca", setsDone: 1, done: false });
    expect(tr.next!.exercises[0].suggestion).toMatchObject({ kg: 80 });
    expect(tr.inProgress).toMatchObject({ workoutId: w.workout.id, name: "Torso A", setsDone: 1, exercisesDone: 0, exercisesTotal: 7 });
    expect(tr.inProgress!.next).toMatchObject({ exerciseName: "Press banca", setNumber: 2, kg: 80 });
    expect(t.nutrition!.dayType).toBe("on");
    expect(t.nextAction).toMatchObject({ kind: "continuar_sesion", label: "Continúa: Torso A", href: "/entreno" });
    expect(t.nextAction.detail).toContain("serie 2");

    await finishWorkout(a, { workoutId: w.workout.id, srpe: 7, durationMin: 70 }, db);
  });

  it("con la sesión hecha: nada de entreno; por la tarde, la comida si falta proteína", async () => {
    let t = await getToday(a, {}, db, { now: AFTERNOON });
    expect(t.training).toMatchObject({ todayKind: "hecho", trainedToday: true, inProgress: null });
    expect(t.training!.doneToday).toHaveLength(1);
    expect(t.training!.next).toMatchObject({ reason: "siguiente", name: "Pierna A" });
    expect(t.training!.plan!.sessions[0].doneOn).toBe(D);
    expect(t.training!.plan!.microcycle.sessionsDone).toBe(1);
    expect(t.nextAction.kind).toBe("nada"); // sin objetivos de nutrición no se pide comida

    const targets = await recalcTargets(a, { date: D }, db);
    expect(targets.ok).toBe(true);
    t = await getToday(a, {}, db, { now: AFTERNOON });
    expect(t.nutrition!.target!.proteinG).toBeGreaterThan(100);
    expect(t.nextAction).toMatchObject({ kind: "comida", href: "/nutricion" });
    expect((await getToday(a, {}, db, { now: MORNING })).nextAction.kind).toBe("nada");
  });

  it("mañana toca Pierna A: el tobillo con dolor avisa y limita la carga", async () => {
    const tomorrow = addDays(D, 1);
    await logInjuryPain(a, { zone: "tobillo", pain: 5, date: tomorrow }, db);
    const t = await getToday(a, { date: tomorrow }, db, { now: MORNING });
    expect(t.isToday).toBe(false);
    expect(t.ankle).toMatchObject({ pain: 5, restricted: true, squatCapPct: 75 });
    expect(t.training).toMatchObject({ todayKind: "entreno", trainedToday: false });
    const squat = t.training!.next!.exercises.find((e) => e.slug === "sentadilla-multipower")!;
    expect(squat.loadCap).toMatchObject({ pct: 75, reason: "tobillo" });
    expect(squat.ankleWarning).toContain("5/10");
    expect(t.training!.next!.exercises.find((e) => e.slug === "extension-cuadriceps")!.ankleWarning).toBeNull();
  });

  it("día de cardio y día de descanso de la rueda", async () => {
    // Se cierran Pierna A (D+1) y, tras el cardio (D+2), el resto de la rueda hasta Brazo + Hombro (D+5).
    const ids = today.training!.plan!.sessions;
    const close = async (name: string, date: string) => {
      const w = await startWorkout(a, { date, sessionTemplateId: ids.find((s) => s.name === name)!.id }, db);
      await finishWorkout(a, { workoutId: w.workout.id, srpe: 6, durationMin: 50 }, db);
    };
    await close("Pierna A", addDays(D, 1));
    const cardioDay = await getToday(a, { date: addDays(D, 2) }, db, { now: MORNING });
    expect(cardioDay.training).toMatchObject({ todayKind: "cardio", next: { name: "Cardio + Core", isCardio: true } });
    expect(cardioDay.training!.next!.exercises[0]).toMatchObject({ slug: "z2-bici", suggestion: null });
    // D+2 no tiene check-in ni pesada reciente: se miran solo los bloques, no la acción.

    await close("Cardio + Core", addDays(D, 2));
    await close("Torso B", addDays(D, 3));
    await close("Pierna B", addDays(D, 4));
    await close("Brazo + Hombro", addDays(D, 5));
    const rest = addDays(D, 6);
    await saveCheckin(a, { ...goodCheckin, date: rest }, db);
    await logBodyMetrics(a, { date: rest, weightKg: 79.2 }, db);
    let t = await getToday(a, { date: rest }, db, { now: MORNING });
    expect(t.training).toMatchObject({ todayKind: "descanso", next: { name: "Torso A", restBetween: 1 } });
    expect(t.nextAction).toMatchObject({ kind: "descanso", label: "Descanso: pasos", href: "/cardio" });

    await logSteps(a, { date: rest, steps: 30000 }, db);
    t = await getToday(a, { date: rest }, db, { now: MORNING });
    expect(t.activity!.steps.done).toBe(30000);
    expect(t.nextAction.kind).toBe("nada");
  });
});
