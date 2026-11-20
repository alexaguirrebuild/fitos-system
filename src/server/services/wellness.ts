/**
 * Bienestar: check-in diario con readiness, POMS y medidas corporales.
 */
import { z } from "zod";
import { withUser, type Db } from "@/db/client";
import { invalid } from "@/server/errors";
import { addDays } from "@/server/time";
import { POMS_ITEMS, baselineDelta, readiness, readinessBand, scorePoms, type PomsResult, type ReadinessBand } from "@/engine";
import {
  BODY_METRICS_COLS, BodyMetricsInput, DateInput, IsoDate, Pain, ankleStatusTx, dateOrToday, logInjuryPainTx, parseDateInput, parseInput,
  upsertBodyMetricsTx, type AnkleStatus, type BodyMetrics, type BodyMetricsResult,
} from "./athlete";

/* ───────────────────────── Check-in ───────────────────────── */

const score = (what: string) => z.number().int().min(1).max(10).describe(what);

export const SaveCheckinInput = z.object({
  date: IsoDate.optional().describe("Día del check-in (AAAA-MM-DD). Por defecto, hoy"),
  sleepQuality: score("Calidad del sueño de 1 (fatal) a 10 (perfecto)"),
  sleepHours: z.number().min(0).max(16).optional().describe("Horas dormidas"),
  stress: score("Estrés de 1 (ninguno) a 10 (máximo)"),
  motivation: score("Ganas de entrenar de 1 a 10"),
  pain: score("Dolor muscular o articular general de 1 (nada) a 10 (mucho)"),
  fatigue: score("Fatiga de 1 (fresco) a 10 (agotado)"),
  anklePain: Pain.optional().describe("Dolor de tobillo de 0 a 10"),
  note: z.string().max(1000).optional().describe("Nota libre del día"),
});
export type SaveCheckinInput = z.input<typeof SaveCheckinInput>;

export type Checkin = {
  id: string;
  date: string;
  sleepQuality: number | null;
  sleepHours: number | null;
  stress: number | null;
  motivation: number | null;
  pain: number | null;
  fatigue: number | null;
  anklePain: number | null;
  readiness: number | null;
  note: string | null;
};

export type CheckinResult = {
  date: string;
  checkin: Checkin;
  readiness: number;
  band: ReadinessBand;
  label: string;
  /** Desviación respecto a tu media de los 28 días anteriores. Null con menos de 7 check-ins. */
  baseline: { mean: number; z: number } | null;
  ankle: AnkleStatus;
};

const CHECKIN_COLS = `id, date, sleep_quality as "sleepQuality", sleep_hours as "sleepHours", stress, motivation, pain, fatigue,
  ankle_pain as "anklePain", readiness, note`;

export async function saveCheckin(userId: string, input: SaveCheckinInput, db?: Db): Promise<CheckinResult> {
  const i = parseInput(SaveCheckinInput, input);
  return withUser(userId, async (tx) => {
    const date = await dateOrToday(tx, i.date);
    const r = readiness({ sueno: i.sleepQuality, estres: i.stress, motiv: i.motivation, dolor: i.pain, fatiga: i.fatigue, horas: i.sleepHours });
    const [checkin] = await tx.query<Checkin>(
      `insert into fit.checkins as c (date, sleep_quality, sleep_hours, stress, motivation, pain, fatigue, ankle_pain, readiness, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (user_id, date) do update set sleep_quality = excluded.sleep_quality, sleep_hours = coalesce(excluded.sleep_hours, c.sleep_hours),
         stress = excluded.stress, motivation = excluded.motivation, pain = excluded.pain, fatigue = excluded.fatigue,
         ankle_pain = coalesce(excluded.ankle_pain, c.ankle_pain), readiness = excluded.readiness, note = coalesce(excluded.note, c.note)
       returning ${CHECKIN_COLS}`,
      [date, i.sleepQuality, i.sleepHours ?? null, i.stress, i.motivation, i.pain, i.fatigue, i.anklePain ?? null, r, i.note ?? null]);
    if (i.anklePain != null) await logInjuryPainTx(tx, { zone: "tobillo", pain: i.anklePain, moment: "dia", date });
    // La sesión abierta de ese día pasa a usar el readiness recién calculado.
    await tx.query("update fit.workouts set readiness_before = $1 where date = $2 and status = 'en_curso'", [r, date]);
    const past = await tx.query<{ readiness: number }>(
      "select readiness from fit.checkins where readiness is not null and date >= $1 and date < $2 order by date", [addDays(date, -28), date]);
    return { date, checkin, readiness: r, ...readinessBand(r), baseline: baselineDelta(r, past.map((p) => p.readiness)), ankle: await ankleStatusTx(tx, date) };
  }, db);
}

export async function getCheckin(userId: string, input?: DateInput, db?: Db): Promise<(Checkin & { band: ReadinessBand | null; label: string | null }) | null> {
  const d = parseDateInput(input);
  return withUser(userId, async (tx) => {
    const [c] = await tx.query<Checkin>(`select ${CHECKIN_COLS} from fit.checkins where date = $1`, [await dateOrToday(tx, d)]);
    if (!c) return null;
    const b = c.readiness != null ? readinessBand(c.readiness) : null;
    return { ...c, band: b?.band ?? null, label: b?.label ?? null };
  }, db);
}

export const ListCheckinsInput = z.object({
  days: z.number().int().min(1).max(730).default(28).describe("Cuántos días hacia atrás, contando el último"),
  to: IsoDate.optional().describe("Último día de la ventana (AAAA-MM-DD). Por defecto, hoy"),
});

export async function listCheckins(userId: string, input?: z.input<typeof ListCheckinsInput>, db?: Db): Promise<Checkin[]> {
  const { days, to } = parseInput(ListCheckinsInput, input ?? {});
  return withUser(userId, async (tx) => {
    const today = await dateOrToday(tx, to);
    return tx.query<Checkin>(`select ${CHECKIN_COLS} from fit.checkins where date > $1 and date <= $2 order by date desc`, [addDays(today, -days), today]);
  }, db);
}

/* ───────────────────────── POMS ───────────────────────── */

export const SavePomsInput = z.object({
  answers: z.array(z.number().int().min(0).max(4)).length(52).describe("Las 52 respuestas en orden, de 0 (nada) a 4 (muchísimo)"),
  date: IsoDate.optional().describe("Día del test (AAAA-MM-DD). Por defecto, hoy"),
});
export type SavePomsInput = z.input<typeof SavePomsInput>;

export type PomsTest = {
  id: string;
  date: string;
  tension: number;
  depression: number;
  anger: number;
  vigor: number;
  fatigue: number;
  /** Alteración total del estado de ánimo: tensión + depresión + cólera + fatiga − vigor. */
  tmd: number;
  shape: "iceberg" | "plano" | "invertido";
};

const POMS_COLS = "id, date, tension, depression, anger, vigor, fatigue, tmd, shape";

const POMS_READING: Record<PomsTest["shape"], string> = {
  iceberg: "Perfil iceberg: vigor alto y lo demás bajo. Buen momento para apretar.",
  plano: "Perfil plano: ni bien ni mal. Mantén el plan y vigila el sueño.",
  invertido: "Perfil invertido: fatiga y tensión por encima del vigor. Señal de recuperación insuficiente.",
};

export async function savePoms(userId: string, input: SavePomsInput, db?: Db): Promise<PomsTest & { normalized: PomsResult["normalized"]; reading: string }> {
  const i = parseInput(SavePomsInput, input);
  const s = scorePoms(i.answers);
  return withUser(userId, async (tx) => {
    const date = await dateOrToday(tx, i.date);
    const [row] = await tx.query<PomsTest>(
      `insert into fit.poms_tests (date, answers, tension, depression, anger, vigor, fatigue, tmd, shape)
       values ($1, $2::smallint[], $3, $4, $5, $6, $7, $8, $9)
       on conflict (user_id, date) do update set answers = excluded.answers, tension = excluded.tension, depression = excluded.depression,
         anger = excluded.anger, vigor = excluded.vigor, fatigue = excluded.fatigue, tmd = excluded.tmd, shape = excluded.shape
       returning ${POMS_COLS}`,
      [date, i.answers, s.tension, s.depresion, s.colera, s.vigor, s.fatiga, s.tmd, s.shape]);
    return { ...row, normalized: s.normalized, reading: POMS_READING[s.shape] };
  }, db);
}

export type PomsQuestionnaire = {
  instructions: string;
  scale: { value: number; label: string }[];
  items: { n: number; text: string }[];
};

/** El cuestionario. No lleva datos del atleta, así que no pide usuario. */
export function getPomsItems(): PomsQuestionnaire {
  return {
    instructions: "Marca cómo te has sentido durante la última semana, incluido hoy.",
    scale: [
      { value: 0, label: "Nada" }, { value: 1, label: "Un poco" }, { value: 2, label: "Moderadamente" },
      { value: 3, label: "Bastante" }, { value: 4, label: "Muchísimo" },
    ],
    items: POMS_ITEMS.map((text, k) => ({ n: k + 1, text })),
  };
}

export const ListPomsInput = z.object({ limit: z.number().int().min(1).max(100).default(12).describe("Máximo de tests, del más reciente al más antiguo") });

export async function listPoms(userId: string, input?: z.input<typeof ListPomsInput>, db?: Db): Promise<PomsTest[]> {
  const { limit } = parseInput(ListPomsInput, input ?? {});
  return withUser(userId, (tx) => tx.query<PomsTest>(`select ${POMS_COLS} from fit.poms_tests order by date desc limit $1`, [limit]), db);
}

/* ───────────────────────── Medidas corporales ───────────────────────── */

export const LogBodyMetricsInput = BodyMetricsInput;
export type LogBodyMetricsInput = z.input<typeof LogBodyMetricsInput>;

/** Guarda peso y perímetros del día. Si ya había medidas ese día, solo cambia lo que llega. */
export async function logBodyMetrics(userId: string, input: LogBodyMetricsInput, db?: Db): Promise<BodyMetricsResult> {
  const i = parseInput(LogBodyMetricsInput, input);
  const { date: _date, note: _note, ...values } = i;
  if (!Object.values(values).some((v) => v != null) && i.note == null) throw invalid("Indica al menos una medida.");
  return withUser(userId, (tx) => upsertBodyMetricsTx(tx, i), db);
}

export const ListBodyMetricsInput = z.object({
  days: z.number().int().min(1).max(1830).default(90).describe("Cuántos días hacia atrás, contando el último"),
  to: IsoDate.optional().describe("Último día de la ventana (AAAA-MM-DD). Por defecto, hoy"),
});

export async function listBodyMetrics(userId: string, input?: z.input<typeof ListBodyMetricsInput>, db?: Db): Promise<BodyMetrics[]> {
  const { days, to } = parseInput(ListBodyMetricsInput, input ?? {});
  return withUser(userId, async (tx) => {
    const today = await dateOrToday(tx, to);
    return tx.query<BodyMetrics>(`select ${BODY_METRICS_COLS} from fit.body_metrics where date > $1 and date <= $2 order by date desc`, [addDays(today, -days), today]);
  }, db);
}
