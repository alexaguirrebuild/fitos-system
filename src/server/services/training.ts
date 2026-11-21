/**
 * Registro de entreno: sesión, series, sugerencia del día, cierre con anotaciones automáticas e historial.
 * Las fórmulas vienen de src/engine; aquí solo se leen datos, se llama al motor y se guarda.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { AppError, invalid, notFound } from "@/server/errors";
import {
  bestE1RM, effectiveReps, estimate1RM, hardSetsByMuscle, isHardSet, junkSetsInSession, linearRegression, platesPerSide,
  readinessBand, roundToStep, suggestNext, tonnage, warmupLadder, SESSION_CAP,
  type Confidence, type PastSession, type Prescription, type ProgressionRule, type SetLog,
} from "@/engine";
import { IsoDateTime } from "./annotations";
import { IsoDate, Uuid, ankleStatusTx, dateOrToday, isoTs, parseInput, type AnkleStatus } from "./athlete";
import {
  EQUIPMENT_TYPES, EXERCISE_COLS, alternativesIn, createExerciseTx, getExerciseTx, loadLibraryTx, normalizeText, resolveIn, type Exercise,
} from "./library";
import { inDeficitTx } from "./nutrition";
import { prescriptionsForTx } from "./plan";

/* ───────────────────────── Tipos ───────────────────────── */

export const SET_TYPES = ["normal", "aproximacion", "top", "backoff", "dropset", "myo", "rest_pause", "amrap", "parcial", "cluster"] as const;
export type SetType = (typeof SET_TYPES)[number];

export type Workout = {
  id: string;
  date: string;
  name: string | null;
  status: "en_curso" | "hecha" | "saltada";
  sessionTemplateId: string | null;
  microcycleId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  srpe: number | null;
  durationMin: number | null;
  /** sRPE × minutos. */
  load: number | null;
  tonnage: number | null;
  hardSets: number | null;
  readinessBefore: number | null;
  recoveryAfter: number | null;
  satisfaction: number | null;
  caffeineMg: number | null;
  kneeSleeves: boolean;
  belt: boolean;
  straps: boolean;
  notes: string | null;
};

export type SetView = {
  id: string;
  workoutId: string;
  exerciseId: string | null;
  rawName: string | null;
  exercisePosition: number;
  setIndex: number;
  setType: SetType;
  kg: number | null;
  reps: number | null;
  rir: number | null;
  kgTarget: number | null;
  repsTarget: number | null;
  rirTarget: number | null;
  perSide: boolean;
  restSeconds: number | null;
  e1rm: number | null;
  e1rmConfidence: Confidence | null;
  effectiveReps: number | null;
  ruleApplied: string | null;
  note: string | null;
  doneAt: string | null;
  /** Equipo que se usó ese día (libre, multipower, polea…). Null si no se anotó. */
  equipmentType: string | null;
};

export type BlockPrescription = {
  id: string;
  sets: number;
  repMin: number | null;
  repMax: number | null;
  rirTarget: number | null;
  restSeconds: number | null;
  tempo: string | null;
  technique: string | null;
  warmupKind: "no" | "reducido" | "completo" | null;
  loadCapPct: number | null;
  notes: string | null;
};

export type SuggestionView = {
  rule: ProgressionRule;
  kg: number | null;
  sets: number;
  repsTarget: number[];
  rirTarget: number;
  why: string;
  stalled: boolean;
  /** El ejercicio no está en el plan: se usa una pauta por defecto (3 × 8-12, RIR 2). */
  defaultRx: boolean;
};

export type NextSet = {
  exerciseId: string;
  exerciseName: string;
  /** Número de serie efectiva que toca (1 = la primera). */
  setNumber: number;
  kg: number | null;
  reps: number | null;
  rir: number | null;
  restSeconds: number;
};

export type ExerciseBlock = {
  position: number;
  origin: "plan" | "manual" | "cambio";
  exercise: Exercise;
  replaces: { id: string; name: string } | null;
  prescription: BlockPrescription | null;
  suggestion: SuggestionView | null;
  warmup: { kg: number; reps: number }[];
  /** Discos por lado, solo en ejercicios de barra. */
  plates: { plates: number[]; perSide: number; exact: boolean } | null;
  lastSession: { date: string; sets: SetLog[] } | null;
  bestE1rm: { value: number; confidence: Confidence; date: string; kg: number | null; reps: number | null } | null;
  loadCap: { pct: number; kg: number | null; reason: "tobillo" | "plan" } | null;
  ankleWarning: { message: string; loadCapPct: number; alternative: { id: string; slug: string; name: string } | null } | null;
  sets: SetView[];
  workingSetsDone: number;
  done: boolean;
  next: NextSet | null;
};

export type WorkoutTotals = {
  tonnage: number;
  /** Series sin contar aproximaciones. */
  sets: number;
  /** Series efectivas (a 3 o menos del fallo). */
  hardSets: number;
  /** Series efectivas por grupo: 1 al principal, 0,5 a cada sinergista. */
  byMuscle: Record<string, number>;
};

export type WorkoutView = {
  workout: Workout;
  readiness: number | null;
  readinessLabel: string | null;
  deload: boolean;
  ankle: AnkleStatus;
  exercises: ExerciseBlock[];
  /** Series sin ejercicio de la librería (histórico importado). */
  unmatchedSets: SetView[];
  totals: WorkoutTotals;
  next: NextSet | null;
};

/* ───────────────────────── SQL común ───────────────────────── */

const WORKOUT_COLS = `w.id, w.date, w.name, w.status, w.session_template_id as "sessionTemplateId", w.microcycle_id as "microcycleId",
  ${isoTs("w.started_at")} as "startedAt", ${isoTs("w.ended_at")} as "endedAt", w.srpe, w.duration_min as "durationMin", w.load,
  w.tonnage, w.hard_sets as "hardSets", w.readiness_before as "readinessBefore", w.recovery_after as "recoveryAfter",
  w.satisfaction, w.caffeine_mg as "caffeineMg", w.knee_sleeves as "kneeSleeves", w.belt, w.straps, w.notes`;

const SET_COLS = `s.id, s.workout_id as "workoutId", s.exercise_id as "exerciseId", s.exercise_name_raw as "rawName",
  s.exercise_position as "exercisePosition", s.set_index as "setIndex", s.set_type as "setType", s.kg, s.reps, s.rir,
  s.kg_target as "kgTarget", s.reps_target as "repsTarget", s.rir_target as "rirTarget", s.per_side as "perSide",
  s.rest_seconds as "restSeconds", s.e1rm, s.e1rm_confidence as "e1rmConfidence", s.effective_reps as "effectiveReps",
  s.rule_applied as "ruleApplied", s.note, ${isoTs("s.done_at")} as "doneAt", s.equipment_type as "equipmentType"`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Número con coma decimal y como mucho un decimal. */
const es = (n: number) => String(round1(n)).replace(".", ",");
const isWorking = (s: { setType: string; kg: number | null; reps: number | null }) =>
  s.setType !== "aproximacion" && s.kg != null && s.reps != null && s.reps > 0;
const asLog = (s: { kg: number | null; reps: number | null; rir: number | null }): SetLog => ({ kg: s.kg ?? 0, reps: s.reps ?? 0, rir: s.rir });

async function getWorkoutTx(tx: Tx, id: string): Promise<Workout> {
  const r = await tx.query<Workout>(`select ${WORKOUT_COLS} from fit.workouts w where w.id = $1`, [id]);
  if (!r[0]) throw notFound("La sesión");
  return r[0];
}

/** e1RM, confianza y repeticiones efectivas de una serie, listas para guardar. Las aproximaciones no puntúan. */
function setMetrics(kg: number | null, reps: number | null, rir: number | null, setType: string) {
  if (setType === "aproximacion" || kg == null || reps == null) return { e1rm: null, confidence: null, effective: setType === "aproximacion" ? 0 : null };
  const e = estimate1RM({ kg, reps, rir });
  return { e1rm: e ? round2(e.value) : null, confidence: e?.confidence ?? null, effective: effectiveReps(reps, rir) };
}

/* ───────────────────────── Historial ───────────────────────── */

export type HistorySession = PastSession & { workoutId: string; kneeSleeves: boolean; belt: boolean; equipmentType: string | null };

/**
 * Últimas `sessions` sesiones hechas de cada ejercicio (de la más reciente a la más antigua), solo con series
 * que no son de aproximación.
 */
export async function historyTx(
  tx: Tx, exerciseIds: string[], o: { upTo: string; excludeWorkoutId?: string | null; sessions?: number },
): Promise<Map<string, HistorySession[]>> {
  const out = new Map<string, HistorySession[]>(exerciseIds.map((id) => [id, []]));
  if (!exerciseIds.length) return out;
  const rows = await tx.query<{ exerciseId: string; workoutId: string; date: string; kneeSleeves: boolean; belt: boolean; equipmentType: string | null; kg: number; reps: number; rir: number | null }>(
    `select x.* from (
       select s.exercise_id as "exerciseId", w.id as "workoutId", w.date, w.knee_sleeves as "kneeSleeves", w.belt, s.equipment_type as "equipmentType", s.kg, s.reps, s.rir,
              s.exercise_position, s.set_index,
              dense_rank() over (partition by s.exercise_id order by w.date desc, w.created_at desc, w.id) as rk
       from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
       where w.status = 'hecha' and s.exercise_id = any($1::uuid[]) and s.set_type <> 'aproximacion'
         and s.kg is not null and s.reps is not null and s.reps > 0 and w.date <= $2 and ($3::uuid is null or w.id <> $3)
     ) x where x.rk <= $4 order by x."exerciseId", x.rk, x.exercise_position, x.set_index`,
    [exerciseIds, o.upTo, o.excludeWorkoutId ?? null, o.sessions ?? 4]);
  for (const r of rows) {
    const list = out.get(r.exerciseId)!;
    let s = list[list.length - 1];
    if (!s || s.workoutId !== r.workoutId) {
      s = { workoutId: r.workoutId, date: r.date, kneeSleeves: r.kneeSleeves, belt: r.belt, equipmentType: null, sets: [] };
      list.push(s);
    }
    s.equipmentType ??= r.equipmentType;
    s.sets.push({ kg: r.kg, reps: r.reps, rir: r.rir });
  }
  return out;
}

type Best = NonNullable<ExerciseBlock["bestE1rm"]>;

async function bestE1rmTx(tx: Tx, exerciseIds: string[]): Promise<Map<string, Best>> {
  if (!exerciseIds.length) return new Map();
  const rows = await tx.query<Best & { exerciseId: string }>(
    `select distinct on (s.exercise_id) s.exercise_id as "exerciseId", s.e1rm as value, s.e1rm_confidence as confidence, w.date, s.kg, s.reps
     from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
     where s.exercise_id = any($1::uuid[]) and s.e1rm is not null and s.e1rm_confidence in ('alta', 'media') and w.status <> 'saltada'
     order by s.exercise_id, s.e1rm desc, w.date`, [exerciseIds]);
  return new Map(rows.map(({ exerciseId, ...b }) => [exerciseId, b]));
}

/* ───────────────────────── Vista de la sesión ───────────────────────── */

type EntryRow = Exercise & {
  position: number;
  origin: "plan" | "manual" | "cambio";
  replacesId: string | null;
  replacesName: string | null;
  rxId: string | null;
  rxSets: number | null;
  rxRepMin: number | null;
  rxRepMax: number | null;
  rxRir: number | null;
  rxRest: number | null;
  rxTempo: string | null;
  rxTechnique: string | null;
  rxWarmup: "no" | "reducido" | "completo" | null;
  rxCap: number | null;
  rxNotes: string | null;
};

const DEFAULT_RX = { sets: 3, repMin: 8, repMax: 12, rirTarget: 2 };

/** Pauta en el formato del motor. Null si el ejercicio no admite progresión de cargas (cardio o 0 series). */
function rxOf(e: EntryRow): { rx: Prescription; defaultRx: boolean } | null {
  if (e.kind === "cardio" || (e.rxId && !e.rxSets)) return null;
  const step = e.loadStep > 0 ? e.loadStep : 2.5;
  const kind = e.kind === "compuesto" ? "compuesto" : "aislamiento";
  if (!e.rxId) return { rx: { ...DEFAULT_RX, step, kind }, defaultRx: true };
  const repMin = e.rxRepMin ?? e.rxRepMax ?? DEFAULT_RX.repMin;
  const repMax = Math.max(repMin, e.rxRepMax ?? e.rxRepMin ?? DEFAULT_RX.repMax);
  return { rx: { sets: e.rxSets!, repMin, repMax, rirTarget: e.rxRir ?? DEFAULT_RX.rirTarget, step, kind }, defaultRx: false };
}

const defaultRest = (e: EntryRow) => e.rxRest ?? (e.kind === "compuesto" ? 180 : 90);

async function entriesTx(tx: Tx, workoutId: string, sets: SetView[]): Promise<EntryRow[]> {
  const entries = await tx.query<EntryRow>(
    `select ${EXERCISE_COLS}, x.position, x.origin, x.replaces_exercise_id as "replacesId", r.name as "replacesName",
       p.id as "rxId", p.sets as "rxSets", p.rep_min as "rxRepMin", p.rep_max as "rxRepMax", p.rir_target as "rxRir",
       p.rest_seconds as "rxRest", p.tempo as "rxTempo", p.technique as "rxTechnique", p.warmup_kind as "rxWarmup",
       p.load_cap_pct as "rxCap", p.notes as "rxNotes"
     from fit.workout_exercises x join fit.exercises e on e.id = x.exercise_id
     left join fit.prescriptions p on p.id = x.prescription_id
     left join fit.exercises r on r.id = x.replaces_exercise_id
     where x.workout_id = $1 order by x.position, x.created_at`, [workoutId]);
  // Sesiones importadas: tienen series pero no lista de ejercicios.
  const known = new Set(entries.map((e) => e.id));
  const orphan = [...new Set(sets.map((s) => s.exerciseId).filter((id): id is string => !!id && !known.has(id)))];
  if (orphan.length) {
    const ex = await tx.query<Exercise>(`select ${EXERCISE_COLS} from fit.exercises e where e.id = any($1::uuid[])`, [orphan]);
    for (const e of ex)
      entries.push({
        ...e, position: Math.min(...sets.filter((s) => s.exerciseId === e.id).map((s) => s.exercisePosition)), origin: "manual",
        replacesId: null, replacesName: null, rxId: null, rxSets: null, rxRepMin: null, rxRepMax: null, rxRir: null, rxRest: null,
        rxTempo: null, rxTechnique: null, rxWarmup: null, rxCap: null, rxNotes: null,
      });
    entries.sort((a, b) => a.position - b.position);
  }
  return entries;
}

function totalsOf(entries: EntryRow[], sets: SetView[]): WorkoutTotals {
  const working = sets.filter(isWorking);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const groups = new Map<string, SetLog[]>();
  for (const s of working) if (s.exerciseId) groups.set(s.exerciseId, [...(groups.get(s.exerciseId) ?? []), asLog(s)]);
  const muscleEntries = [...groups].flatMap(([id, list]) => {
    const e = byId.get(id);
    return e?.primaryMuscle ? [{ primary: e.primaryMuscle, secondary: e.secondaryMuscles, sets: list }] : [];
  });
  return {
    tonnage: round1(tonnage(working.map(asLog))),
    sets: working.length,
    hardSets: working.map(asLog).filter(isHardSet).length,
    byMuscle: hardSetsByMuscle(muscleEntries),
  };
}

/**
 * Construye la vista. Con `only`, calcula sugerencia e historial solo para esos ejercicios
 * (los demás bloques no se devuelven); los totales siempre son de la sesión entera.
 */
async function buildViewTx(tx: Tx, w: Workout, only?: string[]): Promise<WorkoutView> {
  const sets = await tx.query<SetView>(
    `select ${SET_COLS} from fit.workout_sets s where s.workout_id = $1 order by s.exercise_position, s.set_index`, [w.id]);
  const all = await entriesTx(tx, w.id, sets);
  const entries = only ? all.filter((e) => only.includes(e.id)) : all;
  const ids = entries.map((e) => e.id);

  const [chk] = await tx.query<{ readiness: number | null }>("select readiness from fit.checkins where date = $1", [w.date]);
  const readiness = chk?.readiness ?? null;
  const [mc] = w.microcycleId ? await tx.query<{ isDeload: boolean }>('select is_deload as "isDeload" from fit.microcycles where id = $1', [w.microcycleId]) : [];
  const deload = mc?.isDeload ?? false;
  const ankle = await ankleStatusTx(tx, w.date);
  const inDeficit = await inDeficitTx(tx, w.date);
  const history = await historyTx(tx, ids, { upTo: w.date, excludeWorkoutId: w.id });
  const best = await bestE1rmTx(tx, ids);
  const ankleHit = ankle.rule.restricted && entries.some((e) => e.ankleLoad === "alta");
  const lib = ankleHit ? await loadLibraryTx(tx) : [];

  const exercises = entries.map((e): ExerciseBlock => {
    const mine = sets.filter((s) => s.exerciseId === e.id);
    const working = mine.filter(isWorking);
    const past = history.get(e.id) ?? [];
    const spec = rxOf(e);
    const holdProgression = e.ankleLoad === "alta" ? ankle.rule.holdProgression : null;
    let suggestion: SuggestionView | null = spec
      ? { ...suggestNext(past, spec.rx, { readiness, deload, inDeficit, holdProgression }), defaultRx: spec.defaultRx } : null;

    // Tope de carga: el del plan y, si el tobillo restringe y el ejercicio lo carga, el 75 % de la regla.
    const flagged = ankle.rule.restricted && e.ankleLoad === "alta";
    const ankleCap = flagged ? ankle.rule.squatCapPct ?? 75 : null;
    const capPct = Math.min(e.rxCap ?? 100, ankleCap ?? 100);
    let loadCap: ExerciseBlock["loadCap"] = null;
    if (capPct < 100) {
      const recent = Math.max(0, ...past.map((p) => bestE1RM(p.sets)?.value ?? 0)) || best.get(e.id)?.value || 0;
      const kg = recent > 0 ? roundToStep((recent * capPct) / 100, spec?.rx.step ?? 2.5, "down") : null;
      loadCap = { pct: capPct, kg, reason: ankleCap != null && ankleCap <= (e.rxCap ?? 100) ? "tobillo" : "plan" };
      if (suggestion && suggestion.kg != null && kg != null && suggestion.kg > kg)
        suggestion = { ...suggestion, kg, why: `${suggestion.why} Tope del ${capPct} % ${loadCap.reason === "tobillo" ? "por el tobillo" : "del plan"}: ${es(kg)} kg.` };
    }
    // Si dolió al día siguiente de la última pierna, el ejercicio que carga el tobillo pierde una serie (mínimo 1): sin top set.
    if (flagged && ankle.rule.dropTopSet && suggestion) {
      const sets = Math.max(1, suggestion.sets - 1);
      suggestion = { ...suggestion, sets, repsTarget: suggestion.repsTarget.slice(0, sets),
        why: `${suggestion.why} Tobillo: dolió al día siguiente de la última pierna, hoy sin top set.` };
    }
    let ankleWarning: ExerciseBlock["ankleWarning"] = null;
    if (flagged) {
      const alt = alternativesIn(lib, e, { ankleSafe: true, limit: 1 })[0];
      ankleWarning = {
        message: `Tobillo con dolor ${ankle.pain ?? 0}/10${(ankle.painDayAfterLegs ?? 0) > 3 ? ` y ${ankle.painDayAfterLegs}/10 al día siguiente de pierna` : ""}: ` +
          `${e.name} carga el tobillo. ${alt ? `Cámbialo por ${alt.name} o no pases` : "No pases"} del ${ankleCap} % de tu 1RM` +
          `${loadCap?.kg != null ? ` (${es(loadCap.kg)} kg)` : ""}.${ankle.rule.dropTopSet ? " Hoy sin top set." : ""}`,
        loadCapPct: ankleCap!,
        alternative: alt ? { id: alt.id, slug: alt.slug, name: alt.name } : null,
      };
    }

    const targetKg = suggestion?.kg ?? working[0]?.kg ?? null;
    const isBar = e.equipment === "barra";
    const warmupKind = e.rxWarmup ?? e.warmupKind;
    const warmup = targetKg ? warmupLadder(targetKg, warmupKind, e.loadStep, isBar ? 20 : e.loadStep) : [];
    const plates = isBar && targetKg ? platesPerSide(targetKg) : null;

    const target = suggestion?.sets ?? 0;
    const done = suggestion ? working.length >= target : mine.length > 0;
    const next: NextSet | null = suggestion && !done
      ? { exerciseId: e.id, exerciseName: e.name, setNumber: working.length + 1,
          kg: suggestion.kg ?? working[working.length - 1]?.kg ?? null,
          reps: suggestion.repsTarget[working.length] ?? spec?.rx.repMin ?? null, rir: suggestion.rirTarget, restSeconds: defaultRest(e) }
      : null;

    const { position, origin, replacesId, replacesName, rxId, rxSets, rxRepMin, rxRepMax, rxRir, rxRest, rxTempo, rxTechnique, rxWarmup, rxCap, rxNotes, ...exercise } = e;
    return {
      position, origin, exercise,
      replaces: replacesId ? { id: replacesId, name: replacesName ?? "" } : null,
      prescription: rxId ? { id: rxId, sets: rxSets ?? 0, repMin: rxRepMin, repMax: rxRepMax, rirTarget: rxRir, restSeconds: rxRest,
        tempo: rxTempo, technique: rxTechnique, warmupKind: rxWarmup, loadCapPct: rxCap, notes: rxNotes } : null,
      suggestion, warmup, plates,
      lastSession: past[0] ? { date: past[0].date, sets: past[0].sets } : null,
      bestE1rm: best.get(e.id) ?? null,
      loadCap, ankleWarning, sets: mine, workingSetsDone: working.length, done, next,
    };
  });

  return {
    workout: w, readiness, readinessLabel: readiness != null ? readinessBand(readiness).label : null, deload, ankle, exercises,
    unmatchedSets: sets.filter((s) => !s.exerciseId),
    totals: totalsOf(all, sets),
    next: exercises.find((b) => b.next)?.next ?? null,
  };
}

export const GetWorkoutViewInput = z.object({ workoutId: Uuid.describe("Id de la sesión") });

export async function getWorkoutView(userId: string, input: z.input<typeof GetWorkoutViewInput> | string, db?: Db): Promise<WorkoutView> {
  const { workoutId } = parseInput(GetWorkoutViewInput, typeof input === "string" ? { workoutId: input } : input);
  return withUser(userId, async (tx) => buildViewTx(tx, await getWorkoutTx(tx, workoutId)), db);
}

/* ───────────────────────── Empezar ───────────────────────── */

export const StartWorkoutInput = z.object({
  date: IsoDate.optional().describe("Día de la sesión (AAAA-MM-DD). Por defecto, hoy"),
  sessionTemplateId: Uuid.optional().describe("Id de la sesión del plan que toca. Sin él se abre una sesión libre"),
  name: z.string().trim().min(1).max(80).optional().describe("Nombre de la sesión, si es libre"),
});
export type StartWorkoutInput = z.input<typeof StartWorkoutInput>;

async function nextPositionTx(tx: Tx, workoutId: string): Promise<number> {
  const [r] = await tx.query<{ p: number }>(
    `select greatest(coalesce((select max(position) from fit.workout_exercises where workout_id = $1), 0),
                     coalesce((select max(exercise_position) from fit.workout_sets where workout_id = $1), 0)) + 1 as p`, [workoutId]);
  return r.p;
}

async function startWorkoutTx(tx: Tx, i: z.output<typeof StartWorkoutInput>): Promise<Workout> {
  const date = await dateOrToday(tx, i.date);
  const [open] = await tx.query<Workout>(
    `select ${WORKOUT_COLS} from fit.workouts w where w.status = 'en_curso' and w.date = $1
       and w.session_template_id is not distinct from $2::uuid order by w.created_at desc limit 1`, [date, i.sessionTemplateId ?? null]);
  if (open) return open;

  let name = i.name ?? "Sesión libre";
  let microcycle: { id: string; position: number } | null = null;
  if (i.sessionTemplateId) {
    const [t] = await tx.query<{ name: string; isRest: boolean; mesocycleId: string }>(
      'select name, is_rest as "isRest", mesocycle_id as "mesocycleId" from fit.session_templates where id = $1', [i.sessionTemplateId]);
    if (!t) throw notFound("La sesión del plan");
    if (t.isRest) throw invalid(`«${t.name}» es un día de descanso: no tiene sesión.`);
    name = i.name ?? t.name;
    const micros = await tx.query<{ id: string; position: number; endDate: string | null }>(
      'select id, position, end_date as "endDate" from fit.microcycles where mesocycle_id = $1 order by position', [t.mesocycleId]);
    microcycle = micros.find((m) => m.endDate != null && date <= m.endDate) ?? micros[micros.length - 1] ?? null;
  }
  const [chk] = await tx.query<{ readiness: number | null }>("select readiness from fit.checkins where date = $1", [date]);
  const [created] = await tx.query<{ id: string }>(
    `insert into fit.workouts (date, started_at, session_template_id, microcycle_id, name, status, readiness_before)
     values ($1, now(), $2, $3, $4, 'en_curso', $5) returning id`,
    [date, i.sessionTemplateId ?? null, microcycle?.id ?? null, name, chk?.readiness ?? null]);
  if (i.sessionTemplateId) {
    const rx = (await prescriptionsForTx(tx, [i.sessionTemplateId], microcycle?.position ?? null)).get(i.sessionTemplateId) ?? [];
    const seen = new Set<string>();
    const list = rx.filter((p) => !seen.has(p.exerciseId) && seen.add(p.exerciseId)); // un ejercicio, una fila
    if (list.length)
      await tx.query(
        `insert into fit.workout_exercises (workout_id, exercise_id, position, prescription_id, origin)
         select $1::uuid, x.exercise_id, x.position, x.prescription_id, 'plan'
         from jsonb_to_recordset($2::jsonb) as x(exercise_id uuid, position smallint, prescription_id uuid)`,
        [created.id, JSON.stringify(list.map((p, k) => ({ exercise_id: p.exerciseId, position: k + 1, prescription_id: p.id })))]);
  }
  return getWorkoutTx(tx, created.id);
}

/** Abre la sesión del día (o devuelve la que ya está en curso para esa plantilla) con todo lo que hay que hacer. */
export async function startWorkout(userId: string, input?: StartWorkoutInput, db?: Db): Promise<WorkoutView> {
  const i = parseInput(StartWorkoutInput, input ?? {});
  return withUser(userId, async (tx) => buildViewTx(tx, await startWorkoutTx(tx, i)), db);
}

/* ───────────────────────── Registrar una serie ───────────────────────── */

export const LogSetInput = z.object({
  workoutId: Uuid.optional().describe("Id de la sesión. Sin él se usa la sesión en curso de ese día o se crea una libre"),
  exercise: z.string().trim().min(1).max(120).describe("Id del ejercicio o su nombre tal como lo dice el atleta"),
  kg: z.number().min(0).max(1000).describe("Carga en kg. 0 si es con el peso corporal"),
  reps: z.number().int().min(0).max(200).describe("Repeticiones hechas"),
  rir: z.number().min(0).max(10).optional().describe("Repeticiones en reserva (0 = al fallo). Si no se sabe, no se envía"),
  setType: z.enum(SET_TYPES).default("normal").describe("Tipo de serie. «aproximacion» es calentamiento y no cuenta"),
  perSide: z.boolean().optional().describe("La carga es por lado. Por defecto, lo que diga el ejercicio"),
  note: z.string().max(500).optional().describe("Nota de la serie"),
  date: IsoDate.optional().describe("Día de la serie (AAAA-MM-DD) si no se indica sesión. Por defecto, hoy"),
  restSeconds: z.number().int().min(0).max(3600).optional().describe("Descanso antes de esta serie, en segundos"),
  force: z.boolean().optional().describe("Guardar aunque sea idéntica a la serie anterior registrada hace menos de 20 s"),
  clientId: z.string().min(1).max(64).optional().describe("Id generado por el cliente (cola sin conexión). Si ya existe para este atleta, no se vuelve a guardar"),
  equipment: z.enum(EQUIPMENT_TYPES).optional().describe("Equipo que usó ese día: libre, multipower, polea, placas, discos, peso_corporal o cardio. Por defecto, el del ejercicio"),
  doneAt: IsoDateTime.optional().describe("Hora real de la serie (ISO 8601). Por defecto, el momento del registro"),
});
export type LogSetInput = z.input<typeof LogSetInput>;

export type Candidate = { id: string; slug: string; name: string };
export type Problem = { field: string; message: string; candidates?: Candidate[] };

export type LogSetResult =
  | {
      ok: true;
      workoutId: string;
      exercise: Candidate;
      set: SetView;
      /** La serie era idéntica a la anterior (< 20 s) y no se guardó otra vez. */
      duplicate: boolean;
      isPr: boolean;
      pr: { e1rm: number; previous: number } | null;
      next: NextSet | null;
      totals: WorkoutTotals;
      warnings: string[];
    }
  | { ok: false; problems: Problem[] };

const brief = (e: Exercise): Candidate => ({ id: e.id, slug: e.slug, name: e.name });

type Resolved = { exercise: Exercise; created: boolean } | { candidates: Exercise[] };

/** Id o texto → ejercicio. Con texto ambiguo devuelve los candidatos; con texto desconocido, `create` decide. */
async function resolveRefTx(tx: Tx, ref: string, create: boolean): Promise<Resolved> {
  if (UUID_RE.test(ref)) return { exercise: await getExerciseTx(tx, ref), created: false };
  const r = resolveIn(await loadLibraryTx(tx), ref);
  if (r.match) return { exercise: r.match, created: false };
  if (r.candidates.length) return { candidates: r.candidates };
  if (!create) throw notFound(`El ejercicio «${ref}»`);
  const name = ref.charAt(0).toUpperCase() + ref.slice(1);
  return { exercise: await createExerciseTx(tx, { name }), created: true };
}

function pickNext(view: WorkoutView, exerciseId: string): NextSet | null {
  const at = view.exercises.find((b) => b.exercise.id === exerciseId);
  if (at?.next) return at.next;
  const open = view.exercises.filter((b) => b.next);
  return (open.find((b) => b.position > (at?.position ?? 0)) ?? open[0])?.next ?? null;
}

async function refreshTotalsTx(tx: Tx, workoutId: string): Promise<void> {
  const sets = await tx.query<SetView>(`select ${SET_COLS} from fit.workout_sets s where s.workout_id = $1`, [workoutId]);
  const working = sets.filter(isWorking).map(asLog);
  await tx.query("update fit.workouts set tonnage = $1, hard_sets = $2, updated_at = now() where id = $3",
    [round1(tonnage(working)), working.filter(isHardSet).length, workoutId]);
}

async function logSetTx(tx: Tx, i: z.output<typeof LogSetInput>): Promise<LogSetResult> {
  const warnings: string[] = [];
  // Reenvío de la cola sin conexión: si el id de cliente ya existe, se devuelve esa fila y no se escribe nada.
  if (i.clientId) {
    const [dup] = await tx.query<SetView>(`select ${SET_COLS} from fit.workout_sets s where s.client_id = $1`, [i.clientId]);
    if (dup) {
      const w = await getWorkoutTx(tx, dup.workoutId);
      const view = await buildViewTx(tx, w);
      const ex = await getExerciseTx(tx, dup.exerciseId!);
      return { ok: true, workoutId: w.id, exercise: brief(ex), set: dup, duplicate: true, isPr: false, pr: null, next: pickNext(view, ex.id), totals: view.totals,
        warnings: ["Esa serie ya estaba registrada (mismo id de cliente): no se ha guardado otra vez."] };
    }
  }
  // Primero el ejercicio: si es ambiguo no se escribe nada (ni la sesión).
  const res = await resolveRefTx(tx, i.exercise, true);
  if ("candidates" in res)
    return { ok: false, problems: [{ field: "exercise", message: `«${i.exercise}» puede ser más de un ejercicio. Di cuál.`, candidates: res.candidates.map(brief) }] };
  const ex = res.exercise;
  if (res.created) warnings.push(`No conocía «${ex.name}». Lo he creado sin clasificar: ponle grupo muscular cuando puedas.`);

  let w: Workout;
  if (i.workoutId) w = await getWorkoutTx(tx, i.workoutId);
  else {
    const date = await dateOrToday(tx, i.date);
    const [open] = await tx.query<Workout>(
      `select ${WORKOUT_COLS} from fit.workouts w where w.status = 'en_curso' and w.date = $1 order by w.created_at desc limit 1`, [date]);
    w = open ?? (await startWorkoutTx(tx, { date }));
    if (!open) warnings.push("No había sesión en curso: he abierto una sesión libre.");
  }

  let [entry] = await tx.query<{ position: number }>(
    "select position from fit.workout_exercises where workout_id = $1 and exercise_id = $2", [w.id, ex.id]);
  if (!entry) {
    const [prev] = await tx.query<{ position: number }>(
      "select exercise_position as position from fit.workout_sets where workout_id = $1 and exercise_id = $2 limit 1", [w.id, ex.id]);
    entry = { position: prev?.position ?? (await nextPositionTx(tx, w.id)) };
    await tx.query("insert into fit.workout_exercises (workout_id, exercise_id, position, origin) values ($1, $2, $3, 'manual')", [w.id, ex.id, entry.position]);
  }

  const rir = i.rir ?? null;
  const [last] = await tx.query<SetView & { recent: boolean }>(
    `select ${SET_COLS}, (now() - s.created_at) < interval '20 seconds' as recent from fit.workout_sets s
     where s.workout_id = $1 and s.exercise_id = $2 order by s.set_index desc limit 1`, [w.id, ex.id]);
  if (!i.force && last?.recent && last.kg === i.kg && last.reps === i.reps && last.rir === rir && last.setType === i.setType) {
    const view = await buildViewTx(tx, w);
    const { recent: _recent, ...set } = last;
    return { ok: true, workoutId: w.id, exercise: brief(ex), set, duplicate: true, isPr: false, pr: null, next: pickNext(view, ex.id),
      totals: view.totals, warnings: [...warnings, "Serie repetida en menos de 20 s: no la he guardado dos veces."] };
  }

  // Objetivo vigente antes de guardar: es lo que se le pedía a esta serie.
  const before = (await buildViewTx(tx, w, [ex.id])).exercises[0];
  const sug = i.setType === "aproximacion" ? null : before?.suggestion ?? null;
  const m = setMetrics(i.kg, i.reps, rir, i.setType);
  const [{ n: setIndex }] = await tx.query<{ n: number }>(
    "select coalesce(max(set_index), 0) + 1 as n from fit.workout_sets where workout_id = $1 and exercise_position = $2", [w.id, entry.position]);
  const [ins] = await tx.query<{ id: string }>(
    `insert into fit.workout_sets (workout_id, exercise_id, exercise_name_raw, exercise_position, set_index, set_type, kg, reps, rir,
       kg_target, reps_target, rir_target, per_side, rest_seconds, e1rm, e1rm_confidence, effective_reps, rule_applied, note, done_at, client_id, equipment_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, coalesce($20::timestamptz, now()), $21, $22) returning id`,
    [w.id, ex.id, UUID_RE.test(i.exercise) ? null : i.exercise, entry.position, setIndex, i.setType, i.kg, i.reps, rir,
      sug?.kg ?? null, sug ? sug.repsTarget[before.workingSetsDone] ?? null : null, sug?.rirTarget ?? null,
      i.perSide ?? ex.perSide, i.restSeconds ?? null, m.e1rm, m.confidence, m.effective, sug?.rule ?? null, i.note ?? null, i.doneAt ?? null, i.clientId ?? null, i.equipment ?? ex.equipmentType ?? null]);

  let pr: { e1rm: number; previous: number } | null = null;
  if (m.e1rm != null && m.confidence !== "baja") {
    const [p] = await tx.query<{ best: number | null; others: number }>(
      `select max(s.e1rm) as best, count(*) filter (where s.workout_id <> $2)::int as others from fit.workout_sets s
       where s.exercise_id = $1 and s.id <> $3 and s.e1rm is not null and s.e1rm_confidence in ('alta', 'media')`, [ex.id, w.id, ins.id]);
    if (p.others > 0 && p.best != null && m.e1rm > p.best + 0.01) pr = { e1rm: m.e1rm, previous: p.best };
  }
  if (w.status === "hecha") await refreshTotalsTx(tx, w.id);
  if (before?.loadCap?.kg != null && i.kg > before.loadCap.kg && i.setType !== "aproximacion")
    warnings.push(`Has pasado el tope de ${es(before.loadCap.kg)} kg (${before.loadCap.pct} %${before.loadCap.reason === "tobillo" ? ", tobillo" : ""}).`);

  const view = await buildViewTx(tx, w);
  const set = view.exercises.flatMap((b) => b.sets).find((s) => s.id === ins.id)!;
  return { ok: true, workoutId: w.id, exercise: brief(ex), set, duplicate: false, isPr: !!pr, pr, next: pickNext(view, ex.id), totals: view.totals, warnings };
}

/** Registra una serie. Con un nombre ambiguo devuelve `ok: false` y los candidatos, sin escribir nada. */
export async function logSet(userId: string, input: LogSetInput, db?: Db): Promise<LogSetResult> {
  const i = parseInput(LogSetInput, input);
  return withUser(userId, (tx) => logSetTx(tx, i), db);
}

/* ───────────────────────── Editar y borrar series ───────────────────────── */

export const UpdateSetInput = z.object({
  setId: Uuid.describe("Id de la serie"),
  kg: z.number().min(0).max(1000).optional().describe("Carga corregida en kg"),
  reps: z.number().int().min(0).max(200).optional().describe("Repeticiones corregidas"),
  rir: z.number().min(0).max(10).nullable().optional().describe("Repeticiones en reserva corregidas. Null para quitarlas"),
  setType: z.enum(SET_TYPES).optional().describe("Tipo de serie"),
  perSide: z.boolean().optional().describe("La carga es por lado"),
  restSeconds: z.number().int().min(0).max(3600).nullable().optional().describe("Descanso en segundos"),
  note: z.string().max(500).nullable().optional().describe("Nota de la serie"),
  equipment: z.enum(EQUIPMENT_TYPES).nullable().optional().describe("Equipo que usó ese día. Null para quitarlo"),
});

type SetWithStatus = SetView & { workoutStatus: Workout["status"] };
const setByIdTx = async (tx: Tx, id: string) =>
  (await tx.query<SetWithStatus>(
    `select ${SET_COLS}, w.status as "workoutStatus" from fit.workout_sets s join fit.workouts w on w.id = s.workout_id where s.id = $1`, [id]))[0];

export async function updateSet(userId: string, input: z.input<typeof UpdateSetInput>, db?: Db): Promise<SetView> {
  const i = parseInput(UpdateSetInput, input);
  return withUser(userId, async (tx) => {
    const cur = await setByIdTx(tx, i.setId);
    if (!cur) throw notFound("La serie");
    const kg = i.kg ?? cur.kg;
    const reps = i.reps ?? cur.reps;
    const rir = i.rir === undefined ? cur.rir : i.rir;
    const setType = i.setType ?? cur.setType;
    const m = setMetrics(kg, reps, rir, setType);
    await tx.query(
      `update fit.workout_sets set kg = $1, reps = $2, rir = $3, set_type = $4, per_side = $5, rest_seconds = $6, note = $7,
         e1rm = $8, e1rm_confidence = $9, effective_reps = $10, equipment_type = $11 where id = $12`,
      [kg, reps, rir, setType, i.perSide ?? cur.perSide, i.restSeconds === undefined ? cur.restSeconds : i.restSeconds,
        i.note === undefined ? cur.note : i.note, m.e1rm, m.confidence, m.effective, i.equipment === undefined ? cur.equipmentType : i.equipment, i.setId]);
    if (cur.workoutStatus === "hecha") await refreshTotalsTx(tx, cur.workoutId);
    const { workoutStatus: _ws, ...set } = await setByIdTx(tx, i.setId);
    return set;
  }, db);
}

export const DeleteSetInput = z.object({ setId: Uuid.describe("Id de la serie a borrar") });

export async function deleteSet(userId: string, input: z.input<typeof DeleteSetInput> | string, db?: Db): Promise<{ deleted: true; workoutId: string }> {
  const { setId } = parseInput(DeleteSetInput, typeof input === "string" ? { setId: input } : input);
  return withUser(userId, async (tx) => {
    const cur = await setByIdTx(tx, setId);
    if (!cur) throw notFound("La serie");
    await tx.query("delete from fit.workout_sets where id = $1", [setId]);
    if (cur.workoutStatus === "hecha") await refreshTotalsTx(tx, cur.workoutId);
    return { deleted: true as const, workoutId: cur.workoutId };
  }, db);
}

/* ───────────────────────── Añadir y cambiar ejercicios ───────────────────────── */

export const AddExerciseToWorkoutInput = z.object({
  workoutId: Uuid.describe("Id de la sesión"),
  exercise: z.string().trim().min(1).max(120).describe("Id del ejercicio o su nombre"),
});

export async function addExerciseToWorkout(userId: string, input: z.input<typeof AddExerciseToWorkoutInput>, db?: Db): Promise<WorkoutView> {
  const i = parseInput(AddExerciseToWorkoutInput, input);
  return withUser(userId, async (tx) => {
    const w = await getWorkoutTx(tx, i.workoutId);
    const res = await resolveRefTx(tx, i.exercise, false);
    if ("candidates" in res)
      throw new AppError("ambiguo", `«${i.exercise}» puede ser más de un ejercicio. Di cuál.`, { candidates: res.candidates.map(brief) });
    await tx.query(
      `insert into fit.workout_exercises (workout_id, exercise_id, position, origin) values ($1, $2, $3, 'manual')
       on conflict (workout_id, exercise_id) do nothing`, [w.id, res.exercise.id, await nextPositionTx(tx, w.id)]);
    return buildViewTx(tx, w);
  }, db);
}

export const SwapExerciseInput = z.object({
  workoutId: Uuid.describe("Id de la sesión"),
  fromExerciseId: Uuid.describe("Id del ejercicio que se quita"),
  toExerciseId: Uuid.describe("Id del ejercicio que lo sustituye"),
});

/** Cambia un ejercicio por otro solo en esta sesión. La pauta (series, rango, RIR) se conserva. */
export async function swapExercise(userId: string, input: z.input<typeof SwapExerciseInput>, db?: Db): Promise<WorkoutView> {
  const i = parseInput(SwapExerciseInput, input);
  if (i.fromExerciseId === i.toExerciseId) throw invalid("Es el mismo ejercicio.");
  return withUser(userId, async (tx) => {
    const w = await getWorkoutTx(tx, i.workoutId);
    const to = await getExerciseTx(tx, i.toExerciseId);
    const rows = await tx.query<{ id: string; exerciseId: string; replacesId: string | null }>(
      'select id, exercise_id as "exerciseId", replaces_exercise_id as "replacesId" from fit.workout_exercises where workout_id = $1', [w.id]);
    const from = rows.find((r) => r.exerciseId === i.fromExerciseId);
    if (!from) throw notFound("Ese ejercicio en la sesión");
    if (rows.some((r) => r.exerciseId === to.id)) throw new AppError("conflicto", `${to.name} ya está en la sesión.`);
    const logged = await tx.query("select 1 from fit.workout_sets where workout_id = $1 and exercise_id = $2 limit 1", [w.id, i.fromExerciseId]);
    if (logged.length) throw new AppError("conflicto", "Ya hay series de ese ejercicio. Añade el otro en vez de cambiarlo.");
    await tx.query("update fit.workout_exercises set exercise_id = $1, replaces_exercise_id = $2, origin = 'cambio' where id = $3",
      [to.id, from.replacesId ?? i.fromExerciseId, from.id]);
    return buildViewTx(tx, w);
  }, db);
}

/* ───────────────────────── Cerrar la sesión ───────────────────────── */

export const FinishWorkoutInput = z.object({
  workoutId: Uuid.describe("Id de la sesión"),
  srpe: z.number().min(0).max(10).describe("Esfuerzo percibido de la sesión entera, de 0 a 10"),
  durationMin: z.number().int().min(1).max(600).optional().describe("Duración en minutos. Por defecto, desde que se abrió la sesión hasta ahora"),
  notes: z.string().max(2000).optional().describe("Notas de la sesión"),
  kneeSleeves: z.boolean().optional().describe("Usó rodilleras"),
  belt: z.boolean().optional().describe("Usó cinturón"),
  straps: z.boolean().optional().describe("Usó straps"),
  caffeineMg: z.number().int().min(0).max(1000).optional().describe("Cafeína tomada antes, en mg"),
  caffeineAt: z.iso.datetime({ offset: true }).optional().describe("Cuándo tomó la cafeína (fecha y hora ISO)"),
  recoveryAfter: z.number().int().min(1).max(10).optional().describe("Cómo de recuperado acaba, de 1 a 10"),
  satisfaction: z.number().int().min(1).max(10).optional().describe("Satisfacción con la sesión, de 1 a 10"),
});
export type FinishWorkoutInput = z.input<typeof FinishWorkoutInput>;

export type Annotation = { id: string; scope: string; rule: string | null; severity: "info" | "aviso" | "accion"; title: string; body: string | null };

export type WorkoutSummary = {
  workout: Workout;
  /** sRPE × minutos. */
  load: number;
  tonnage: number;
  hardSets: number;
  setsByMuscle: Record<string, number>;
  prs: { exerciseId: string; name: string; e1rm: number; previous: number; kg: number | null; reps: number | null; rir: number | null }[];
  annotations: Annotation[];
};

type Note = Omit<Annotation, "id">;

/** Rodilleras o cinturón frente a sesiones sin ellos, para un ejercicio de sentadilla. Observación, no conclusión. */
function gearNotes(name: string, sessions: { best: number; kneeSleeves: boolean; belt: boolean }[]): Note[] {
  const out: Note[] = [];
  const gear = [
    { key: "kneeSleeves" as const, rule: "material_rodilleras", withIt: "con rodilleras", without: "sin rodilleras" },
    { key: "belt" as const, rule: "material_cinturon", withIt: "con cinturón", without: "sin cinturón" },
  ];
  for (const g of gear) {
    const a = sessions.filter((s) => s[g.key]);
    const b = sessions.filter((s) => !s[g.key]);
    if (!a.length || !b.length) continue;
    const bestA = Math.max(...a.map((s) => s.best));
    const bestB = Math.max(...b.map((s) => s.best));
    if (bestA <= bestB) continue; // solo se anota cuando la mejor marca coincide con el material
    const small = Math.min(a.length, b.length) < 3;
    out.push({
      scope: "material", rule: g.rule, severity: "info",
      title: `${name}: ${es(bestA)} kg ${g.withIt}, ${es(bestB)} kg ${g.without}`,
      body: `Mejor 1RM estimado ${g.withIt}: ${es(bestA)} kg (${a.length} ${a.length === 1 ? "sesión" : "sesiones"}). ` +
        `${g.without.charAt(0).toUpperCase() + g.without.slice(1)}: ${es(bestB)} kg (${b.length} ${b.length === 1 ? "sesión" : "sesiones"}). ` +
        (small ? "Muestra pequeña: todavía no se puede concluir nada."
          : `Diferencia: ${es(bestA - bestB)} kg (${es(((bestA - bestB) / bestB) * 100)} %). Es una observación: también cambian el día y la fatiga.`),
    });
  }
  return out;
}

export async function finishWorkout(userId: string, input: FinishWorkoutInput, db?: Db): Promise<WorkoutSummary> {
  const i = parseInput(FinishWorkoutInput, input);
  return withUser(userId, async (tx) => {
    const w0 = await getWorkoutTx(tx, i.workoutId);
    if (i.durationMin == null && w0.durationMin == null && !w0.startedAt) throw invalid("Falta la duración de la sesión en minutos.");
    const sets = await tx.query<SetView>(`select ${SET_COLS} from fit.workout_sets s where s.workout_id = $1 order by s.exercise_position, s.set_index`, [w0.id]);
    const entries = await entriesTx(tx, w0.id, sets);
    const totals = totalsOf(entries, sets);

    await tx.query(
      `update fit.workouts set status = 'hecha', ended_at = coalesce(ended_at, now()), srpe = $2,
         duration_min = coalesce($3::int, duration_min, greatest(1, least(600, round(extract(epoch from (now() - started_at)) / 60)::int))),
         tonnage = $4, hard_sets = $5, notes = coalesce($6, notes), knee_sleeves = coalesce($7, knee_sleeves), belt = coalesce($8, belt),
         straps = coalesce($9, straps), caffeine_mg = coalesce($10, caffeine_mg), caffeine_at = coalesce($11::timestamptz, caffeine_at),
         recovery_after = coalesce($12, recovery_after), satisfaction = coalesce($13, satisfaction), updated_at = now()
       where id = $1`,
      [w0.id, i.srpe, i.durationMin ?? null, totals.tonnage, totals.hardSets, i.notes ?? null, i.kneeSleeves ?? null, i.belt ?? null,
        i.straps ?? null, i.caffeineMg ?? null, i.caffeineAt ?? null, i.recoveryAfter ?? null, i.satisfaction ?? null]);
    const w = await getWorkoutTx(tx, w0.id);

    const notes: Note[] = [];
    const ids = entries.map((e) => e.id);

    // 1) Récords de e1RM frente a todas las demás sesiones.
    const prs: WorkoutSummary["prs"] = [];
    if (ids.length) {
      const cmp = await tx.query<{ exerciseId: string; here: number | null; before: number | null }>(
        `select s.exercise_id as "exerciseId", max(s.e1rm) filter (where s.workout_id = $1) as here,
                max(s.e1rm) filter (where s.workout_id <> $1) as before
         from fit.workout_sets s where s.exercise_id = any($2::uuid[]) and s.e1rm is not null and s.e1rm_confidence in ('alta', 'media')
         group by s.exercise_id`, [w.id, ids]);
      for (const c of cmp) {
        if (c.here == null || c.before == null || c.here <= c.before + 0.01) continue;
        const e = entries.find((x) => x.id === c.exerciseId)!;
        const top = sets.find((s) => s.exerciseId === c.exerciseId && s.e1rm === c.here);
        prs.push({ exerciseId: e.id, name: e.name, e1rm: c.here, previous: c.before, kg: top?.kg ?? null, reps: top?.reps ?? null, rir: top?.rir ?? null });
        notes.push({ scope: "ejercicio", rule: "pr", severity: "info", title: `Récord en ${e.name}: ${es(c.here)} kg de 1RM estimado`,
          body: `Antes: ${es(c.before)} kg.${top ? ` Serie: ${es(top.kg ?? 0)} kg × ${top.reps}${top.rir != null ? ` (RIR ${es(top.rir)})` : ""}.` : ""}` });
      }
    }

    // 2) Estancados: tres sesiones con la misma carga sin sumar repeticiones (lo decide el motor).
    const history = await historyTx(tx, ids, { upTo: w.date });
    for (const e of entries) {
      const spec = rxOf(e);
      const past = history.get(e.id) ?? [];
      if (!spec || past[0]?.workoutId !== w.id) continue;
      const s = suggestNext(past, spec.rx);
      if (s.stalled)
        notes.push({ scope: "ejercicio", rule: "estancado", severity: "aviso", title: `${e.name}: 3 sesiones sin sumar`,
          body: `Misma carga (${es(past[0].sets[0].kg)} kg) y las mismas repeticiones o menos. Revisa sueño, estrés, calorías del día y el orden del ejercicio antes de tocar el volumen.` });
    }

    // 3) Series basura: más de 10 series efectivas de un grupo (como principal) en una sesión.
    const direct = hardSetsByMuscle(entries.flatMap((e) => {
      const list = sets.filter((s) => s.exerciseId === e.id && isWorking(s)).map(asLog);
      return e.primaryMuscle && list.length ? [{ primary: e.primaryMuscle, sets: list }] : [];
    }));
    const over = Object.entries(direct).filter(([, n]) => junkSetsInSession(n) > 0);
    if (over.length) {
      const names = new Map((await tx.query<{ id: string; name: string }>("select id, name from fit.muscle_groups")).map((m) => [m.id, m.name]));
      for (const [muscle, n] of over)
        notes.push({ scope: "volumen", rule: "series_basura", severity: "aviso", title: `${names.get(muscle) ?? muscle}: ${es(n)} series efectivas en una sesión`,
          body: `A partir de ${SESSION_CAP} por grupo y sesión la curva se aplana. Sobran ${es(junkSetsInSession(n))}: repártelas en otro día.` });
    }

    // 4) Material en la sentadilla.
    for (const e of entries.filter((x) => x.kind === "compuesto" && normalizeText(`${x.name} ${x.slug}`).includes("sentadilla"))) {
      if (!sets.some((s) => s.exerciseId === e.id && isWorking(s))) continue;
      const per = await tx.query<{ best: number; kneeSleeves: boolean; belt: boolean }>(
        `select max(s.e1rm) as best, w.knee_sleeves as "kneeSleeves", w.belt from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
         where s.exercise_id = $1 and w.status = 'hecha' and s.e1rm is not null and s.e1rm_confidence in ('alta', 'media')
         group by w.id, w.knee_sleeves, w.belt`, [e.id]);
      notes.push(...gearNotes(e.name, per));
    }

    await tx.query("delete from fit.annotations where origin = 'motor' and ref_table = 'workouts' and ref_id = $1", [w.id]);
    const annotations = notes.length
      ? await tx.query<Annotation>(
          `insert into fit.annotations (date, origin, scope, rule, severity, title, body, ref_table, ref_id)
           select $1::date, 'motor', x.scope, x.rule, x.severity, x.title, x.body, 'workouts', $2::uuid
           from jsonb_to_recordset($3::jsonb) as x(scope text, rule text, severity text, title text, body text)
           returning id, scope, rule, severity, title, body`, [w.date, w.id, JSON.stringify(notes)])
      : [];
    return { workout: w, load: w.load ?? 0, tonnage: totals.tonnage, hardSets: totals.hardSets, setsByMuscle: totals.byMuscle, prs, annotations };
  }, db);
}

/* ───────────────────────── Listados e historial ───────────────────────── */

export const ListWorkoutsInput = z.object({
  from: IsoDate.optional().describe("Desde este día (AAAA-MM-DD)"),
  to: IsoDate.optional().describe("Hasta este día (AAAA-MM-DD)"),
  limit: z.number().int().min(1).max(500).default(30).describe("Máximo de sesiones, de la más reciente a la más antigua"),
});

export type WorkoutListItem = Workout & { sets: number };

export async function listWorkouts(userId: string, input?: z.input<typeof ListWorkoutsInput>, db?: Db): Promise<WorkoutListItem[]> {
  const i = parseInput(ListWorkoutsInput, input ?? {});
  return withUser(userId, (tx) => tx.query<WorkoutListItem>(
    `select ${WORKOUT_COLS}, (select count(*)::int from fit.workout_sets s where s.workout_id = w.id and s.set_type <> 'aproximacion') as sets
     from fit.workouts w where ($1::date is null or w.date >= $1) and ($2::date is null or w.date <= $2)
     order by w.date desc, w.created_at desc limit $3`, [i.from ?? null, i.to ?? null, i.limit]), db);
}

export const GetExerciseHistoryInput = z.object({
  exercise: z.string().trim().min(1).max(120).describe("Id del ejercicio o su nombre"),
  limit: z.number().int().min(1).max(100).default(12).describe("Máximo de sesiones"),
});

export type ExerciseHistory = {
  exercise: Exercise;
  /** De la más reciente a la más antigua. */
  sessions: { workoutId: string; date: string; sets: SetLog[]; e1rm: number | null; confidence: Confidence | null; tonnage: number; kneeSleeves: boolean; belt: boolean; equipmentType: string | null }[];
  best: { e1rm: number; date: string } | null;
  trend: { direction: "sube" | "baja" | "plano" | "sin_datos"; changePct: number | null; sessions: number };
};

/** Tendencia del e1RM por sesión: recta de regresión sobre las sesiones, de la más antigua a la más reciente. */
export function e1rmTrend(values: number[]): ExerciseHistory["trend"] {
  if (values.length < 3) return { direction: "sin_datos", changePct: null, sessions: values.length };
  const { slope, intercept } = linearRegression(values.map((_, k) => k), values);
  const changePct = intercept > 0 ? round1(((slope * (values.length - 1)) / intercept) * 100) : 0;
  return { direction: changePct > 1.5 ? "sube" : changePct < -1.5 ? "baja" : "plano", changePct, sessions: values.length };
}

export async function getExerciseHistory(userId: string, input: z.input<typeof GetExerciseHistoryInput>, db?: Db): Promise<ExerciseHistory> {
  const i = parseInput(GetExerciseHistoryInput, input);
  return withUser(userId, async (tx) => {
    const res = await resolveRefTx(tx, i.exercise, false);
    if ("candidates" in res)
      throw new AppError("ambiguo", `«${i.exercise}» puede ser más de un ejercicio. Di cuál.`, { candidates: res.candidates.map(brief) });
    const past = (await historyTx(tx, [res.exercise.id], { upTo: "9999-12-31", sessions: i.limit })).get(res.exercise.id) ?? [];
    const sessions = past.map((p) => {
      const b = bestE1RM(p.sets);
      return { workoutId: p.workoutId, date: p.date, sets: p.sets, e1rm: b ? round2(b.value) : null, confidence: b?.confidence ?? null,
        tonnage: round1(tonnage(p.sets)), kneeSleeves: p.kneeSleeves, belt: p.belt, equipmentType: p.equipmentType };
    });
    const withE = sessions.filter((s) => s.e1rm != null);
    const top = withE.reduce<(typeof withE)[number] | null>((a, s) => (!a || s.e1rm! > a.e1rm! ? s : a), null);
    return {
      exercise: res.exercise, sessions,
      best: top ? { e1rm: top.e1rm!, date: top.date } : null,
      trend: e1rmTrend(withE.map((s) => s.e1rm!).reverse()),
    };
  }, db);
}

/* ───────────────────────── Agujetas ───────────────────────── */

export const LogSorenessInput = z.object({
  date: IsoDate.optional().describe("Día en que se notan (AAAA-MM-DD). Por defecto, hoy"),
  scores: z.record(z.string(), z.number().int().min(1).max(5)).describe("Agujetas por grupo muscular: id del grupo → 1 (nada) a 5 (no puedo moverlo)"),
});

export async function logSoreness(userId: string, input: z.input<typeof LogSorenessInput>, db?: Db): Promise<{ date: string; scores: Record<string, number> }> {
  const i = parseInput(LogSorenessInput, input);
  const muscles = Object.keys(i.scores);
  if (!muscles.length) throw invalid("Indica al menos un grupo muscular.");
  return withUser(userId, async (tx) => {
    const date = await dateOrToday(tx, i.date);
    const known = new Set((await tx.query<{ id: string }>("select id from fit.muscle_groups where id = any($1::text[])", [muscles])).map((r) => r.id));
    const bad = muscles.filter((m) => !known.has(m));
    if (bad.length) throw invalid(`Grupo muscular desconocido: ${bad.join(", ")}.`, { unknown: bad });
    await tx.query(
      `insert into fit.soreness_logs (date, muscle_id, score)
       select $1::date, x.muscle_id, x.score from jsonb_to_recordset($2::jsonb) as x(muscle_id text, score smallint)
       on conflict (user_id, date, muscle_id) do update set score = excluded.score`,
      [date, JSON.stringify(muscles.map((m) => ({ muscle_id: m, score: i.scores[m] })))]);
    return { date, scores: i.scores };
  }, db);
}

/* ───────────────────────── Mantenimiento ───────────────────────── */

/** Rellena e1RM, confianza y repeticiones efectivas en las series que no los tienen (histórico importado). */
export async function recomputeSetMetrics(userId: string, _input?: unknown, db?: Db): Promise<{ updated: number }> {
  return withUser(userId, async (tx) => {
    const rows = await tx.query<{ id: string; kg: number; reps: number; rir: number | null; setType: string }>(
      `select id, kg, reps, rir, set_type as "setType" from fit.workout_sets
       where e1rm is null and kg > 0 and reps >= 1 and set_type <> 'aproximacion'`);
    const patch = rows.map((r) => ({ id: r.id, ...setMetrics(r.kg, r.reps, r.rir, r.setType) })).filter((p) => p.e1rm != null);
    if (patch.length)
      await tx.query(
        `update fit.workout_sets s set e1rm = x.e1rm, e1rm_confidence = x.confidence, effective_reps = x.effective
         from jsonb_to_recordset($1::jsonb) as x(id uuid, e1rm numeric, confidence text, effective smallint) where s.id = x.id`,
        [JSON.stringify(patch)]);
    return { updated: patch.length };
  }, db);
}
