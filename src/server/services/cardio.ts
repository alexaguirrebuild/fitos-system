/**
 * Cardio y actividad diaria: sesiones (zona, ECOS, regla del tobillo), semana de cardio y pasos/sueño/FC del día.
 * Las fórmulas viven en src/engine/cardio.ts.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { ecos, hrZones, strengthEnduranceRatio, zoneOf } from "@/engine/cardio";
import { addDays, todayIn, weekStart as mondayOf } from "@/server/time";
import { IsoDate, IsoDateTime, addAnnotationTx, athleteTz, parseInput, toIso } from "./annotations";

export const CARDIO_MODES = ["bici", "eliptica", "cinta_andando", "caminar", "remo", "natacion", "carrera", "hiit", "otro"] as const;
export type CardioMode = (typeof CARDIO_MODES)[number];
const IMPACT_MODES: CardioMode[] = ["carrera", "hiit"];
export const ANKLE_PAIN_LIMIT = 3;
export const ANKLE_WARNING = "El tobillo manda: con dolor por encima de 3, hoy mejor bici o elíptica que impacto.";

export type CardioSession = {
  id: string;
  date: string;
  startedAt: string | null;
  mode: CardioMode;
  minutes: number;
  avgHr: number | null;
  maxHr: number | null;
  zone: number | null;
  distanceKm: number | null;
  kcal: number | null;
  ecos: number | null;
  impact: boolean;
  anklePainBefore: number | null;
  anklePainAfter: number | null;
  note: string | null;
  source: string;
  sourceId: string | null;
};

type CardioRow = {
  id: string; date: string; started_at: Date | string | null; mode: CardioMode; minutes: number; avg_hr: number | null; max_hr: number | null;
  zone: number | null; distance_km: number | null; kcal: number | null; ecos: number | null; impact: boolean;
  ankle_pain_before: number | null; ankle_pain_after: number | null; note: string | null; source: string; source_id: string | null;
};

const toSession = (r: CardioRow): CardioSession => ({
  id: r.id, date: r.date, startedAt: toIso(r.started_at), mode: r.mode, minutes: r.minutes, avgHr: r.avg_hr, maxHr: r.max_hr, zone: r.zone,
  distanceKm: r.distance_km, kcal: r.kcal, ecos: r.ecos, impact: r.impact, anklePainBefore: r.ankle_pain_before, anklePainAfter: r.ankle_pain_after,
  note: r.note, source: r.source, sourceId: r.source_id,
});

type HrProfile = { birth_date: string | null; hr_rest: number | null; timezone: string };

function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

async function hrProfile(tx: Tx): Promise<HrProfile> {
  const r = await tx.query<HrProfile>("select birth_date, hr_rest, timezone from fit.athletes limit 1");
  return r[0] ?? { birth_date: null, hr_rest: null, timezone: "Europe/Madrid" };
}

/** Último dolor de tobillo conocido hasta `date`: lesión de tobillo abierta o check-in, lo más reciente. */
async function lastAnklePain(tx: Tx, date: string): Promise<{ pain: number; date: string } | null> {
  const rows = await tx.query<{ pain: number; date: string }>(
    `select pain, date from (
       select l.pain::int as pain, l.date, l.created_at from fit.injury_logs l
         join fit.injuries i on i.id = l.injury_id
        where i.status = 'abierta' and lower(i.zone) like '%tobillo%' and l.date <= $1::date
       union all
       select c.ankle_pain::int, c.date, c.created_at from fit.checkins c where c.ankle_pain is not null and c.date <= $1::date
     ) x order by date desc, pain desc limit 1`,
    [date],
  );
  return rows[0] ?? null;
}

/* ------------------------------- Sesiones ------------------------------- */

export const LogCardioInput = z.object({
  date: IsoDate.optional().describe("Día de la sesión (AAAA-MM-DD). Por defecto, hoy."),
  mode: z.enum(CARDIO_MODES).describe("Tipo: bici, eliptica, cinta_andando, caminar, remo, natacion, carrera, hiit u otro."),
  minutes: z.number().positive().max(900).describe("Duración en minutos."),
  avgHr: z.number().int().min(30).max(240).optional().describe("Frecuencia cardiaca media (ppm)."),
  maxHr: z.number().int().min(30).max(250).optional().describe("Frecuencia cardiaca máxima (ppm)."),
  distanceKm: z.number().min(0).max(1000).optional().describe("Distancia en kilómetros."),
  kcal: z.number().int().min(0).max(20_000).optional().describe("Calorías que marca el aparato o el reloj."),
  anklePainBefore: z.number().int().min(0).max(10).optional().describe("Dolor de tobillo antes de empezar, de 0 a 10."),
  anklePainAfter: z.number().int().min(0).max(10).optional().describe("Dolor de tobillo al terminar, de 0 a 10."),
  note: z.string().trim().max(1000).optional().describe("Nota libre."),
  source: z.string().trim().min(1).max(60).optional().describe("De dónde viene el dato (app, reloj, health_connect…). Por defecto, app."),
  sourceId: z.string().trim().min(1).max(200).optional().describe("Identificador en el origen: reenviar el mismo no duplica la sesión."),
  startedAt: IsoDateTime.optional().describe("Hora de inicio (ISO 8601)."),
});
export type LogCardioInput = z.input<typeof LogCardioInput>;

export type LogCardioResult = { session: CardioSession; created: boolean; warnings: string[]; annotationId: string | null };

/** Para usar dentro de una transacción ya abierta (ingesta de salud). */
export async function logCardioTx(tx: Tx, userId: string, i: z.output<typeof LogCardioInput>): Promise<LogCardioResult> {
  const prof = await hrProfile(tx);
  const date = i.date ?? todayIn(prof.timezone);
  const warnings: string[] = [];

  let zone: number | null = null;
  if (i.avgHr != null) {
    if (prof.birth_date && prof.hr_rest != null) zone = zoneOf(i.avgHr, ageOn(prof.birth_date, date), prof.hr_rest);
    else warnings.push(`Sin zona de FC: falta ${[!prof.birth_date && "la fecha de nacimiento", prof.hr_rest == null && "la FC en reposo"].filter(Boolean).join(" y ")} en tu ficha.`);
  }
  const load = zone == null ? null : ecos(i.minutes, zone, i.mode);
  const impact = IMPACT_MODES.includes(i.mode);

  const rows = await tx.query<CardioRow & { inserted: boolean }>(
    `insert into fit.cardio_sessions (user_id, date, started_at, mode, minutes, avg_hr, max_hr, zone, distance_km, kcal, ecos, impact,
       ankle_pain_before, ankle_pain_after, note, source, source_id)
     values ($1::uuid, $2::date, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (user_id, source, source_id) do update set
       date = excluded.date, started_at = coalesce(excluded.started_at, fit.cardio_sessions.started_at), mode = excluded.mode, minutes = excluded.minutes,
       avg_hr = coalesce(excluded.avg_hr, fit.cardio_sessions.avg_hr), max_hr = coalesce(excluded.max_hr, fit.cardio_sessions.max_hr),
       zone = coalesce(excluded.zone, fit.cardio_sessions.zone), distance_km = coalesce(excluded.distance_km, fit.cardio_sessions.distance_km),
       kcal = coalesce(excluded.kcal, fit.cardio_sessions.kcal), ecos = coalesce(excluded.ecos, fit.cardio_sessions.ecos), impact = excluded.impact,
       ankle_pain_before = coalesce(excluded.ankle_pain_before, fit.cardio_sessions.ankle_pain_before),
       ankle_pain_after = coalesce(excluded.ankle_pain_after, fit.cardio_sessions.ankle_pain_after),
       note = coalesce(excluded.note, fit.cardio_sessions.note)
     returning *, (xmax = 0) as inserted`,
    [userId, date, i.startedAt ? new Date(i.startedAt).toISOString() : null, i.mode, Math.round(i.minutes * 10) / 10, i.avgHr ?? null, i.maxHr ?? null,
      zone, i.distanceKm ?? null, i.kcal ?? null, load, impact, i.anklePainBefore ?? null, i.anklePainAfter ?? null, i.note ?? null,
      i.source ?? "app", i.sourceId ?? null],
  );
  const row = rows[0];

  let annotationId: string | null = null;
  if (impact) {
    const known = await lastAnklePain(tx, date);
    const pain = Math.max(i.anklePainBefore ?? -1, known?.pain ?? -1);
    if (pain > ANKLE_PAIN_LIMIT) {
      warnings.push(ANKLE_WARNING);
      if (row.inserted) {
        const a = await addAnnotationTx(tx, userId, {
          date, scope: "tobillo", severity: "aviso", rule: "tobillo_impacto", refTable: "cardio_sessions", refId: row.id,
          title: `Cardio de impacto con el tobillo en ${pain}/10`,
          body: `${i.mode === "carrera" ? "Carrera" : "HIIT"} de ${row.minutes} min con dolor de tobillo ${pain}/10${i.anklePainBefore == null && known ? ` (dato del ${known.date})` : ""}. ${ANKLE_WARNING}`,
        });
        annotationId = a.id;
      }
    }
  }
  return { session: toSession(row), created: row.inserted, warnings, annotationId };
}

/** Registra una sesión de cardio. Con dolor de tobillo > 3 y modalidad de impacto no bloquea: avisa y deja una anotación. */
export async function logCardio(userId: string, input: LogCardioInput, db?: Db): Promise<LogCardioResult> {
  const i = parseInput(LogCardioInput, input);
  return withUser(userId, (tx) => logCardioTx(tx, userId, i), db);
}

export const GetCardioWeekInput = z.object({
  weekStart: IsoDate.optional().describe("Lunes de la semana (o cualquier día de ella). Por defecto, la semana actual."),
  z2TargetMin: z.number().int().min(0).max(2000).optional().describe("Objetivo de minutos semanales en zona 2. Por defecto, 150."),
});
export type GetCardioWeekInput = z.input<typeof GetCardioWeekInput>;

export type CardioWeek = {
  weekStart: string;
  weekEnd: string;
  sessions: CardioSession[];
  sessionCount: number;
  minutesTotal: number;
  /** Claves '0'…'5' y 'sin_zona'. */
  minutesByZone: Record<string, number>;
  z2: { minutes: number; targetMin: number; remainingMin: number; pct: number | null };
  ecosTotal: number;
  strength: { sessions: number; ratio: number | null; ok: boolean };
  hrZones: ReturnType<typeof hrZones> | null;
  warnings: string[];
};

export async function getCardioWeek(userId: string, input: GetCardioWeekInput = {}, db?: Db): Promise<CardioWeek> {
  const i = parseInput(GetCardioWeekInput, input);
  return withUser(userId, async (tx) => {
    const prof = await hrProfile(tx);
    const today = todayIn(prof.timezone);
    const ws = mondayOf(i.weekStart ?? today);
    const we = addDays(ws, 6);
    const rows = await tx.query<CardioRow>("select * from fit.cardio_sessions where date between $1::date and $2::date order by date, started_at nulls last, created_at", [ws, we]);
    const strength = await tx.query<{ n: number }>(
      `select count(*)::int as n from fit.workouts w left join fit.session_templates st on st.id = w.session_template_id
        where w.date between $1::date and $2::date and w.status = 'hecha' and coalesce(st.is_cardio, false) = false`,
      [ws, we],
    );
    const sessions = rows.map(toSession);
    const minutesByZone: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, sin_zona: 0 };
    for (const s of sessions) minutesByZone[s.zone == null ? "sin_zona" : String(s.zone)] += s.minutes;
    for (const k of Object.keys(minutesByZone)) minutesByZone[k] = Math.round(minutesByZone[k] * 10) / 10;
    const targetMin = i.z2TargetMin ?? 150;
    const z2 = minutesByZone["2"];
    const canZones = prof.birth_date != null && prof.hr_rest != null;
    return {
      weekStart: ws, weekEnd: we, sessions, sessionCount: sessions.length,
      minutesTotal: Math.round(sessions.reduce((a, s) => a + s.minutes, 0) * 10) / 10,
      minutesByZone,
      z2: { minutes: z2, targetMin, remainingMin: Math.max(0, Math.round((targetMin - z2) * 10) / 10), pct: targetMin > 0 ? Math.round((z2 / targetMin) * 100) : null },
      ecosTotal: sessions.reduce((a, s) => a + (s.ecos ?? 0), 0),
      strength: { sessions: strength[0].n, ...strengthEnduranceRatio(strength[0].n, sessions.length) },
      hrZones: canZones ? hrZones(ageOn(prof.birth_date!, today), prof.hr_rest!) : null,
      warnings: canZones ? [] : ["Sin zonas de FC: falta la fecha de nacimiento o la FC en reposo en tu ficha."],
    };
  }, db);
}

/* --------------------------- Actividad diaria --------------------------- */

export type DailyActivity = {
  date: string;
  steps: number | null;
  activeKcal: number | null;
  restingHr: number | null;
  hrvMs: number | null;
  sleepMinutes: number | null;
  sleepDeepMin: number | null;
  sleepRemMin: number | null;
  sleepScore: number | null;
  bedAt: string | null;
  wokeAt: string | null;
  screenHours: number | null;
  source: string;
};

type ActivityRow = {
  date: string; steps: number | null; active_kcal: number | null; resting_hr: number | null; hrv_ms: number | null; sleep_minutes: number | null;
  sleep_deep_min: number | null; sleep_rem_min: number | null; sleep_score: number | null; bed_at: Date | string | null; woke_at: Date | string | null;
  screen_hours: number | null; source: string;
};

const toActivity = (r: ActivityRow): DailyActivity => ({
  date: r.date, steps: r.steps, activeKcal: r.active_kcal, restingHr: r.resting_hr, hrvMs: r.hrv_ms, sleepMinutes: r.sleep_minutes,
  sleepDeepMin: r.sleep_deep_min, sleepRemMin: r.sleep_rem_min, sleepScore: r.sleep_score, bedAt: toIso(r.bed_at), wokeAt: toIso(r.woke_at),
  screenHours: r.screen_hours, source: r.source,
});

export const UpsertDailyActivityInput = z.object({
  date: IsoDate.describe("Día (AAAA-MM-DD)."),
  steps: z.number().int().min(0).max(200_000).optional().describe("Pasos del día."),
  restingHr: z.number().int().min(25).max(150).optional().describe("Frecuencia cardiaca en reposo (ppm)."),
  hrvMs: z.number().min(1).max(500).optional().describe("Variabilidad de la FC (ms)."),
  sleepMinutes: z.number().int().min(0).max(1440).optional().describe("Minutos de sueño."),
  sleepDeepMin: z.number().int().min(0).max(1440).optional().describe("Minutos de sueño profundo."),
  sleepRemMin: z.number().int().min(0).max(1440).optional().describe("Minutos de sueño REM."),
  sleepScore: z.number().int().min(0).max(100).optional().describe("Puntuación de sueño del reloj (0-100)."),
  bedAt: IsoDateTime.optional().describe("Hora de acostarse (ISO 8601)."),
  wokeAt: IsoDateTime.optional().describe("Hora de despertarse (ISO 8601)."),
  activeKcal: z.number().int().min(0).max(20_000).optional().describe("Calorías activas del día."),
  screenHours: z.number().min(0).max(24).optional().describe("Horas de pantalla."),
  source: z.string().trim().min(1).max(60).optional().describe("De dónde viene el dato. Por defecto, app."),
});
export type UpsertDailyActivityInput = z.input<typeof UpsertDailyActivityInput>;

/** Mezcla: lo que no viene no se toca (nunca pisa con null). Para usar dentro de una transacción ya abierta. */
export async function upsertDailyActivityTx(tx: Tx, userId: string, i: z.output<typeof UpsertDailyActivityInput>): Promise<DailyActivity> {
  const iso = (s?: string) => (s ? new Date(s).toISOString() : null);
  const rows = await tx.query<ActivityRow>(
    `insert into fit.daily_activity as d (user_id, date, steps, active_kcal, resting_hr, hrv_ms, sleep_minutes, sleep_deep_min, sleep_rem_min, sleep_score,
       bed_at, woke_at, screen_hours, source)
     values ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13, coalesce($14, 'app'))
     on conflict (user_id, date) do update set
       steps = coalesce(excluded.steps, d.steps), active_kcal = coalesce(excluded.active_kcal, d.active_kcal),
       resting_hr = coalesce(excluded.resting_hr, d.resting_hr), hrv_ms = coalesce(excluded.hrv_ms, d.hrv_ms),
       sleep_minutes = coalesce(excluded.sleep_minutes, d.sleep_minutes), sleep_deep_min = coalesce(excluded.sleep_deep_min, d.sleep_deep_min),
       sleep_rem_min = coalesce(excluded.sleep_rem_min, d.sleep_rem_min), sleep_score = coalesce(excluded.sleep_score, d.sleep_score),
       bed_at = coalesce(excluded.bed_at, d.bed_at), woke_at = coalesce(excluded.woke_at, d.woke_at),
       screen_hours = coalesce(excluded.screen_hours, d.screen_hours), source = coalesce($14, d.source), updated_at = now()
     returning *`,
    [userId, i.date, i.steps ?? null, i.activeKcal ?? null, i.restingHr ?? null, i.hrvMs ?? null, i.sleepMinutes ?? null, i.sleepDeepMin ?? null,
      i.sleepRemMin ?? null, i.sleepScore ?? null, iso(i.bedAt), iso(i.wokeAt), i.screenHours ?? null, i.source ?? null],
  );
  return toActivity(rows[0]);
}

export async function upsertDailyActivity(userId: string, input: UpsertDailyActivityInput, db?: Db): Promise<DailyActivity> {
  const i = parseInput(UpsertDailyActivityInput, input);
  return withUser(userId, (tx) => upsertDailyActivityTx(tx, userId, i), db);
}

export const LogStepsInput = z.object({
  date: IsoDate.optional().describe("Día (AAAA-MM-DD). Por defecto, hoy."),
  steps: z.number().int().min(0).max(200_000).describe("Pasos totales del día (sustituye al dato anterior)."),
  source: z.string().trim().min(1).max(60).optional().describe("De dónde viene el dato. Por defecto, app."),
});
export type LogStepsInput = z.input<typeof LogStepsInput>;

export async function logSteps(userId: string, input: LogStepsInput, db?: Db): Promise<DailyActivity> {
  const i = parseInput(LogStepsInput, input);
  return withUser(userId, async (tx) => {
    const date = i.date ?? todayIn(await athleteTz(tx));
    return upsertDailyActivityTx(tx, userId, { date, steps: i.steps, source: i.source ?? "app" });
  }, db);
}

export const GetActivityInput = z.object({
  days: z.number().int().min(1).max(365).describe("Cuántos días hacia atrás, contando hoy."),
});
export type GetActivityInput = z.input<typeof GetActivityInput>;

export type ActivitySummary = {
  from: string;
  to: string;
  days: DailyActivity[];
  avg: { steps: number | null; sleepMinutes: number | null; restingHr: number | null; hrvMs: number | null };
};

export async function getActivity(userId: string, input: GetActivityInput, db?: Db): Promise<ActivitySummary> {
  const i = parseInput(GetActivityInput, input);
  return withUser(userId, async (tx) => {
    const to = todayIn(await athleteTz(tx));
    const from = addDays(to, -(i.days - 1));
    const rows = await tx.query<ActivityRow>("select * from fit.daily_activity where date between $1::date and $2::date order by date", [from, to]);
    const days = rows.map(toActivity);
    const mean = (xs: (number | null)[], d = 0) => {
      const v = xs.filter((x): x is number => x != null);
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10 ** d) / 10 ** d : null;
    };
    return {
      from, to, days,
      avg: { steps: mean(days.map((x) => x.steps)), sleepMinutes: mean(days.map((x) => x.sleepMinutes)), restingHr: mean(days.map((x) => x.restingHr)), hrvMs: mean(days.map((x) => x.hrvMs), 1) },
    };
  }, db);
}
