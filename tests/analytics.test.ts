import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { acwr } from "@/engine";
import { upsertScheduleBlock } from "@/server/services/athlete";
import { searchExercises, setVolumeTarget } from "@/server/services/library";
import { getE1rmSeries, getLoadStatus, getProgress, getVolumeStatus } from "@/server/services/analytics";
import { activateProgram } from "@/server/services/plan";
import { finishWorkout, logSet, startWorkout } from "@/server/services/training";
import { logBodyMetrics, saveCheckin } from "@/server/services/wellness";

let db: Db;
let a: string;
let empty: string;

type Work = Record<string, [kg: number, reps: number, rir: number, sets: number]>;

/** Sesión libre completa en una fecha: series iguales por ejercicio y cierre con sRPE y minutos. */
async function session(user: string, date: string, work: Work, srpe: number, durationMin: number, sessionTemplateId?: string) {
  const v = await startWorkout(user, { date, sessionTemplateId }, db);
  for (const [exercise, [kg, reps, rir, n]] of Object.entries(work))
    for (let k = 0; k < n; k++) {
      const r = await logSet(user, { workoutId: v.workout.id, exercise, kg, reps, rir, force: true }, db);
      if (!r.ok) throw new Error(JSON.stringify(r.problems));
    }
  return finishWorkout(user, { workoutId: v.workout.id, srpe, durationMin }, db);
}

beforeAll(async () => {
  db = await openMemoryDb();
  await asSystem(async (tx) => {
    await tx.query(`insert into fit.muscle_groups (id, name, region, default_mev, default_mrv) values
      ('pectoral', 'Pectoral', 'torso', 8, 20), ('triceps', 'Tríceps', 'brazo', 6, 18), ('biceps', 'Bíceps', 'brazo', 8, 20),
      ('cuadriceps', 'Cuádriceps', 'pierna', 8, 18)`);
    await tx.query(`insert into fit.exercises (slug, name, primary_muscle, secondary_muscles, kind, movement_pattern, equipment, load_step) values
      ('press-banca', 'Press banca', 'pectoral', '{triceps}', 'compuesto', 'empuje_h', 'barra', 2.5),
      ('sentadilla', 'Sentadilla', 'cuadriceps', '{}', 'compuesto', 'dominante_rodilla', 'barra', 2.5),
      ('curl-biceps', 'Curl de bíceps', 'biceps', '{}', 'aislamiento', 'flexion_codo', 'mancuernas', 1),
      ('extension-triceps', 'Extensión de tríceps', 'triceps', '{}', 'aislamiento', 'extension_codo', 'polea', 2.5)`);
  }, db);
  const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('a@test.local'), ('vacio@test.local') returning id"), db);
  [a, empty] = rows.map((r) => r.id);

  // Octubre: tres sesiones de pesas con huecos largos entre medias y una de cardio.
  await session(a, "2026-10-01", { "press-banca": [80, 6, 2, 4], "curl-biceps": [12, 10, 2, 3] }, 7, 60);   // carga 420
  await session(a, "2026-10-03", { sentadilla: [100, 5, 2, 3] }, 7, 60);                                    // carga 420
  await session(a, "2026-10-20", { "press-banca": [82.5, 5, 2, 4], "extension-triceps": [25, 12, 1, 2] }, 8, 60); // carga 480
  await withUser(a, (tx) => tx.query("insert into fit.cardio_sessions (date, mode, minutes, zone, ecos) values ('2026-10-25', 'bici', 45, 2, 90)"), db);
});
afterAll(async () => db.close());

describe("carga (ACWR)", () => {
  const loads = [
    { date: "2026-10-01", load: 420 }, { date: "2026-10-03", load: 420 }, { date: "2026-10-20", load: 480 }, { date: "2026-10-25", load: 90 },
  ];

  it("cuenta los días vacíos como cero y suma el cardio", async () => {
    const s = await getLoadStatus(a, "2026-10-30", db);
    const expected = acwr(loads, "2026-10-30");
    expect(s.acwr).toMatchObject({ days: 30, reliable: true, acute: expected.acute, chronic: expected.chronic, ratio: expected.ratio, zone: expected.zone });
    // Con la media solo de los días entrenados la carga crónica sería > 350; con los ceros queda muy por debajo.
    expect(s.acwr.chronic).toBeLessThan(120);
    expect(s.acwr.acute).toBeGreaterThan(0);
    // Sin el cardio el resultado es otro: la sesión de bici cuenta.
    expect(acwr(loads.slice(0, 3), "2026-10-30").acute).not.toBe(s.acwr.acute);
  });

  it("con menos de 21 días de historial no da ratio", async () => {
    const s = await getLoadStatus(a, "2026-10-10", db);
    expect(s.acwr).toMatchObject({ days: 10, reliable: false, ratio: null, zone: null });
    expect(s.acwr.label).toContain("Faltan 11 días");
    expect(s.deload.deload).toBe(false);
  });

  it("sin sesiones no inventa nada", async () => {
    const s = await getLoadStatus(empty, "2026-10-30", db);
    expect(s.acwr).toMatchObject({ acute: 0, chronic: 0, ratio: null, days: 0, label: "Sin sesiones registradas." });
    expect(s.muscleStress).toEqual([]);
    expect(s.deload).toMatchObject({ deload: false, signals: [], maintenance: false });
  });

  it("estrés semanal por grupo con las series de los últimos 7 días", async () => {
    const s = await getLoadStatus(a, "2026-10-21", db);
    // Tabla del motor: RIR 2 = 1,0 y RIR 1 = 1,2. Press banca: 4 × 1,0 = 4. Extensión: 2 × 1,2 = 2,4.
    expect(s.muscleStress).toEqual([
      { muscleId: "pectoral", name: "Pectoral", value: 4, band: "ligero", sets: 4 },
      { muscleId: "triceps", name: "Tríceps", value: 2.4, band: "ligero", sets: 2 },
    ]);
    expect(s.signals.maxWeeklyStress).toBe(4);
  });

  it("descarga: hacen falta dos señales (readiness bajo + exámenes)", async () => {
    await upsertScheduleBlock(a, { kind: "examen", title: "Parciales", from: "2026-10-26", to: "2026-10-30" }, db);
    let s = await getLoadStatus(a, "2026-10-28", db);
    expect(s.signals).toMatchObject({ examPeriod: true, readiness7dAvg: null, e1rmDropping: [] });
    expect(s.deload).toMatchObject({ deload: false, maintenance: true });

    for (const d of ["2026-10-26", "2026-10-27", "2026-10-28"])
      await saveCheckin(a, { date: d, sleepQuality: 4, stress: 8, motivation: 4, pain: 4, fatigue: 7 }, db); // readiness 37
    s = await getLoadStatus(a, "2026-10-28", db);
    expect(s.signals.readiness7dAvg).toBe(37);
    expect(s.deload.deload).toBe(true);
    expect(s.deload.signals).toHaveLength(2);
    expect(s.deload.plan).toContain("40 %");
  });

  it("detecta el e1RM que cae dos sesiones seguidas en un compuesto", async () => {
    // Sentadilla: 100 × 5 (3 oct) → 97,5 × 5 → 95 × 5.
    await session(a, "2026-10-27", { sentadilla: [97.5, 5, 2, 3] }, 7, 50);
    await session(a, "2026-10-29", { sentadilla: [95, 5, 2, 3] }, 7, 50);
    const s = await getLoadStatus(a, "2026-10-30", db);
    expect(s.signals.e1rmDropping.map((x) => x.name)).toEqual(["Sentadilla"]);
    const [first, second, third] = s.signals.e1rmDropping[0].e1rm; // de la más antigua a la más reciente
    expect([first, third]).toEqual([123.3, 117.2]);
    expect(second).toBeCloseTo(120.25, 1);
    expect(s.deload.signals.join(" ")).toContain("La fuerza cae dos sesiones seguidas");
  });

  it("sueño corto en 3 de 7 noches y dolor tendinoso > 5 son señales; juntas, descarga", async () => {
    // Atleta sin sesiones: solo cuentan estas dos señales.
    for (const [d, h] of [["2026-11-14", 6], ["2026-11-15", 8], ["2026-11-16", 6.5], ["2026-11-17", 7.5]] as const)
      await saveCheckin(empty, { date: d, sleepQuality: 6, sleepHours: h, stress: 4, motivation: 7, pain: 2, fatigue: 4 }, db);
    let s = await getLoadStatus(empty, "2026-11-18", db);
    expect(s.signals).toMatchObject({ shortSleepNights: 2, tendonPain: null });
    expect(s.deload.signals).toEqual([]);

    await saveCheckin(empty, { date: "2026-11-18", sleepQuality: 5, sleepHours: 5.5, stress: 4, motivation: 7, pain: 2, fatigue: 4 }, db);
    s = await getLoadStatus(empty, "2026-11-18", db);
    expect(s.signals.shortSleepNights).toBe(3);
    expect(s.deload).toMatchObject({ deload: false, signals: ["3 de las últimas 7 noches por debajo de 7 h"] });

    // Dolor de tobillo 6/10 (check-in, que también lo apunta en la lesión): segunda señal.
    await saveCheckin(empty, { date: "2026-11-18", sleepQuality: 5, sleepHours: 5.5, stress: 4, motivation: 7, pain: 2, fatigue: 4, anklePain: 6 }, db);
    s = await getLoadStatus(empty, "2026-11-18", db);
    expect(s.signals.tendonPain).toBe(6);
    expect(s.deload.deload).toBe(true);
    expect(s.deload.signals).toContain("Dolor tendinoso de 6/10");
    // Con 5/10 no es señal (Pain-Monitoring Model: hasta 5 se puede cargar).
    await saveCheckin(empty, { date: "2026-11-18", sleepQuality: 5, sleepHours: 5.5, stress: 4, motivation: 7, pain: 2, fatigue: 4, anklePain: 5 }, db);
    await withUser(empty, (tx) => tx.query("update fit.injury_logs set pain = 5 where date = '2026-11-18'"), db);
    expect((await getLoadStatus(empty, "2026-11-18", db)).deload.deload).toBe(false);
  });

  it("el sueño del reloj cuenta cuando el check-in no trae horas, y el check-in manda si las trae", async () => {
    // Semana del 1 al 7 de diciembre sin check-ins: tres noches cortas medidas por el reloj.
    await withUser(empty, (tx) => tx.query(
      `insert into fit.daily_activity (date, sleep_minutes) values
         ('2026-12-01', 380), ('2026-12-02', 450), ('2026-12-03', 360), ('2026-12-04', 400)`), db);
    let s = await getLoadStatus(empty, "2026-12-05", db);
    expect(s.signals.shortSleepNights).toBe(3);
    // El 4 el check-in dice 7,5 h: manda sobre los 400 min del reloj.
    await saveCheckin(empty, { date: "2026-12-04", sleepQuality: 7, sleepHours: 7.5, stress: 3, motivation: 7, pain: 1, fatigue: 3 }, db);
    s = await getLoadStatus(empty, "2026-12-05", db);
    expect(s.signals.shortSleepNights).toBe(2);
  });
});

describe("volumen por grupo", () => {
  it("series efectivas fraccionales contra MEV y MRV", async () => {
    const v = await getVolumeStatus(a, { from: "2026-10-14", to: "2026-10-20" }, db);
    expect([v.days, v.microcycleId, v.unclassifiedSets]).toEqual([7, null, 0]);
    const by = Object.fromEntries(v.muscles.map((m) => [m.muscleId, m]));
    // Press banca: 4 al pectoral y 2 (0,5 por serie) al tríceps, que suma además 2 propias.
    expect(by.pectoral).toMatchObject({ sets: 4, setsPerWeek: 4, mev: 8, mrv: 20, status: "bajo_mev" });
    expect(by.triceps).toMatchObject({ sets: 4, setsPerWeek: 4, status: "bajo_mev" });
    expect(by.biceps).toMatchObject({ sets: 0, status: "bajo_mev", progressRate: null });
    expect(by.biceps.advice.action).toBe("mantener");
    // El press banca subió de 80 × 6 a 82,5 × 5 (e1RM 101,3 → 101,8): el grupo progresa.
    expect(by.pectoral.progressRate).toBe(1);
    expect(by.pectoral.advice.action).toBe("subir");
  });

  it("usa los objetivos propios del atleta y normaliza periodos que no son de 7 días", async () => {
    await setVolumeTarget(a, { muscleId: "pectoral", mev: 3, mrv: 10 }, db);
    const week = await getVolumeStatus(a, { from: "2026-10-14", to: "2026-10-20" }, db);
    expect(week.muscles.find((m) => m.muscleId === "pectoral")).toMatchObject({ mev: 3, mrv: 10, status: "en_rango" });
    const two = await getVolumeStatus(a, { from: "2026-10-07", to: "2026-10-20" }, db);
    expect(two.muscles.find((m) => m.muscleId === "pectoral")).toMatchObject({ sets: 4, setsPerWeek: 2, status: "bajo_mev" });
    await expect(getVolumeStatus(a, { from: "2026-10-20" }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });

  it("por microciclo: mide el rango de fechas del microciclo del plan", async () => {
    const template = { slug: "mini", name: "Mini", goal: "definicion", mesocycles: [{ name: "B1", microcycle_days: 14, microcycles_planned: 2,
      sessions: [{ name: "A", exercises: [{ exercise: "curl-biceps", sets: 3, rep_min: 8, rep_max: 12 }] }, { name: "Descanso", is_rest: true }] }] };
    const plan = await activateProgram(a, { slug: "mini", startDate: "2026-11-02" }, db, { template });
    await session(a, "2026-11-03", { "curl-biceps": [12, 10, 2, 4] }, 6, 40, plan.sessions[0].id);
    const v = await getVolumeStatus(a, { microcycleId: plan.microcycle.id }, db);
    expect([v.from, v.to, v.days]).toEqual(["2026-11-02", "2026-11-15", 14]);
    expect(v.muscles.find((m) => m.muscleId === "biceps")).toMatchObject({ sets: 4, setsPerWeek: 2 });
  });

  it("en déficit no sube series aunque el grupo progrese: se congelan en 12-16", async () => {
    const before = await getVolumeStatus(a, { from: "2026-10-14", to: "2026-10-20" }, db);
    expect(before.inDeficit).toBe(false);
    await withUser(a, (tx) => tx.query(
      `insert into fit.nutrition_targets (valid_from, phase, tdee, tdee_method, avg_kcal, on_kcal, on_protein_g, on_carbs_g, on_fat_g, off_kcal, off_protein_g, off_carbs_g, off_fat_g)
       values ('2026-10-01', 'deficit', 2700, 'medido', 2200, 2300, 180, 220, 70, 2160, 180, 185, 70)`), db);
    const v = await getVolumeStatus(a, { from: "2026-10-14", to: "2026-10-20" }, db);
    expect(v.inDeficit).toBe(true);
    const pec = v.muscles.find((m) => m.muscleId === "pectoral")!;
    // Pectoral (MEV propio 3): progresa el 100 % y fuera de déficit se proponía subir.
    expect(pec.progressRate).toBe(1);
    expect(pec.advice.action).toBe("mantener");
    expect(pec.advice.why).toMatch(/12-16/);
    await withUser(a, (tx) => tx.query("delete from fit.nutrition_targets"), db);
  });
});

describe("progreso", () => {
  it("serie de e1RM por sesión de un ejercicio", async () => {
    const [press] = await searchExercises(a, { q: "press banca" }, db);
    const s = await getE1rmSeries(a, press.id, db);
    expect(s.map((p) => [p.date, p.e1rm, p.confidence, p.kg, p.reps])).toEqual([
      ["2026-10-01", 101.33, "alta", 80, 6], ["2026-10-20", 101.75, "alta", 82.5, 5],
    ]);
  });

  it("peso con tendencia, levantamientos, ACWR diario, sesiones por semana y adherencia", async () => {
    for (let k = 0; k < 8; k++) await logBodyMetrics(a, { date: `2026-10-${String(1 + k * 4).padStart(2, "0")}`, weightKg: 93 - k * 0.4, waistCm: k % 4 === 0 ? 101 - k / 4 : undefined }, db);
    const p = await getProgress(a, { days: 45, to: "2026-11-08" }, db);
    expect([p.from, p.to]).toEqual(["2026-09-25", "2026-11-08"]);

    expect(p.weight.series).toHaveLength(8);
    expect(p.weight.series[0]).toEqual({ date: "2026-10-01", kg: 93, trend: 93 });
    expect(p.weight.series[7].trend).toBeLessThan(93);
    expect(p.weight.series[7].trend).toBeGreaterThan(p.weight.series[7].kg); // la tendencia va por detrás del dato
    expect(p.weight.weeklyRatePct).toBeLessThan(0);
    expect(p.weight.change).toBeLessThan(0);
    expect(p.waist).toEqual({ series: [{ date: "2026-10-01", cm: 101 }, { date: "2026-10-17", cm: 100 }], change: -1 });

    expect(p.lifts.map((l) => [l.name, l.sessions])).toEqual([["Sentadilla", 3], ["Curl de bíceps", 2], ["Press banca", 2], ["Extensión de tríceps", 1]]);
    expect(p.lifts[0].series.map((x) => x.e1rm)).toEqual([123.33, 120.25, 117.17]);
    expect(p.lifts[0].changePct).toBe(-5);

    expect(p.acwr[0]).toMatchObject({ date: "2026-10-01", acute: 420, chronic: 420, ratio: null });
    expect(p.acwr[p.acwr.length - 1].date).toBe("2026-11-08");
    expect(p.acwr).toHaveLength(39);
    expect(p.acwr.find((x) => x.date === "2026-10-02")).toMatchObject({ acute: 315, ratio: null }); // día vacío: la aguda cae
    expect(p.acwr.find((x) => x.date === "2026-10-21")?.ratio).not.toBeNull();

    expect(p.sessionsPerWeek).toEqual([
      { weekStart: "2026-09-21", done: 0 }, { weekStart: "2026-09-28", done: 2 }, { weekStart: "2026-10-05", done: 0 }, { weekStart: "2026-10-12", done: 0 },
      { weekStart: "2026-10-19", done: 1 }, { weekStart: "2026-10-26", done: 2 }, { weekStart: "2026-11-02", done: 1 },
    ]);
    // Plan activo: 1 sesión por microciclo de 14 días; han pasado 7 → prevista media sesión, hecha 1.
    expect(p.adherence).toEqual({ done: 1, planned: 0.5, pct: 100 });
  });

  it("sin plan no hay adherencia", async () => {
    const p = await getProgress(empty, { days: 30, to: "2026-11-08" }, db);
    expect(p).toMatchObject({ adherence: null, lifts: [], acwr: [], weight: { series: [], weeklyRatePct: null, current: null } });
  });
});
