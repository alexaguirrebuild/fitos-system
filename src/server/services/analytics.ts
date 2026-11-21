/**
 * Analítica: carga (ACWR), estrés y volumen por grupo, decisión de descarga y progreso.
 * Todo son lecturas; los cálculos son del motor.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { invalid, notFound } from "@/server/errors";
import { addDays, diffDays, weekStart } from "@/server/time";
import {
  acwr, bestE1RM, deloadDecision, hardSetsByMuscle, progressRate, volumeAdvice, volumeStatus, weeklyEquivalentSets, weeklyRatePct, weeklyStress,
  weightTrend,
  type AcwrZone, type Confidence, type MuscleEntry, type SetLog, type StressBand, type VolumeStatus,
} from "@/engine";
import { DateInput, IsoDate, Uuid, dateOrToday, isExamPeriodTx, parseDateInput, parseInput } from "./athlete";
import { listMuscleGroupsTx } from "./library";
import { activePlanTx } from "./plan";
import { historyTx } from "./training";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ───────────────────────── Carga ───────────────────────── */

/** Carga diaria: sesiones de pesas hechas (sRPE × min) más el cardio (ECOS), leído directamente de su tabla. */
async function loadSessionsTx(tx: Tx, upTo: string): Promise<{ date: string; load: number }[]> {
  return tx.query<{ date: string; load: number }>(
    `select date, load from fit.workouts where status = 'hecha' and load > 0 and date <= $1
     union all
     select date, ecos as load from fit.cardio_sessions where ecos > 0 and date <= $1
     order by date`, [upTo]);
}

const ACWR_LABEL: Record<AcwrZone, string> = {
  subcarga: "Por debajo de lo habitual. Hay margen para subir.",
  optimo: "Carga en rango.",
  precaucion: "Carga subiendo rápido. No añadas más esta semana.",
  pico: "Pico de carga. Recorta volumen unos días.",
  pico_extremo: "Pico extremo (más del doble de lo habitual). Revisa qué ha pasado y recorta ya.",
};

export type LoadStatus = {
  date: string;
  acwr: {
    acute: number;
    chronic: number;
    /** Null con menos de 21 días de historial: todavía no dice nada. */
    ratio: number | null;
    zone: AcwrZone | null;
    days: number;
    reliable: boolean;
    label: string;
  };
  /** Estrés de los últimos 7 días por grupo muscular principal (tabla por RIR del motor: 20 = moderado, 26 = duro). */
  muscleStress: { muscleId: string; name: string; value: number; band: StressBand; sets: number }[];
  deload: { deload: boolean; signals: string[]; plan: string | null; maintenance: boolean };
  signals: {
    e1rmDropping: { exerciseId: string; name: string; e1rm: number[] }[];
    readiness7dAvg: number | null;
    maxWeeklyStress: number | null;
    examPeriod: boolean;
    /** Noches de los últimos 7 días con menos de 7 h de sueño (de las que tienen horas anotadas). */
    shortSleepNights: number | null;
    /** Peor dolor tendinoso o articular de los últimos 3 días (lesiones abiertas y check-in de tobillo). */
    tendonPain: number | null;
  };
};

/** Compuestos cuyo e1RM cae en dos sesiones seguidas (tres sesiones, cada una por debajo de la anterior). */
async function droppingLiftsTx(tx: Tx, date: string): Promise<LoadStatus["signals"]["e1rmDropping"]> {
  const rows = await tx.query<{ exerciseId: string; name: string; workoutId: string; kg: number; reps: number; rir: number | null }>(
    `select x."exerciseId", x.name, x."workoutId", x.kg, x.reps, x.rir from (
       select s.exercise_id as "exerciseId", e.name, w.id as "workoutId", s.kg, s.reps, s.rir, s.set_index,
              dense_rank() over (partition by s.exercise_id order by w.date desc, w.created_at desc, w.id) as rk
       from fit.workout_sets s join fit.workouts w on w.id = s.workout_id join fit.exercises e on e.id = s.exercise_id
       where w.status = 'hecha' and e.kind = 'compuesto' and w.date > $1 and w.date <= $2
         and s.set_type <> 'aproximacion' and s.kg > 0 and s.reps > 0
     ) x where x.rk <= 3 order by x."exerciseId", x.rk, x.set_index`, [addDays(date, -42), date]);
  const byExercise = new Map<string, { name: string; sessions: Map<string, SetLog[]> }>();
  for (const r of rows) {
    const e = byExercise.get(r.exerciseId) ?? { name: r.name, sessions: new Map<string, SetLog[]>() };
    e.sessions.set(r.workoutId, [...(e.sessions.get(r.workoutId) ?? []), { kg: r.kg, reps: r.reps, rir: r.rir }]);
    byExercise.set(r.exerciseId, e);
  }
  const out: LoadStatus["signals"]["e1rmDropping"] = [];
  for (const [exerciseId, e] of byExercise) {
    // De la más reciente a la más antigua (orden de inserción = rk).
    const v = [...e.sessions.values()].map((s) => bestE1RM(s)?.value ?? 0);
    if (v.length === 3 && v.every((x) => x > 0) && v[0] < v[1] * 0.995 && v[1] < v[2] * 0.995)
      out.push({ exerciseId, name: e.name, e1rm: v.map(round1).reverse() });
  }
  return out;
}

export async function loadStatusTx(tx: Tx, date: string): Promise<LoadStatus> {
  const a = acwr(await loadSessionsTx(tx, date), date);
  const sets = await tx.query<{ muscle: string; kg: number; reps: number; rir: number | null }>(
    `select e.primary_muscle as muscle, s.kg, s.reps, s.rir
     from fit.workout_sets s join fit.workouts w on w.id = s.workout_id join fit.exercises e on e.id = s.exercise_id
     where w.status <> 'saltada' and w.date > $1 and w.date <= $2 and s.set_type <> 'aproximacion'
       and s.kg is not null and s.reps > 0 and e.primary_muscle is not null`, [addDays(date, -7), date]);
  const names = new Map((await tx.query<{ id: string; name: string }>("select id, name from fit.muscle_groups")).map((m) => [m.id, m.name]));
  const byMuscle = new Map<string, SetLog[]>();
  for (const s of sets) byMuscle.set(s.muscle, [...(byMuscle.get(s.muscle) ?? []), { kg: s.kg, reps: s.reps, rir: s.rir }]);
  const muscleStress = [...byMuscle]
    .map(([muscleId, list]) => ({ muscleId, name: names.get(muscleId) ?? muscleId, ...weeklyStress(list), sets: list.length }))
    .sort((x, y) => y.value - x.value);

  const [r7] = await tx.query<{ avg: number | null }>(
    "select avg(readiness)::float8 as avg from fit.checkins where readiness is not null and date > $1 and date <= $2", [addDays(date, -7), date]);
  const e1rmDropping = await droppingLiftsTx(tx, date);
  const examPeriod = await isExamPeriodTx(tx, date);
  const readiness7dAvg = r7?.avg != null ? round1(Number(r7.avg)) : null;
  const maxWeeklyStress = muscleStress.length ? muscleStress[0].value : null;
  // Horas de cada noche: lo que diga el check-in y, si no, lo que midió el reloj (daily_activity, por Health Connect).
  const [sleep] = await tx.query<{ short: number; logged: number }>(
    `select count(*) filter (where h < 7)::int as short, count(h)::int as logged from (
       select coalesce(c.sleep_hours, a.sleep_minutes / 60.0) as h
       from (select date, sleep_hours from fit.checkins where sleep_hours is not null and date > $1 and date <= $2) c
       full join (select date, sleep_minutes from fit.daily_activity where sleep_minutes is not null and date > $1 and date <= $2) a
         on a.date = c.date
     ) x`, [addDays(date, -7), date]);
  const shortSleepNights = sleep?.logged ? sleep.short : null;
  const [tendon] = await tx.query<{ pain: number | null }>(
    `select greatest(
       (select max(l.pain) from fit.injury_logs l join fit.injuries i on i.id = l.injury_id
         where i.status <> 'cerrada' and l.date > $1 and l.date <= $2),
       (select max(ankle_pain) from fit.checkins where ankle_pain is not null and date > $1 and date <= $2)) as pain`,
    [addDays(date, -3), date]);
  const tendonPain = tendon?.pain != null ? Number(tendon.pain) : null;
  const d = deloadDecision({
    e1rmDropping: e1rmDropping.length > 0, readiness7dAvg, maxWeeklyStress, acwrRatio: a.ratio, externalStress: examPeriod, shortSleepNights, tendonPain,
  });
  return {
    date,
    acwr: { acute: a.acute, chronic: a.chronic, ratio: a.ratio, zone: a.zone, days: a.days, reliable: a.reliable,
      label: a.zone ? ACWR_LABEL[a.zone] : a.days ? `Faltan ${Math.max(1, 21 - a.days)} días de historial para que el ratio diga algo.` : "Sin sesiones registradas." },
    muscleStress,
    deload: { deload: d.deload, signals: d.signals, plan: d.plan, maintenance: d.maintenance },
    signals: { e1rmDropping, readiness7dAvg, maxWeeklyStress, examPeriod, shortSleepNights, tendonPain },
  };
}

export async function getLoadStatus(userId: string, input?: DateInput, db?: Db): Promise<LoadStatus> {
  const date = parseDateInput(input);
  return withUser(userId, async (tx) => loadStatusTx(tx, await dateOrToday(tx, date)), db);
}

/* ───────────────────────── Volumen ───────────────────────── */

export const GetVolumeStatusInput = z.object({
  microcycleId: Uuid.optional().describe("Id del microciclo a medir. Sin él ni fechas, el microciclo actual (o los últimos 7 días si no hay plan)"),
  from: IsoDate.optional().describe("Primer día del periodo (AAAA-MM-DD)"),
  to: IsoDate.optional().describe("Último día del periodo (AAAA-MM-DD)"),
});
export type GetVolumeStatusInput = z.input<typeof GetVolumeStatusInput>;

export type VolumeRow = {
  muscleId: string;
  name: string;
  region: string;
  /** Series efectivas del periodo (1 al principal, 0,5 a cada sinergista). */
  sets: number;
  /** Las mismas series llevadas a 7 días, para comparar con MEV y MRV, que son semanales. */
  setsPerWeek: number;
  mev: number;
  mrv: number;
  status: VolumeStatus;
  /** Parte de los ejercicios del grupo que progresan (0 a 1). Null sin dos sesiones que comparar. */
  progressRate: number | null;
  advice: { action: "mantener" | "bajar" | "subir" | "revisar"; why: string };
};

export type VolumeStatusResult = {
  from: string; to: string; days: number; microcycleId: string | null; muscles: VolumeRow[]; unclassifiedSets: number;
  /** Fase de nutrición vigente en `to` es déficit: las series se congelan en 12-16 por grupo. */
  inDeficit: boolean;
};

export async function getVolumeStatus(userId: string, input?: GetVolumeStatusInput, db?: Db): Promise<VolumeStatusResult> {
  const i = parseInput(GetVolumeStatusInput, input ?? {});
  if ((i.from && !i.to) || (!i.from && i.to)) throw invalid("Indica las dos fechas del periodo.");
  if (i.from && i.to && i.from > i.to) throw invalid("El periodo termina antes de empezar.");
  return withUser(userId, async (tx) => {
    const today = await dateOrToday(tx);
    let from = i.from ?? addDays(today, -6);
    let to = i.to ?? today;
    let microcycleId: string | null = null;
    if (i.microcycleId) {
      const [m] = await tx.query<{ from: string; to: string }>('select start_date as "from", end_date as "to" from fit.microcycles where id = $1', [i.microcycleId]);
      if (!m) throw notFound("El microciclo");
      [from, to, microcycleId] = [m.from, m.to, i.microcycleId];
    } else if (!i.from) {
      const plan = await activePlanTx(tx, today);
      if (plan && !plan.beyondEnd && plan.microcycle.startDate <= today)
        [from, to, microcycleId] = [plan.microcycle.startDate, plan.microcycle.endDate, plan.microcycle.id];
    }
    const days = diffDays(from, to) + 1;
    const [nt] = await tx.query<{ phase: string }>(
      "select phase from fit.nutrition_targets where valid_from <= $1::date order by valid_from desc limit 1", [to]);
    const inDeficit = nt?.phase === "deficit";

    const rows = await tx.query<{ exerciseId: string; primaryMuscle: string | null; secondaryMuscles: string[]; kg: number; reps: number; rir: number | null }>(
      `select s.exercise_id as "exerciseId", e.primary_muscle as "primaryMuscle", e.secondary_muscles as "secondaryMuscles", s.kg, s.reps, s.rir
       from fit.workout_sets s join fit.workouts w on w.id = s.workout_id join fit.exercises e on e.id = s.exercise_id
       where w.status <> 'saltada' and w.date >= $1 and w.date <= $2 and s.set_type <> 'aproximacion' and s.kg is not null and s.reps > 0`, [from, to]);
    const perExercise = new Map<string, MuscleEntry & { id: string }>();
    let unclassifiedSets = 0;
    for (const r of rows) {
      if (!r.primaryMuscle) { unclassifiedSets++; continue; }
      const e = perExercise.get(r.exerciseId) ?? { id: r.exerciseId, primary: r.primaryMuscle, secondary: r.secondaryMuscles, sets: [] };
      e.sets.push({ kg: r.kg, reps: r.reps, rir: r.rir });
      perExercise.set(r.exerciseId, e);
    }
    const entries = [...perExercise.values()];
    const hard = hardSetsByMuscle(entries);

    // Progreso: las dos últimas sesiones hechas de cada ejercicio trabajado en el periodo.
    const history = await historyTx(tx, entries.map((e) => e.id), { upTo: to, sessions: 2 });
    const muscles = (await listMuscleGroupsTx(tx)).map((m): VolumeRow => {
      const sets = round1(hard[m.id] ?? 0);
      const setsPerWeek = weeklyEquivalentSets(sets, days);
      const pairs = entries.filter((e) => e.primary === m.id).map((e) => history.get(e.id) ?? []).filter((h) => h.length >= 2)
        .map((h) => ({ last: h[0], prev: h[1] }));
      const rate = progressRate(pairs);
      const status = volumeStatus(setsPerWeek, m.mev, m.mrv);
      return { muscleId: m.id, name: m.name, region: m.region, sets, setsPerWeek, mev: m.mev, mrv: m.mrv, status,
        progressRate: rate == null ? null : round2(rate),
        // En déficit solo se aplica la congelación a los grupos que se entrenan: uno sin series no tiene que llegar a 12.
        advice: volumeAdvice(rate, status, inDeficit && setsPerWeek > 0 ? { setsPerWeek } : null) };
    });
    return { from, to, days, microcycleId, muscles, unclassifiedSets, inDeficit };
  }, db);
}

/* ───────────────────────── e1RM por sesión ───────────────────────── */

export type E1rmPoint = { date: string; workoutId: string; e1rm: number; confidence: Confidence; kg: number; reps: number; rir: number | null };

/** Mejor e1RM de cada sesión hecha, de la más antigua a la más reciente. */
async function e1rmSeriesTx(tx: Tx, exerciseIds: string[], from: string | null, to: string | null): Promise<Map<string, E1rmPoint[]>> {
  const out = new Map<string, E1rmPoint[]>(exerciseIds.map((id) => [id, []]));
  if (!exerciseIds.length) return out;
  const rows = await tx.query<{ exerciseId: string; workoutId: string; date: string; kg: number; reps: number; rir: number | null }>(
    `select s.exercise_id as "exerciseId", w.id as "workoutId", w.date, s.kg, s.reps, s.rir
     from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
     where w.status = 'hecha' and s.exercise_id = any($1::uuid[]) and s.set_type <> 'aproximacion' and s.kg > 0 and s.reps > 0
       and ($2::date is null or w.date >= $2) and ($3::date is null or w.date <= $3)
     order by s.exercise_id, w.date, w.created_at, w.id, s.set_index`, [exerciseIds, from, to]);
  const flush = (exerciseId: string, workoutId: string, date: string, sets: SetLog[]) => {
    const best = bestE1RM(sets);
    if (!best) return;
    const top = sets.find((s) => { const e = bestE1RM([s]); return e?.value === best.value && e.confidence === best.confidence; })!;
    out.get(exerciseId)!.push({ date, workoutId, e1rm: round2(best.value), confidence: best.confidence, kg: top.kg, reps: top.reps, rir: top.rir });
  };
  let cur: { exerciseId: string; workoutId: string; date: string; sets: SetLog[] } | null = null;
  for (const r of rows) {
    if (!cur || cur.exerciseId !== r.exerciseId || cur.workoutId !== r.workoutId) {
      if (cur) flush(cur.exerciseId, cur.workoutId, cur.date, cur.sets);
      cur = { exerciseId: r.exerciseId, workoutId: r.workoutId, date: r.date, sets: [] };
    }
    cur.sets.push({ kg: r.kg, reps: r.reps, rir: r.rir });
  }
  if (cur) flush(cur.exerciseId, cur.workoutId, cur.date, cur.sets);
  return out;
}

export const GetE1rmSeriesInput = z.object({ exerciseId: Uuid.describe("Id del ejercicio") });

export async function getE1rmSeries(userId: string, input: z.input<typeof GetE1rmSeriesInput> | string, db?: Db): Promise<E1rmPoint[]> {
  const { exerciseId } = parseInput(GetE1rmSeriesInput, typeof input === "string" ? { exerciseId: input } : input);
  return withUser(userId, async (tx) => (await e1rmSeriesTx(tx, [exerciseId], null, null)).get(exerciseId) ?? [], db);
}

/* ───────────────────────── Progreso ───────────────────────── */

export const GetProgressInput = z.object({
  days: z.number().int().min(14).max(730).default(90).describe("Ventana en días hacia atrás, contando el último"),
  to: IsoDate.optional().describe("Último día de la ventana (AAAA-MM-DD). Por defecto, hoy"),
});

export type Progress = {
  from: string;
  to: string;
  weight: {
    series: { date: string; kg: number; trend: number }[];
    /** % del peso por semana con la tendencia de 14 días (negativo = bajando). Null con pocos datos. */
    weeklyRatePct: number | null;
    current: number | null;
    change: number | null;
  };
  waist: { series: { date: string; cm: number }[]; change: number | null };
  /** e1RM por sesión de los 6 ejercicios con más sesiones en la ventana. */
  lifts: { exerciseId: string; name: string; sessions: number; series: E1rmPoint[]; changePct: number | null }[];
  acwr: { date: string; acute: number; chronic: number; ratio: number | null }[];
  sessionsPerWeek: { weekStart: string; done: number }[];
  /** Sesiones hechas frente a las previstas en el plan activo dentro de la ventana. Null sin plan. */
  adherence: { done: number; planned: number; pct: number | null } | null;
};

export async function getProgress(userId: string, input?: z.input<typeof GetProgressInput>, db?: Db): Promise<Progress> {
  const { days, to: until } = parseInput(GetProgressInput, input ?? {});
  return withUser(userId, async (tx) => {
    const to = await dateOrToday(tx, until);
    const from = addDays(to, -(days - 1));

    const body = await tx.query<{ date: string; kg: number | null; cm: number | null }>(
      "select date, weight_kg as kg, waist_cm as cm from fit.body_metrics where date >= $1 and date <= $2 order by date", [from, to]);
    const points = body.filter((b): b is { date: string; kg: number; cm: number | null } => b.kg != null).map((b) => ({ date: b.date, kg: b.kg }));
    const trend = weightTrend(points).map((p) => ({ date: p.date, kg: p.kg, trend: round2(p.trend) }));
    const waist = body.filter((b): b is { date: string; kg: number | null; cm: number } => b.cm != null).map((b) => ({ date: b.date, cm: b.cm }));

    const top = await tx.query<{ exerciseId: string; name: string; sessions: number }>(
      `select s.exercise_id as "exerciseId", e.name, count(distinct w.id)::int as sessions
       from fit.workout_sets s join fit.workouts w on w.id = s.workout_id join fit.exercises e on e.id = s.exercise_id
       where w.status = 'hecha' and w.date >= $1 and w.date <= $2 and s.set_type <> 'aproximacion' and s.kg > 0 and s.reps > 0 and e.kind <> 'cardio'
       group by s.exercise_id, e.name order by sessions desc, e.name limit 6`, [from, to]);
    const series = await e1rmSeriesTx(tx, top.map((t) => t.exerciseId), from, to);
    const lifts = top.map((t) => {
      const s = series.get(t.exerciseId) ?? [];
      return { ...t, series: s, changePct: s.length >= 2 ? round1(((s[s.length - 1].e1rm - s[0].e1rm) / s[0].e1rm) * 100) : null };
    });

    const sessions = await loadSessionsTx(tx, to);
    const a = acwr(sessions, to);
    const first = sessions.length ? sessions.reduce((m, s) => (s.date < m ? s.date : m), sessions[0].date) : to;
    const acwrSeries = a.series.acute
      .map((acute, k) => {
        const chronic = a.series.chronic[k];
        return { date: addDays(first, k), acute: Math.round(acute), chronic: Math.round(chronic), ratio: k >= 20 && chronic > 0 ? round2(acute / chronic) : null };
      })
      .filter((p) => p.date >= from);

    const done = await tx.query<{ date: string }>("select date from fit.workouts where status = 'hecha' and date >= $1 and date <= $2", [from, to]);
    const weeks = new Map<string, number>();
    for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.set(w, 0);
    for (const d of done) weeks.set(weekStart(d.date), (weeks.get(weekStart(d.date)) ?? 0) + 1);

    let adherence: Progress["adherence"] = null;
    const plan = await activePlanTx(tx, to);
    if (plan) {
      const micros = await tx.query<{ startDate: string; lengthDays: number; planned: number; done: number }>(
        `select m.start_date as "startDate", m.length_days as "lengthDays",
           (select count(*)::int from fit.session_templates t where t.mesocycle_id = m.mesocycle_id and not t.is_rest) as planned,
           (select count(*)::int from fit.workouts w where w.microcycle_id = m.id and w.status = 'hecha') as done
         from fit.microcycles m join fit.mesocycles me on me.id = m.mesocycle_id
         where me.macrocycle_id = $1 and m.start_date <= $2 and m.end_date >= $3 order by m.start_date`, [plan.macrocycle.id, to, from]);
      // El microciclo en curso solo cuenta por la parte ya transcurrida.
      const planned = micros.reduce((sum, m) => sum + (m.planned * Math.min(m.lengthDays, diffDays(m.startDate, to) + 1)) / m.lengthDays, 0);
      const doneN = micros.reduce((sum, m) => sum + m.done, 0);
      adherence = { done: doneN, planned: round1(planned), pct: planned > 0 ? Math.min(100, Math.round((doneN / planned) * 100)) : null };
    }

    return {
      from, to,
      weight: {
        series: trend, weeklyRatePct: weeklyRatePct(points),
        current: trend.length ? trend[trend.length - 1].trend : null,
        change: trend.length >= 2 ? round2(trend[trend.length - 1].trend - trend[0].trend) : null,
      },
      waist: { series: waist, change: waist.length >= 2 ? round1(waist[waist.length - 1].cm - waist[0].cm) : null },
      lifts, acwr: acwrSeries,
      sessionsPerWeek: [...weeks].map(([w, n]) => ({ weekStart: w, done: n })),
      adherence,
    };
  }, db);
}
