/**
 * «Hoy»: una sola llamada con todo lo que necesitan la pantalla de inicio y Muse.
 * Solo lee. Cada bloque se calcula por separado y, si falla o no hay datos, sale `null`: nunca lanza por falta de datos
 * (solo si el atleta no existe). Los cálculos son de los servicios y del motor; aquí se resume y se decide `nextAction`.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import {
  bestE1RM, readinessBand, roundToStep, suggestNext, weeklyRatePct, weightTrend,
  type AcwrZone, type Prescription, type ProgressionRule, type ReadinessBand, type SetLog, type StressBand,
} from "@/engine";
import { addDays, diffDays, todayIn } from "@/server/time";
import { listAnnotations, localTimeIn } from "./annotations";
import { getLoadStatus } from "./analytics";
import { IsoDate, ankleStatusTx, getAnkleStatus, getAthleteTx, getOnboardingStatus, parseInput, type OnboardingField } from "./athlete";
import { getCardioWeek } from "./cardio";
import { alternativesIn, loadLibraryTx } from "./library";
import { getNutritionDay, type DayType, type Macros, type NutritionPhase } from "./nutrition";
import { activePlanTx, nextSessionTx, type NextSession, type PrescriptionView } from "./plan";
import { getWorkoutView, historyTx, type NextSet } from "./training";
import { getCheckin } from "./wellness";

/* ───────────────────────── Entrada ───────────────────────── */

export const GetTodayInput = z.object({
  date: IsoDate.optional().describe("Día a consultar (AAAA-MM-DD). Por defecto, hoy en la zona horaria del atleta"),
});
export type GetTodayInput = z.input<typeof GetTodayInput>;

/* ───────────────────────── Tipos ───────────────────────── */

export type TodayHref = "/onboarding" | "/bienestar" | "/progreso" | "/entreno" | "/nutricion" | "/cardio";

export type TodayNextAction = {
  kind: "onboarding" | "checkin" | "pesaje" | "continuar_sesion" | "empezar_sesion" | "cardio" | "descanso" | "comida" | "nada";
  /** Frase corta para el botón: la única cosa que toca ahora. */
  label: string;
  /** Una línea con el porqué o el detalle. */
  detail: string;
  href: TodayHref;
};

export type TodaySuggestion = {
  rule: ProgressionRule;
  kg: number | null;
  sets: number;
  repsTarget: number[];
  rirTarget: number;
  why: string;
  stalled: boolean;
};

export type TodayExercise = {
  position: number;
  exerciseId: string;
  slug: string;
  name: string;
  primaryMuscle: string | null;
  kind: string;
  /** Pauta del plan. */
  sets: number;
  repMin: number | null;
  repMax: number | null;
  rirTarget: number | null;
  restSeconds: number | null;
  technique: string | null;
  notes: string | null;
  /** Sugerencia de hoy (carga, repeticiones objetivo, RIR, regla y porqué). Null en cardio o pautas sin series. */
  suggestion: TodaySuggestion | null;
  loadCap: { pct: number; kg: number | null; reason: "tobillo" | "plan" } | null;
  ankleWarning: string | null;
  lastSession: { date: string; sets: SetLog[] } | null;
  /** Series efectivas ya hechas hoy (solo con la sesión en curso). */
  setsDone: number;
  done: boolean;
};

export type TodayPlan = {
  macrocycle: { id: string; name: string; goal: string; startDate: string; endDate: string | null };
  mesocycle: { id: string; name: string; blockType: string; position: number; of: number };
  microcycle: {
    id: string; position: number; of: number; startDate: string; endDate: string; lengthDays: number;
    /** Día del microciclo en el que cae la fecha (1 = el primero). */
    day: number; isDeload: boolean; sessionsDone: number; sessionsPlanned: number;
  };
  /** La rueda del microciclo, en orden. `doneOn`: día en que se hizo en este microciclo. */
  sessions: { id: string; position: number; name: string; isRest: boolean; isCardio: boolean; plannedMinutes: number | null; doneOn: string | null }[];
};

export type TodayTraining = {
  plan: TodayPlan | null;
  isDeload: boolean;
  /** Qué es hoy según la rueda: entreno, cardio, descanso, hecho (ya se entrenó) o sin_plan. */
  todayKind: "entreno" | "cardio" | "descanso" | "hecho" | "sin_plan";
  next: {
    reason: NextSession["reason"];
    sessionTemplateId: string;
    name: string;
    focus: string | null;
    isCardio: boolean;
    plannedMinutes: number | null;
    /** Días de descanso de la rueda entre la última sesión hecha y esta. */
    restBetween: number;
    lastDone: { name: string; date: string } | null;
    exercises: TodayExercise[];
  } | null;
  inProgress: {
    workoutId: string; name: string | null; date: string; startedAt: string | null; sessionTemplateId: string | null;
    setsDone: number; hardSets: number; exercisesDone: number; exercisesTotal: number; next: NextSet | null;
  } | null;
  trainedToday: boolean;
  doneToday: { workoutId: string; name: string | null; hardSets: number | null; tonnage: number | null; srpe: number | null; durationMin: number | null }[];
};

export type TodayView = {
  date: string;
  /** Día de la semana en español, en minúsculas. */
  weekday: string;
  /** La fecha consultada es el día de hoy del atleta. */
  isToday: boolean;
  athlete: { name: string | null; onboardingComplete: boolean; missing: { field: OnboardingField; question: string }[] };
  checkin: { readiness: number | null; band: ReadinessBand | null; label: string | null } | null;
  needsCheckin: boolean;
  ankle: {
    pain: number | null; painDate: string | null; restricted: boolean; impactAllowed: boolean; squatCapPct: number | null;
    dropTopSet: boolean; z2Modes: string[]; notes: string[];
  } | null;
  training: TodayTraining | null;
  nutrition: {
    dayType: DayType; dayTypeAssumed: boolean; phase: NutritionPhase | null; target: Macros | null; totals: Macros; remaining: Macros | null;
    proteinPct: number | null; items: number;
    caffeine: { todayMg: number; maxMg: number | null; cutoff: string | null; lateDoses: number };
  } | null;
  activity: {
    steps: { done: number | null; goal: number | null };
    z2: { minutes: number; targetMin: number; remainingMin: number };
    cardioSessionsWeek: number;
    cardioToday: boolean;
  } | null;
  load: {
    acwr: { ratio: number | null; zone: AcwrZone | null; reliable: boolean; label: string };
    stress: { max: number | null; top: { muscleId: string; name: string; value: number; band: StressBand }[] };
    deload: { deload: boolean; signals: string[]; plan: string | null; maintenance: boolean };
  } | null;
  weight: {
    lastKg: number | null; lastDate: string | null;
    /** Media móvil del peso (lo que cuenta, no la pesada suelta). */
    trendKg: number | null;
    /** % del peso por semana con la tendencia de 14 días (negativo = bajando). */
    weeklyRatePct: number | null;
    goalKg: number | null; toGoalKg: number | null; daysSinceWeighIn: number | null;
  } | null;
  annotations: { id: string; date: string; scope: string; severity: string; title: string; body: string | null }[];
  nextAction: TodayNextAction;
};

/* ───────────────────────── Ayudantes ───────────────────────── */

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const esNum = (n: number) => String(round1(n)).replace(".", ",");

/** Un bloque que falla no tumba la vista: sale null. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error("[today] bloque sin datos:", e instanceof Error ? e.message : "error desconocido");
    return null;
  }
}

/* ───────────────────────── Entreno ───────────────────────── */

type ExerciseExtra = { id: string; loadStep: number; best: number | null };

/** Misma lectura de la pauta que hace el registro de entreno al abrir la sesión. */
function prescriptionOf(p: PrescriptionView, step: number): Prescription | null {
  if (p.exercise.kind === "cardio" || !p.sets) return null;
  const repMin = p.repMin ?? p.repMax ?? 8;
  return {
    sets: p.sets, repMin, repMax: Math.max(repMin, p.repMax ?? p.repMin ?? 12), rirTarget: p.rirTarget ?? 2,
    step: step > 0 ? step : 2.5, kind: p.exercise.kind === "compuesto" ? "compuesto" : "aislamiento",
  };
}

/** Sugerencias de la sesión que toca, sin abrirla: historial + motor. No escribe nada. */
async function previewExercisesTx(tx: Tx, date: string, next: NextSession, readiness: number | null): Promise<TodayExercise[]> {
  const seen = new Set<string>();
  const list = (next.session?.prescriptions ?? []).filter((p) => !seen.has(p.exerciseId) && seen.add(p.exerciseId));
  if (!list.length) return [];
  const ids = list.map((p) => p.exerciseId);
  const extra = new Map((await tx.query<ExerciseExtra>(
    `select e.id, e.load_step as "loadStep",
       (select max(s.e1rm) from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
         where s.exercise_id = e.id and s.e1rm is not null and s.e1rm_confidence in ('alta', 'media') and w.status <> 'saltada') as best
     from fit.exercises e where e.id = any($1::uuid[])`, [ids])).map((r) => [r.id, r]));
  const history = await historyTx(tx, ids, { upTo: date });
  const ankle = await ankleStatusTx(tx, date);
  const flaggedAny = ankle.rule.restricted && list.some((p) => p.exercise.ankleLoad === "alta");
  const lib = flaggedAny ? await loadLibraryTx(tx) : [];

  return list.map((p, k): TodayExercise => {
    const x = extra.get(p.exerciseId);
    const past = history.get(p.exerciseId) ?? [];
    const rx = prescriptionOf(p, x?.loadStep ?? 2.5);
    let suggestion: TodaySuggestion | null = rx ? suggestNext(past, rx, { readiness, deload: next.isDeload }) : null;

    const flagged = ankle.rule.restricted && p.exercise.ankleLoad === "alta";
    const ankleCap = flagged ? ankle.rule.squatCapPct ?? 75 : null;
    const capPct = Math.min(p.loadCapPct ?? 100, ankleCap ?? 100);
    let loadCap: TodayExercise["loadCap"] = null;
    if (capPct < 100) {
      const recent = Math.max(0, ...past.map((s) => bestE1RM(s.sets)?.value ?? 0)) || x?.best || 0;
      const kg = recent > 0 ? roundToStep((recent * capPct) / 100, rx?.step ?? 2.5, "down") : null;
      const reason = ankleCap != null && ankleCap <= (p.loadCapPct ?? 100) ? "tobillo" : "plan";
      loadCap = { pct: capPct, kg, reason };
      if (suggestion && suggestion.kg != null && kg != null && suggestion.kg > kg)
        suggestion = { ...suggestion, kg, why: `${suggestion.why} Tope del ${capPct} % ${reason === "tobillo" ? "por el tobillo" : "del plan"}: ${esNum(kg)} kg.` };
    }
    // Si dolió al día siguiente de la última pierna, el ejercicio que carga el tobillo pierde una serie (mínimo 1): sin top set.
    if (flagged && ankle.rule.dropTopSet && suggestion) {
      const sets = Math.max(1, suggestion.sets - 1);
      suggestion = { ...suggestion, sets, repsTarget: suggestion.repsTarget.slice(0, sets),
        why: `${suggestion.why} Tobillo: dolió al día siguiente de la última pierna, hoy sin top set.` };
    }
    let ankleWarning: string | null = null;
    if (flagged) {
      const me = lib.find((e) => e.id === p.exerciseId);
      const alt = me ? alternativesIn(lib, me, { ankleSafe: true, limit: 1 })[0] : undefined;
      ankleWarning = `Tobillo con dolor ${ankle.pain ?? 0}/10: ${p.exercise.name} carga el tobillo. ` +
        `${alt ? `Cámbialo por ${alt.name} o no pases` : "No pases"} del ${ankleCap} % de tu 1RM${loadCap?.kg != null ? ` (${esNum(loadCap.kg)} kg)` : ""}.` +
        `${ankle.rule.dropTopSet ? " Hoy sin top set." : ""}`;
    }
    return {
      position: k + 1, exerciseId: p.exerciseId, slug: p.exercise.slug, name: p.exercise.name, primaryMuscle: p.exercise.primaryMuscle,
      kind: p.exercise.kind, sets: p.sets, repMin: p.repMin, repMax: p.repMax, rirTarget: p.rirTarget, restSeconds: p.restSeconds,
      technique: p.technique, notes: p.notes, suggestion, loadCap, ankleWarning,
      lastSession: past[0] ? { date: past[0].date, sets: past[0].sets } : null, setsDone: 0, done: false,
    };
  });
}

type TrainingCore = {
  plan: TodayPlan | null;
  next: NextSession;
  preview: TodayExercise[];
  open: { id: string; date: string; sessionTemplateId: string | null } | null;
  doneToday: TodayTraining["doneToday"];
  strengthDoneToday: boolean;
};

async function trainingCoreTx(tx: Tx, date: string): Promise<TrainingCore> {
  const active = await activePlanTx(tx, date);
  const next = await nextSessionTx(tx, date);
  const [chk] = await tx.query<{ readiness: number | null }>("select readiness from fit.checkins where date = $1", [date]);

  let plan: TodayPlan | null = null;
  if (active) {
    const doneRows = await tx.query<{ sessionTemplateId: string | null; date: string }>(
      `select session_template_id as "sessionTemplateId", date from fit.workouts where status = 'hecha' and microcycle_id = $1 order by date`,
      [active.microcycle.id]);
    const doneOn = new Map(doneRows.filter((r) => r.sessionTemplateId).map((r) => [r.sessionTemplateId!, r.date]));
    const { macrocycle: ma, mesocycle: me, microcycle: mi } = active;
    plan = {
      macrocycle: { id: ma.id, name: ma.name, goal: ma.goal, startDate: ma.startDate, endDate: ma.endDate },
      mesocycle: { id: me.id, name: me.name, blockType: me.blockType, position: me.position, of: active.mesocycles.length },
      microcycle: {
        id: mi.id, position: mi.position, of: active.microcycles.length, startDate: mi.startDate, endDate: mi.endDate, lengthDays: mi.lengthDays,
        day: next.dayOfMicrocycle ?? 1, isDeload: mi.isDeload, sessionsDone: next.doneInMicrocycle, sessionsPlanned: next.plannedInMicrocycle,
      },
      sessions: active.sessions.map((s) => ({
        id: s.id, position: s.position, name: s.name, isRest: s.isRest, isCardio: s.isCardio, plannedMinutes: s.plannedMinutes,
        doneOn: doneOn.get(s.id) ?? null,
      })),
    };
  }

  const [open] = await tx.query<{ id: string; date: string; sessionTemplateId: string | null }>(
    `select id, date, session_template_id as "sessionTemplateId" from fit.workouts
     where status = 'en_curso' and date <= $1 and date >= $2 order by date desc, created_at desc limit 1`, [date, addDays(date, -1)]);
  const doneToday = await tx.query<TodayTraining["doneToday"][number] & { isCardio: boolean }>(
    `select w.id as "workoutId", w.name, w.hard_sets as "hardSets", w.tonnage, w.srpe, w.duration_min as "durationMin",
       coalesce(st.is_cardio, false) as "isCardio"
     from fit.workouts w left join fit.session_templates st on st.id = w.session_template_id
     where w.status = 'hecha' and w.date = $1 order by w.created_at`, [date]);

  // Con la sesión del plan ya abierta, las sugerencias salen de su vista (más abajo); si no, se calculan aquí sin escribir.
  const preview = next.session && next.reason !== "en_curso" ? await previewExercisesTx(tx, date, next, chk?.readiness ?? null) : [];
  return {
    plan, next, preview, open: open ?? null,
    doneToday: doneToday.map((d) => ({ workoutId: d.workoutId, name: d.name, hardSets: d.hardSets, tonnage: d.tonnage, srpe: d.srpe, durationMin: d.durationMin })),
    strengthDoneToday: doneToday.some((d) => !d.isCardio),
  };
}

async function buildTraining(userId: string, date: string, db?: Db): Promise<TodayTraining> {
  const core = await withUser(userId, (tx) => trainingCoreTx(tx, date), db);
  const { next } = core;
  const view = core.open ? await safe(() => getWorkoutView(userId, core.open!.id, db)) : null;

  let exercises = core.preview;
  if (view && next.reason === "en_curso" && view.workout.id === next.workoutId)
    exercises = view.exercises.map((b): TodayExercise => ({
      position: b.position, exerciseId: b.exercise.id, slug: b.exercise.slug, name: b.exercise.name, primaryMuscle: b.exercise.primaryMuscle,
      kind: b.exercise.kind, sets: b.prescription?.sets ?? b.suggestion?.sets ?? 0, repMin: b.prescription?.repMin ?? null,
      repMax: b.prescription?.repMax ?? null, rirTarget: b.prescription?.rirTarget ?? null, restSeconds: b.prescription?.restSeconds ?? null,
      technique: b.prescription?.technique ?? null, notes: b.prescription?.notes ?? null,
      suggestion: b.suggestion ? { rule: b.suggestion.rule, kg: b.suggestion.kg, sets: b.suggestion.sets, repsTarget: b.suggestion.repsTarget,
        rirTarget: b.suggestion.rirTarget, why: b.suggestion.why, stalled: b.suggestion.stalled } : null,
      loadCap: b.loadCap, ankleWarning: b.ankleWarning?.message ?? null, lastSession: b.lastSession, setsDone: b.workingSetsDone, done: b.done,
    }));

  const trainedToday = core.doneToday.length > 0;
  let todayKind: TodayTraining["todayKind"];
  if (!core.plan || !next.session) todayKind = core.strengthDoneToday ? "hecho" : "sin_plan";
  else if (next.reason === "en_curso") todayKind = next.session.isCardio ? "cardio" : "entreno";
  else if (trainedToday) todayKind = "hecho";
  // La rueda tiene descansos escritos entre la última sesión y la siguiente, y aún no han pasado.
  else if (next.lastDone && next.restBetween > 0 && diffDays(next.lastDone.date, date) <= next.restBetween) todayKind = "descanso";
  else todayKind = next.session.isCardio ? "cardio" : "entreno";

  return {
    plan: core.plan,
    isDeload: next.isDeload,
    todayKind,
    next: next.session ? {
      reason: next.reason, sessionTemplateId: next.session.id, name: next.session.name, focus: next.session.focus, isCardio: next.session.isCardio,
      plannedMinutes: next.session.plannedMinutes, restBetween: next.restBetween,
      lastDone: next.lastDone ? { name: next.lastDone.name, date: next.lastDone.date } : null, exercises,
    } : null,
    inProgress: view ? {
      workoutId: view.workout.id, name: view.workout.name, date: view.workout.date, startedAt: view.workout.startedAt,
      sessionTemplateId: view.workout.sessionTemplateId, setsDone: view.totals.sets, hardSets: view.totals.hardSets,
      exercisesDone: view.exercises.filter((b) => b.done).length, exercisesTotal: view.exercises.length, next: view.next,
    } : null,
    trainedToday,
    doneToday: core.doneToday,
  };
}

/* ───────────────────────── Peso y pasos ───────────────────────── */

async function weightTx(tx: Tx, date: string, goalKg: number | null): Promise<NonNullable<TodayView["weight"]>> {
  const points = await tx.query<{ date: string; kg: number }>(
    "select date, weight_kg as kg from fit.body_metrics where weight_kg is not null and date > $1 and date <= $2 order by date", [addDays(date, -60), date]);
  let last = points[points.length - 1] ?? null;
  if (!last)
    last = (await tx.query<{ date: string; kg: number }>(
      "select date, weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1 order by date desc limit 1", [date]))[0] ?? null;
  const trend = weightTrend(points);
  const trendKg = trend.length ? round2(trend[trend.length - 1].trend) : last?.kg ?? null;
  return {
    lastKg: last?.kg ?? null, lastDate: last?.date ?? null, trendKg, weeklyRatePct: weeklyRatePct(points), goalKg,
    toGoalKg: goalKg != null && trendKg != null ? round1(trendKg - goalKg) : null,
    daysSinceWeighIn: last ? diffDays(last.date, date) : null,
  };
}

/* ───────────────────────── Qué toca ahora ───────────────────────── */

function z2Label(rx: TodayExercise | undefined, minutes: number | null): string {
  const range = rx?.repMin != null ? (rx.repMax != null && rx.repMax !== rx.repMin ? `${rx.repMin}-${rx.repMax}` : `${rx.repMin}`) : minutes != null ? `${minutes}` : "35-45";
  return `Z2 en bici, ${range} min`;
}

function decideNextAction(v: Omit<TodayView, "nextAction">, localTime: string): TodayNextAction {
  if (!v.athlete.onboardingComplete) {
    const first = v.athlete.missing[0];
    return { kind: "onboarding", label: "Completa tu ficha", href: "/onboarding",
      detail: first ? `${first.question}${v.athlete.missing.length > 1 ? ` Y ${v.athlete.missing.length - 1} más.` : ""}` : "Faltan datos de la ficha." };
  }
  if (v.needsCheckin)
    return { kind: "checkin", label: "Haz el check-in de hoy", href: "/bienestar",
      detail: "Sueño, estrés, ganas, dolor y fatiga: 30 segundos. Con eso se ajustan las cargas de hoy." };
  if (v.weight && (v.weight.daysSinceWeighIn == null || v.weight.daysSinceWeighIn >= 2))
    return { kind: "pesaje", label: "Pésate", href: "/progreso",
      detail: v.weight.daysSinceWeighIn == null ? "Aún no hay ninguna pesada." : `Llevas ${v.weight.daysSinceWeighIn} días sin pesarte. En ayunas, al levantarte.` };

  const t = v.training;
  if (t?.inProgress) {
    const n = t.inProgress.next;
    return { kind: "continuar_sesion", label: `Continúa: ${t.inProgress.name ?? "sesión"}`, href: "/entreno",
      detail: n ? `Siguiente: ${n.exerciseName}, serie ${n.setNumber}${n.kg != null ? `, ${esNum(n.kg)} kg` : ""}${n.reps != null ? ` × ${n.reps}` : ""}.`
        : `${t.inProgress.setsDone} series hechas. Cierra la sesión con tu esfuerzo percibido.` };
  }
  if (t?.next && t.todayKind === "entreno") {
    if (v.checkin?.band === "z2")
      return { kind: "cardio", label: "Z2 suave o descanso", href: "/cardio",
        detail: `Readiness ${v.checkin.readiness}: hoy no se entrena pesado. ${t.next.name} se queda para mañana.` };
    const first = t.next.exercises.find((e) => e.suggestion);
    const load = first?.suggestion?.kg != null ? `${first.name} a ${esNum(first.suggestion.kg)} kg` : first ? `${first.name}, elige carga` : null;
    return { kind: "empezar_sesion", label: `Empieza: ${t.next.name}`, href: "/entreno",
      detail: `${t.next.exercises.length} ejercicios${t.isDeload ? ", semana de descarga" : ""}.${load ? ` Primero: ${load}.` : ""}` };
  }
  if (t?.next && t.todayKind === "cardio" && !v.activity?.cardioToday) {
    const z2 = t.next.exercises.find((e) => e.kind === "cardio");
    return { kind: "cardio", label: z2Label(z2, t.next.plannedMinutes), href: "/cardio",
      detail: `${t.next.name}. ${v.ankle?.restricted ? "El tobillo manda: bici o elíptica, sin impacto." : "Ritmo al que puedes hablar."}` };
  }
  if (t?.todayKind === "descanso") {
    const s = v.activity?.steps;
    if (!s || s.goal == null || (s.done ?? 0) < s.goal)
      return { kind: "descanso", label: "Descanso: pasos", href: "/cardio",
        detail: s?.goal != null ? `Hoy no hay pesas. Objetivo: ${s.goal.toLocaleString("es-ES")} pasos${s.done != null ? ` (llevas ${s.done.toLocaleString("es-ES")})` : ""}.` : "Hoy no hay pesas. Camina." };
  }
  const n = v.nutrition;
  if (v.isToday && n?.target && n.target.proteinG > 0 && n.remaining && n.remaining.proteinG > n.target.proteinG * 0.4 && localTime >= "15:00")
    return { kind: "comida", label: "Registra lo que has comido", href: "/nutricion",
      detail: `Te quedan ${Math.round(n.remaining.proteinG)} g de proteína de ${Math.round(n.target.proteinG)} y son las ${localTime}.` };
  return { kind: "nada", label: "Todo al día", href: "/progreso", detail: "No hay nada pendiente ahora mismo." };
}

/* ───────────────────────── getToday ───────────────────────── */

export type GetTodayOptions = {
  /** Instante de referencia para «son más de las 15:00» (tests). Por defecto, ahora. */
  now?: Date;
};

export async function getToday(userId: string, input: GetTodayInput = {}, db?: Db, opts: GetTodayOptions = {}): Promise<TodayView> {
  const i = parseInput(GetTodayInput, input ?? {});
  const now = opts.now ?? new Date();
  const athlete = await withUser(userId, getAthleteTx, db);
  const today = todayIn(athlete.timezone, now);
  const date = i.date ?? today;

  const [onboarding, checkinRow, ankle, training, nutrition, cardioWeek, load, body, notes] = await Promise.all([
    safe(() => getOnboardingStatus(userId, undefined, db)),
    safe(() => getCheckin(userId, date, db)),
    safe(() => getAnkleStatus(userId, date, db)),
    safe(() => buildTraining(userId, date, db)),
    safe(() => getNutritionDay(userId, { date }, db)),
    safe(() => getCardioWeek(userId, { weekStart: date }, db)),
    safe(() => getLoadStatus(userId, date, db)),
    safe(() => withUser(userId, async (tx) => ({
      weight: await weightTx(tx, date, athlete.goalWeightKg),
      steps: (await tx.query<{ steps: number | null }>("select steps from fit.daily_activity where date = $1", [date]))[0]?.steps ?? null,
    }), db)),
    safe(() => listAnnotations(userId, { days: 30 }, db)),
  ]);

  const band = checkinRow?.readiness != null ? readinessBand(checkinRow.readiness) : null;
  const view: Omit<TodayView, "nextAction"> = {
    date,
    weekday: WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()],
    isToday: date === today,
    athlete: {
      name: athlete.name,
      onboardingComplete: onboarding?.complete ?? false,
      missing: (onboarding?.missing ?? []).map((m) => ({ field: m.field, question: m.question })),
    },
    checkin: checkinRow ? { readiness: checkinRow.readiness, band: band?.band ?? null, label: band?.label ?? null } : null,
    needsCheckin: !checkinRow,
    ankle: ankle ? {
      pain: ankle.pain, painDate: ankle.painDate, restricted: ankle.rule.restricted, impactAllowed: ankle.rule.impactAllowed,
      squatCapPct: ankle.rule.squatCapPct, dropTopSet: ankle.rule.dropTopSet, z2Modes: ankle.rule.z2Modes, notes: ankle.rule.notes,
    } : null,
    training,
    nutrition: nutrition ? {
      dayType: nutrition.dayType, dayTypeAssumed: nutrition.dayTypeAssumed, phase: nutrition.phase, target: nutrition.target, totals: nutrition.totals,
      remaining: nutrition.remaining, proteinPct: nutrition.proteinPct, items: nutrition.logs.length,
      caffeine: { todayMg: nutrition.caffeine.todayMg, maxMg: nutrition.caffeine.maxMg, cutoff: nutrition.caffeine.cutoff, lateDoses: nutrition.caffeine.lateDoses },
    } : null,
    activity: cardioWeek || nutrition || body ? {
      steps: { done: nutrition?.steps.done ?? body?.steps ?? null, goal: nutrition?.steps.goal ?? athlete.stepsGoal ?? null },
      z2: { minutes: cardioWeek?.z2.minutes ?? 0, targetMin: cardioWeek?.z2.targetMin ?? 150, remainingMin: cardioWeek?.z2.remainingMin ?? 150 },
      cardioSessionsWeek: cardioWeek?.sessionCount ?? 0,
      cardioToday: cardioWeek?.sessions.some((s) => s.date === date) ?? false,
    } : null,
    load: load ? {
      acwr: { ratio: load.acwr.ratio, zone: load.acwr.zone, reliable: load.acwr.reliable, label: load.acwr.label },
      stress: {
        max: load.signals.maxWeeklyStress,
        top: load.muscleStress.slice(0, 3).map((m) => ({ muscleId: m.muscleId, name: m.name, value: round1(m.value), band: m.band })),
      },
      deload: load.deload,
    } : null,
    weight: body?.weight ?? null,
    annotations: (notes ?? []).slice(0, 5).map((a) => ({ id: a.id, date: a.date, scope: a.scope, severity: a.severity, title: a.title, body: a.body })),
  };
  return { ...view, nextAction: decideNextAction(view, localTimeIn(athlete.timezone, now)) };
}
