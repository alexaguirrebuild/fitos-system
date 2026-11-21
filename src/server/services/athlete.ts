/**
 * Atleta: ficha, onboarding, horario, lesiones y medidas corporales.
 * Aquí viven también los ayudantes comunes de los servicios de entreno (validación, fecha del atleta).
 *
 * Convención: cada función pública abre su transacción con withUser(). Las variantes `…Tx` reciben una
 * transacción ya abierta para poder componerse entre servicios (PGlite no admite transacciones anidadas).
 */
import { z } from "zod";
import { es } from "zod/locales";
import { withUser, type Db, type Tx } from "@/db/client";
import { invalid, notFound } from "@/server/errors";
import { DEFAULT_TZ, addDays, todayIn } from "@/server/time";
import { ankleRule, bodyComposition, trainingLevel, type AnkleRule, type Sex } from "@/engine";

/* ───────────────────────── Ayudantes comunes ───────────────────────── */

const ES = es();

/** Valida la entrada con zod y lanza `entrada_invalida` con un mensaje en español. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw, { error: ES.localeError });
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`).join("; ");
  throw invalid(msg, r.error.issues);
}

export const IsoDate = z.iso.date();
export const Uuid = z.uuid();
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora en formato HH:MM");
export const Pain = z.number().int().min(0).max(10);

/** timestamptz → texto ISO en UTC, igual en pg y en PGlite. */
export const isoTs = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export async function athleteTz(tx: Tx): Promise<string> {
  const r = await tx.query<{ timezone: string }>("select timezone from fit.athletes where id = auth.uid()");
  return r[0]?.timezone ?? DEFAULT_TZ;
}

/** La fecha pedida o, si no viene, hoy en la zona horaria del atleta. */
export async function dateOrToday(tx: Tx, date?: string | null): Promise<string> {
  return date ?? todayIn(await athleteTz(tx));
}

/* ───────────────────────── Ficha ───────────────────────── */

export type Athlete = {
  id: string;
  email: string;
  name: string | null;
  sex: Sex;
  birthDate: string | null;
  heightCm: number | null;
  heightConfirmed: boolean;
  timezone: string;
  bedtime: string | null;
  wakeTime: string | null;
  hrRest: number | null;
  adhd: boolean;
  adhdMedication: boolean | null;
  goalWeightKg: number | null;
  goalWaistCm: number | null;
  stepsGoal: number;
  stepsOffExtra: number;
  weeklyFoodBudgetEur: number | null;
  stores: string[];
  trainingLevel: number | null;
  onboarding: Record<string, unknown>;
  onboardedAt: string | null;
};

const ATHLETE_SELECT = `select id, email, name, sex, birth_date as "birthDate", height_cm as "heightCm",
  height_confirmed as "heightConfirmed", timezone, to_char(bedtime, 'HH24:MI') as bedtime,
  to_char(wake_time, 'HH24:MI') as "wakeTime", hr_rest as "hrRest", adhd, adhd_medication as "adhdMedication",
  goal_weight_kg as "goalWeightKg", goal_waist_cm as "goalWaistCm", steps_goal as "stepsGoal",
  steps_off_extra as "stepsOffExtra", weekly_food_budget_eur as "weeklyFoodBudgetEur", stores,
  training_level as "trainingLevel", onboarding, ${isoTs("onboarded_at")} as "onboardedAt"
  from fit.athletes where id = auth.uid()`;

export async function getAthleteTx(tx: Tx): Promise<Athlete> {
  const r = await tx.query<Athlete>(ATHLETE_SELECT);
  if (!r[0]) throw notFound("El atleta");
  return r[0];
}

export async function getAthlete(userId: string, _input?: unknown, db?: Db): Promise<Athlete> {
  return withUser(userId, getAthleteTx, db);
}

const Store = z.enum(["mercadona", "lidl", "otro"]);

export const UpdateAthleteInput = z.object({
  name: z.string().trim().min(1).max(80).nullable().optional().describe("Nombre del atleta"),
  sex: z.enum(["H", "M"]).optional().describe("Sexo para las fórmulas: H (hombre) o M (mujer)"),
  birthDate: IsoDate.nullable().optional().describe("Fecha de nacimiento (AAAA-MM-DD)"),
  heightCm: z.number().min(120).max(230).nullable().optional().describe("Altura en centímetros"),
  heightConfirmed: z.boolean().optional().describe("Verdadero si el atleta ha confirmado la altura (hay dos fichas distintas: 174 y 164 cm)"),
  timezone: z.string().min(3).max(64).optional().describe("Zona horaria IANA, por ejemplo Europe/Madrid"),
  bedtime: ClockTime.nullable().optional().describe("Hora habitual de acostarse (HH:MM)"),
  wakeTime: ClockTime.nullable().optional().describe("Hora habitual de levantarse (HH:MM)"),
  hrRest: z.number().int().min(30).max(120).nullable().optional().describe("Frecuencia cardiaca en reposo (pulsaciones por minuto)"),
  adhd: z.boolean().optional().describe("Tiene TDAH"),
  adhdMedication: z.boolean().nullable().optional().describe("Toma medicación para el TDAH (sí o no). Bloquea sugerencias de cafeína a ciegas"),
  goalWeightKg: z.number().min(35).max(250).nullable().optional().describe("Peso objetivo en kg"),
  goalWaistCm: z.number().min(40).max(200).nullable().optional().describe("Cintura objetivo en cm"),
  stepsGoal: z.number().int().min(0).max(60000).optional().describe("Pasos objetivo en día de entreno"),
  stepsOffExtra: z.number().int().min(0).max(20000).optional().describe("Pasos extra en día sin entreno"),
  weeklyFoodBudgetEur: z.number().min(0).max(1000).nullable().optional().describe("Presupuesto semanal de comida en euros"),
  stores: z.array(Store).max(3).optional().describe("Tiendas donde compra: mercadona, lidl, otro"),
});
export type UpdateAthleteInput = z.input<typeof UpdateAthleteInput>;

const ATHLETE_COLUMNS: Record<keyof z.output<typeof UpdateAthleteInput>, string> = {
  name: "name", sex: "sex", birthDate: "birth_date", heightCm: "height_cm", heightConfirmed: "height_confirmed",
  timezone: "timezone", bedtime: "bedtime", wakeTime: "wake_time", hrRest: "hr_rest", adhd: "adhd",
  adhdMedication: "adhd_medication", goalWeightKg: "goal_weight_kg", goalWaistCm: "goal_waist_cm",
  stepsGoal: "steps_goal", stepsOffExtra: "steps_off_extra", weeklyFoodBudgetEur: "weekly_food_budget_eur", stores: "stores",
};

export async function updateAthleteTx(tx: Tx, patch: z.output<typeof UpdateAthleteInput>): Promise<Athlete> {
  if (patch.timezone) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: patch.timezone });
    } catch {
      throw invalid(`Zona horaria desconocida: ${patch.timezone}`);
    }
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(ATHLETE_COLUMNS)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}${col === "stores" ? "::text[]" : ""}`);
  }
  if (sets.length) await tx.query(`update fit.athletes set ${sets.join(", ")}, updated_at = now() where id = auth.uid()`, params);
  return getAthleteTx(tx);
}

export async function updateAthlete(userId: string, input: UpdateAthleteInput, db?: Db): Promise<Athlete> {
  const patch = parseInput(UpdateAthleteInput, input);
  return withUser(userId, (tx) => updateAthleteTx(tx, patch), db);
}

/* ───────────────────────── Medidas corporales ───────────────────────── */

const cm = (lo: number, hi: number, what: string) => z.number().min(lo).max(hi).optional().describe(`${what} en cm`);

export const BodyMetricsInput = z.object({
  date: IsoDate.optional().describe("Día de la medición (AAAA-MM-DD). Por defecto, hoy"),
  weightKg: z.number().min(30).max(300).optional().describe("Peso en kg, en ayunas"),
  waistCm: cm(40, 200, "Cintura a la altura del ombligo"),
  neckCm: cm(20, 70, "Cuello"),
  hipCm: cm(50, 200, "Cadera"),
  chestCm: cm(50, 200, "Pecho"),
  armCm: cm(15, 70, "Brazo"),
  thighCm: cm(30, 110, "Muslo"),
  calfCm: cm(20, 70, "Gemelo"),
  forearmCm: cm(15, 50, "Antebrazo"),
  shoulderWidthCm: cm(30, 160, "Ancho de hombros (biacromial o perímetro de hombros)"),
  skeletalMuscleKg: z.number().min(10).max(80).optional().describe("Masa muscular esquelética en kg (p. ej. de la báscula InBody)"),
  bfPct: z.number().min(2).max(60).optional().describe("% graso medido (InBody, DEXA, pliegues). Si llega, no se recalcula por perímetros"),
  bfMethod: z.string().trim().min(1).max(40).optional().describe("Cómo se midió el % graso: inbody, dexa, pliegues…"),
  skinfolds: z.record(z.string(), z.number().min(0).max(100)).optional()
    .describe("Pliegues en mm: abdominal, suprailiaco, tricipital, subescapular, muslo, pantorrilla"),
  note: z.string().max(500).optional().describe("Nota libre"),
});
export type BodyMetricsInput = z.input<typeof BodyMetricsInput>;

export type BodyMetrics = {
  id: string;
  date: string;
  weightKg: number | null;
  waistCm: number | null;
  neckCm: number | null;
  hipCm: number | null;
  chestCm: number | null;
  armCm: number | null;
  thighCm: number | null;
  calfCm: number | null;
  forearmCm: number | null;
  shoulderWidthCm: number | null;
  skeletalMuscleKg: number | null;
  skinfolds: Record<string, number> | null;
  bfPct: number | null;
  bfMethod: string | null;
  note: string | null;
};

export const BODY_METRICS_COLS = `id, date, weight_kg as "weightKg", waist_cm as "waistCm", neck_cm as "neckCm",
  hip_cm as "hipCm", chest_cm as "chestCm", arm_cm as "armCm", thigh_cm as "thighCm", calf_cm as "calfCm",
  forearm_cm as "forearmCm", shoulder_width_cm as "shoulderWidthCm", skeletal_muscle_kg as "skeletalMuscleKg", skinfolds, bf_pct as "bfPct", bf_method as "bfMethod", note`;

export type BodyMetricsResult = BodyMetrics & {
  leanKg: number | null;
  waistToHeight: number | null;
  /** Margen de error del % graso, en puntos. */
  bfMarginPts: number | null;
  warnings: string[];
};

/** Guarda las medidas del día mezclando con lo que ya hubiera y recalcula el % graso si la altura está confirmada. */
export async function upsertBodyMetricsTx(tx: Tx, input: z.output<typeof BodyMetricsInput>): Promise<BodyMetricsResult> {
  const date = await dateOrToday(tx, input.date);
  const n = (v: number | undefined) => v ?? null;
  const m = ["weight_kg", "waist_cm", "neck_cm", "hip_cm", "chest_cm", "arm_cm", "thigh_cm", "calf_cm", "note",
    "forearm_cm", "shoulder_width_cm", "skeletal_muscle_kg", "bf_pct", "bf_method"];
  const [row] = await tx.query<BodyMetrics>(
    `insert into fit.body_metrics as b (date, weight_kg, waist_cm, neck_cm, hip_cm, chest_cm, arm_cm, thigh_cm, calf_cm, note, skinfolds,
       forearm_cm, shoulder_width_cm, skeletal_muscle_kg, bf_pct, bf_method)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
     on conflict (user_id, date) do update set
       ${m.map((c) => `${c} = coalesce(excluded.${c}, b.${c})`).join(", ")},
       skinfolds = case when excluded.skinfolds is null then b.skinfolds else coalesce(b.skinfolds, '{}'::jsonb) || excluded.skinfolds end
     returning ${BODY_METRICS_COLS}`,
    [date, n(input.weightKg), n(input.waistCm), n(input.neckCm), n(input.hipCm), n(input.chestCm), n(input.armCm),
      n(input.thighCm), n(input.calfCm), input.note ?? null, input.skinfolds ? JSON.stringify(input.skinfolds) : null,
      n(input.forearmCm), n(input.shoulderWidthCm), n(input.skeletalMuscleKg), n(input.bfPct), input.bfPct != null ? input.bfMethod ?? "medido" : null],
  );
  const a = await getAthleteTx(tx);
  const warnings: string[] = [];
  let leanKg: number | null = null;
  let waistToHeight: number | null = null;
  let bfMarginPts: number | null = null;
  // Un % graso medido (de hoy o de antes ese mismo día) manda: no se pisa con el cálculo por perímetros.
  const measured = row.bfPct != null && row.bfMethod != null && row.bfMethod !== "navy" && row.bfMethod !== "rfm";
  if (measured) {
    let kg = row.weightKg;
    if (kg == null) {
      const last = await tx.query<{ kg: number }>(
        "select weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1 order by date desc limit 1", [date]);
      kg = last[0]?.kg ?? null;
    }
    leanKg = kg != null ? Math.round(kg * (1 - row.bfPct! / 100) * 10) / 10 : null;
    bfMarginPts = 2;
    if (a.heightCm && row.waistCm) waistToHeight = Math.round((row.waistCm / a.heightCm) * 100) / 100;
  } else if (!a.heightCm || !a.heightConfirmed) {
    warnings.push("Altura sin confirmar: no calculo el % graso hasta que la confirmes.");
  } else {
    let kg = row.weightKg;
    if (kg == null) {
      const last = await tx.query<{ kg: number }>(
        "select weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1 order by date desc limit 1", [date]);
      kg = last[0]?.kg ?? null;
    }
    const c = bodyComposition({ kg: kg ?? 0, heightCm: a.heightCm, waistCm: row.waistCm, neckCm: row.neckCm, sex: a.sex });
    if (c.bfPct != null && c.method !== "sin_dato") {
      await tx.query("update fit.body_metrics set bf_pct = $1, bf_method = $2 where id = $3", [c.bfPct, c.method, row.id]);
      row.bfPct = c.bfPct;
      row.bfMethod = c.method;
      bfMarginPts = c.marginPts;
      leanKg = kg != null ? c.leanKg : null;
    }
    waistToHeight = c.waistToHeight;
  }
  return { ...row, leanKg, waistToHeight, bfMarginPts, warnings };
}

/* ───────────────────────── Horario ───────────────────────── */

export type ScheduleBlock = {
  id: string;
  kind: "clase" | "examen" | "trabajo" | "otro";
  title: string;
  weekday: number | null;
  start: string | null;
  end: string | null;
  from: string | null;
  to: string | null;
  highStress: boolean;
};

const SCHEDULE_COLS = `id, kind, title, weekday, to_char(start_time, 'HH24:MI') as start, to_char(end_time, 'HH24:MI') as "end",
  date_from as "from", date_to as "to", high_stress as "highStress"`;

export const ListScheduleInput = z.object({
  kind: z.enum(["clase", "examen", "trabajo", "otro"]).optional().describe("Filtra por tipo de bloque"),
});

export async function listSchedule(userId: string, input?: z.input<typeof ListScheduleInput>, db?: Db): Promise<ScheduleBlock[]> {
  const { kind } = parseInput(ListScheduleInput, input ?? {});
  return withUser(userId, (tx) => tx.query<ScheduleBlock>(
    `select ${SCHEDULE_COLS} from fit.schedule_blocks where ($1::text is null or kind = $1)
     order by date_from nulls first, weekday, start_time`, [kind ?? null]), db);
}

export const ScheduleBlockInput = z.object({
  id: Uuid.optional().describe("Id del bloque a modificar. Sin id se crea uno nuevo"),
  kind: z.enum(["clase", "examen", "trabajo", "otro"]).describe("Tipo: clase, examen, trabajo u otro"),
  title: z.string().trim().min(1).max(120).describe("Nombre de la clase o del periodo"),
  weekday: z.number().int().min(0).max(6).optional().describe("Día de la semana para bloques fijos: 0 domingo … 6 sábado"),
  start: ClockTime.optional().describe("Hora de inicio (HH:MM)"),
  end: ClockTime.optional().describe("Hora de fin (HH:MM)"),
  from: IsoDate.optional().describe("Primer día del periodo (AAAA-MM-DD), para exámenes y periodos por fechas"),
  to: IsoDate.optional().describe("Último día del periodo (AAAA-MM-DD)"),
  highStress: z.boolean().optional().describe("Estresor alto. Los exámenes lo son por defecto"),
});
export type ScheduleBlockInput = z.input<typeof ScheduleBlockInput>;

export async function upsertScheduleBlockTx(tx: Tx, b: z.output<typeof ScheduleBlockInput>): Promise<ScheduleBlock> {
  if (b.from && b.to && b.from > b.to) throw invalid("El periodo termina antes de empezar.");
  if (b.weekday == null && !b.from) throw invalid("Indica el día de la semana o las fechas del periodo.");
  const params = [b.kind, b.title, b.weekday ?? null, b.start ?? null, b.end ?? null, b.from ?? null, b.to ?? b.from ?? null,
    b.highStress ?? b.kind === "examen"];
  const rows = b.id
    ? await tx.query<ScheduleBlock>(
        `update fit.schedule_blocks set kind = $1, title = $2, weekday = $3, start_time = $4, end_time = $5, date_from = $6,
         date_to = $7, high_stress = $8 where id = $9 returning ${SCHEDULE_COLS}`, [...params, b.id])
    : await tx.query<ScheduleBlock>(
        `insert into fit.schedule_blocks (kind, title, weekday, start_time, end_time, date_from, date_to, high_stress)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${SCHEDULE_COLS}`, params);
  if (!rows[0]) throw notFound("El bloque de horario");
  return rows[0];
}

export async function upsertScheduleBlock(userId: string, input: ScheduleBlockInput, db?: Db): Promise<ScheduleBlock> {
  const b = parseInput(ScheduleBlockInput, input);
  return withUser(userId, (tx) => upsertScheduleBlockTx(tx, b), db);
}

export const DeleteScheduleBlockInput = z.object({ id: Uuid.describe("Id del bloque de horario a borrar") });

export async function deleteScheduleBlock(userId: string, input: z.input<typeof DeleteScheduleBlockInput> | string, db?: Db): Promise<{ deleted: true }> {
  const { id } = parseInput(DeleteScheduleBlockInput, typeof input === "string" ? { id: input } : input);
  return withUser(userId, async (tx) => {
    const r = await tx.query("delete from fit.schedule_blocks where id = $1 returning id", [id]);
    if (!r.length) throw notFound("El bloque de horario");
    return { deleted: true as const };
  }, db);
}

/** Hay un periodo de exámenes (u otro bloque de estrés alto por fechas) que cubre ese día. */
export async function isExamPeriodTx(tx: Tx, date: string): Promise<boolean> {
  const r = await tx.query(
    `select 1 from fit.schedule_blocks where (kind = 'examen' or high_stress) and date_from is not null
     and $1::date between date_from and coalesce(date_to, date_from) limit 1`, [date]);
  return r.length > 0;
}

export const DateInput = z.object({ date: IsoDate.optional().describe("Día a consultar (AAAA-MM-DD). Por defecto, hoy") });
export type DateInput = z.input<typeof DateInput> | string | undefined;
export const parseDateInput = (input: DateInput) => parseInput(DateInput, typeof input === "string" ? { date: input } : input ?? {}).date;

export async function isExamPeriod(userId: string, input?: DateInput, db?: Db): Promise<boolean> {
  const date = parseDateInput(input);
  return withUser(userId, async (tx) => isExamPeriodTx(tx, await dateOrToday(tx, date)), db);
}

/* ───────────────────────── Lesiones ───────────────────────── */

export type Injury = {
  id: string;
  zone: string;
  side: string | null;
  startedOn: string | null;
  status: "abierta" | "vigilancia" | "cerrada";
  limits: string | null;
  adjustments: string | null;
  closedOn: string | null;
  lastPain: number | null;
  lastPainDate: string | null;
  logs: number;
};

const INJURY_SELECT = `select i.id, i.zone, i.side, i.started_on as "startedOn", i.status, i.limits, i.adjustments,
  i.closed_on as "closedOn", l.pain as "lastPain", l.date as "lastPainDate",
  (select count(*)::int from fit.injury_logs x where x.injury_id = i.id) as logs
  from fit.injuries i
  left join lateral (select pain, date from fit.injury_logs x where x.injury_id = i.id order by date desc, created_at desc limit 1) l on true`;

export async function listInjuries(userId: string, _input?: unknown, db?: Db): Promise<Injury[]> {
  return withUser(userId, (tx) => tx.query<Injury>(`${INJURY_SELECT} order by (i.status = 'cerrada'), i.created_at desc`), db);
}

const zoneKey = (zone: string) => zone.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const LogInjuryPainInput = z.object({
  zone: z.string().trim().min(2).max(40).describe("Zona lesionada, por ejemplo «tobillo»"),
  pain: Pain.describe("Dolor de 0 (nada) a 10 (insoportable)"),
  moment: z.enum(["antes", "despues", "dia_siguiente", "dia"]).default("dia")
    .describe("Momento: antes o después de entrenar, al día siguiente de pierna, o en general durante el día"),
  date: IsoDate.optional().describe("Día del registro (AAAA-MM-DD). Por defecto, hoy"),
  note: z.string().max(500).optional().describe("Nota libre: qué lo provoca, cómo se siente"),
  side: z.enum(["izquierdo", "derecho", "ambos"]).optional().describe("Lado, solo si se crea la lesión"),
});
export type LogInjuryPainInput = z.input<typeof LogInjuryPainInput>;

export type InjuryPainResult = { injuryId: string; zone: string; date: string; moment: string; pain: number; created: boolean };

/** Apunta el dolor del día. Si no hay una lesión abierta de esa zona, la crea. */
export async function logInjuryPainTx(tx: Tx, i: z.output<typeof LogInjuryPainInput>): Promise<InjuryPainResult> {
  const zone = zoneKey(i.zone);
  const date = await dateOrToday(tx, i.date);
  let created = false;
  let inj = (await tx.query<{ id: string }>(
    "select id from fit.injuries where zone = $1 and status <> 'cerrada' order by created_at desc limit 1", [zone]))[0];
  if (!inj) {
    inj = (await tx.query<{ id: string }>(
      "insert into fit.injuries (zone, side, started_on, status) values ($1, $2, $3, 'abierta') returning id", [zone, i.side ?? null, date]))[0];
    created = true;
  }
  await tx.query(
    `insert into fit.injury_logs (injury_id, date, moment, pain, note) values ($1, $2, $3, $4, $5)
     on conflict (injury_id, date, moment) do update set pain = excluded.pain, note = coalesce(excluded.note, fit.injury_logs.note), created_at = now()`,
    [inj.id, date, i.moment, i.pain, i.note ?? null]);
  return { injuryId: inj.id, zone, date, moment: i.moment, pain: i.pain, created };
}

export async function logInjuryPain(userId: string, input: LogInjuryPainInput, db?: Db): Promise<InjuryPainResult & { ankle: AnkleStatus | null }> {
  const i = parseInput(LogInjuryPainInput, input);
  return withUser(userId, async (tx) => {
    const r = await logInjuryPainTx(tx, i);
    return { ...r, ankle: r.zone === "tobillo" ? await ankleStatusTx(tx, r.date) : null };
  }, db);
}

export const CloseInjuryInput = z.object({
  injuryId: Uuid.optional().describe("Id de la lesión. Si no viene, se usa la zona"),
  zone: z.string().trim().min(2).max(40).optional().describe("Zona de la lesión a cerrar, por ejemplo «tobillo»"),
  date: IsoDate.optional().describe("Día en que se da por cerrada. Por defecto, hoy"),
});

export async function closeInjury(userId: string, input: z.input<typeof CloseInjuryInput>, db?: Db): Promise<Injury> {
  const i = parseInput(CloseInjuryInput, input);
  if (!i.injuryId && !i.zone) throw invalid("Indica la lesión o la zona.");
  return withUser(userId, async (tx) => {
    const date = await dateOrToday(tx, i.date);
    const r = await tx.query<{ id: string }>(
      `update fit.injuries set status = 'cerrada', closed_on = $1
       where id = (select id from fit.injuries where status <> 'cerrada' and ($2::uuid is null or id = $2)
                   and ($3::text is null or zone = $3) order by created_at desc limit 1) returning id`,
      [date, i.injuryId ?? null, i.zone ? zoneKey(i.zone) : null]);
    if (!r[0]) throw notFound("La lesión abierta");
    return (await tx.query<Injury>(`${INJURY_SELECT} where i.id = $1`, [r[0].id]))[0];
  }, db);
}

/* ───────────────────────── Tobillo ───────────────────────── */

export type AnkleStatus = {
  date: string;
  /** Dolor que se usa hoy (0-10). Null si no hay ningún dato reciente: la regla se calcula con 0. */
  pain: number | null;
  painDate: string | null;
  painSource: "lesion" | "checkin" | null;
  /** Dolor al día siguiente de la última sesión de pierna. */
  painDayAfterLegs: number | null;
  lastLegDay: string | null;
  injuryStatus: "abierta" | "vigilancia" | "cerrada" | null;
  rule: AnkleRule;
};

/** Días que se arrastra el último dolor apuntado cuando hoy no hay registro. */
const ANKLE_STALE_DAYS = 3;

export async function ankleStatusTx(tx: Tx, date: string): Promise<AnkleStatus> {
  const from = addDays(date, -30);
  const logs = await tx.query<{ date: string; moment: string; pain: number }>(
    `select l.date, l.moment, l.pain from fit.injury_logs l join fit.injuries i on i.id = l.injury_id
     where i.zone = 'tobillo' and l.date between $1 and $2 order by l.date desc, l.created_at desc`, [from, date]);
  const checkins = await tx.query<{ date: string; pain: number }>(
    `select date, ankle_pain as pain from fit.checkins where ankle_pain is not null and date between $1 and $2 order by date desc`, [from, date]);
  const inj = await tx.query<{ status: AnkleStatus["injuryStatus"] }>(
    "select status from fit.injuries where zone = 'tobillo' order by (status = 'cerrada'), created_at desc limit 1");
  const injuryStatus = inj[0]?.status ?? null;

  let pain: number | null = null;
  let painDate: string | null = null;
  let painSource: AnkleStatus["painSource"] = null;
  const logToday = logs.find((l) => l.date === date);
  const checkToday = checkins.find((c) => c.date === date);
  if (logToday) [pain, painDate, painSource] = [logToday.pain, date, "lesion"];
  else if (checkToday) [pain, painDate, painSource] = [checkToday.pain, date, "checkin"];
  else if (injuryStatus !== "cerrada") {
    const limit = addDays(date, -ANKLE_STALE_DAYS);
    const l = logs.find((x) => x.date >= limit);
    const c = checkins.find((x) => x.date >= limit);
    if (l && (!c || l.date >= c.date)) [pain, painDate, painSource] = [l.pain, l.date, "lesion"];
    else if (c) [pain, painDate, painSource] = [c.pain, c.date, "checkin"];
  }

  const leg = await tx.query<{ d: string | null }>(
    `select max(w.date) as d from fit.workouts w where w.status = 'hecha' and w.date < $1 and exists (
       select 1 from fit.workout_sets s join fit.exercises e on e.id = s.exercise_id
       join fit.muscle_groups m on m.id = e.primary_muscle where s.workout_id = w.id and m.region = 'pierna')`, [date]);
  const lastLegDay = leg[0]?.d ?? null;
  let painDayAfterLegs: number | null = null;
  if (lastLegDay) {
    const next = addDays(lastLegDay, 1);
    const dayLogs = logs.filter((l) => l.date === next);
    const explicit = dayLogs.find((l) => l.moment === "dia_siguiente");
    if (explicit) painDayAfterLegs = explicit.pain;
    else if (dayLogs.length) painDayAfterLegs = Math.max(...dayLogs.map((l) => l.pain));
    else painDayAfterLegs = checkins.find((c) => c.date === next)?.pain ?? null;
  }
  return { date, pain, painDate, painSource, painDayAfterLegs, lastLegDay, injuryStatus, rule: ankleRule(pain ?? 0, painDayAfterLegs) };
}

export async function getAnkleStatus(userId: string, input?: DateInput, db?: Db): Promise<AnkleStatus> {
  const date = parseDateInput(input);
  return withUser(userId, async (tx) => ankleStatusTx(tx, await dateOrToday(tx, date)), db);
}

/* ───────────────────────── Onboarding ───────────────────────── */

export type OnboardingField =
  | "heightCm" | "birthDate" | "weightKg" | "waistCm" | "hrRest" | "bedtime" | "ankle" | "program"
  | "adhdMedication" | "weeklyFoodBudgetEur" | "stores";

export type OnboardingStatus = {
  complete: boolean;
  /** Lo imprescindible. Con esto vacío el onboarding está completo. */
  missing: { field: OnboardingField; question: string; why: string }[];
  /** Preguntas que conviene hacer pero no bloquean (hoy, el tobillo). */
  optional: { field: OnboardingField; question: string; why: string }[];
  contradictions: string[];
  /** Preguntas de la ficha de ingreso (`intake`) sin contestar, una frase cada una. */
  intakeMissing: { field: IntakeField; question: string }[];
};

/** Ficha de ingreso: lo que hace falta saber para entrenar y comer con criterio. Texto libre o lista. */
const Free = z.union([z.string().trim().max(1500), z.array(z.string().trim().max(300)).max(40)]);

export const IntakeInput = z.object({
  yearsTraining: Free.optional().describe("Años entrenando"),
  sessionMinutes: Free.optional().describe("Minutos por sesión"),
  trainingTime: Free.optional().describe("Hora habitual de entreno"),
  trainingDays: Free.optional().describe("Días de entreno"),
  previousTraining: Free.optional().describe("Entrenamientos anteriores"),
  focusMuscles: Free.optional().describe("Grupos musculares a potenciar"),
  avoidExercises: Free.optional().describe("Ejercicios que no quiere hacer"),
  occupation: Free.optional().describe("Profesión"),
  previousDiets: Free.optional().describe("Dietas anteriores"),
  mealsPerDay: Free.optional().describe("Comidas al día"),
  allergies: Free.optional().describe("Alergias o intolerancias"),
  dietSkips: Free.optional().describe("Cómo se salta la dieta"),
  supplements: Free.optional().describe("Suplementación actual"),
  supplementsBudget: Free.optional().describe("Presupuesto para suplementos"),
  conditions: Free.optional().describe("Patologías"),
  medication: Free.optional().describe("Medicación (texto)"),
  wakeTime: Free.optional().describe("Hora de levantarse"),
  bedTime: Free.optional().describe("Hora de acostarse"),
  habits: Free.optional().describe("Hábitos: alcohol, tabaco"),
  goalInOwnWords: Free.optional().describe("Objetivo en sus palabras"),
  bloodwork: z.object({
    recent: z.boolean().describe("¿Tiene una analítica reciente?"),
    date: IsoDate.optional().describe("Fecha de la analítica (AAAA-MM-DD)"),
  }).optional().describe("Analítica reciente: sí o no y fecha"),
  notes: Free.optional().describe("Notas"),
});
export type IntakeInput = z.input<typeof IntakeInput>;
export type IntakeField = Exclude<keyof z.output<typeof IntakeInput>, "notes">;

const INTAKE_QUESTIONS: Record<IntakeField, string> = {
  yearsTraining: "¿Cuántos años llevas entrenando?",
  sessionMinutes: "¿Cuántos minutos tienes por sesión?",
  trainingTime: "¿A qué hora sueles entrenar?",
  trainingDays: "¿Qué días de la semana entrenas?",
  previousTraining: "¿Qué entrenamientos has seguido antes?",
  focusMuscles: "¿Qué grupos musculares quieres potenciar?",
  avoidExercises: "¿Hay ejercicios que no quieras hacer?",
  occupation: "¿A qué te dedicas?",
  previousDiets: "¿Qué dietas has hecho antes?",
  mealsPerDay: "¿Cuántas comidas haces al día?",
  allergies: "¿Tienes alergias o intolerancias alimentarias?",
  dietSkips: "¿Cómo te saltas la dieta y cuándo?",
  supplements: "¿Qué suplementos tomas ahora?",
  supplementsBudget: "¿Cuánto quieres gastar al mes en suplementos?",
  conditions: "¿Tienes alguna patología?",
  medication: "¿Tomas alguna medicación?",
  wakeTime: "¿A qué hora te levantas?",
  bedTime: "¿A qué hora te acuestas?",
  habits: "¿Qué hábitos tienes con el alcohol y el tabaco?",
  goalInOwnWords: "¿Cuál es tu objetivo, dicho con tus palabras?",
  bloodwork: "¿Te has hecho una analítica reciente y de qué fecha?",
};

const answered = (v: unknown): boolean =>
  v != null && (typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.length > 0 : typeof v === "object" ? "recent" in v : true);

const HEIGHT_CONTRADICTION = "Altura: 174 cm en la hoja de junio, 164 cm en otra ficha. Confirma cuál.";

export async function onboardingStatusTx(tx: Tx): Promise<OnboardingStatus> {
  const a = await getAthleteTx(tx);
  const [f] = await tx.query<{ weight: boolean; waist: boolean; ankle: boolean; program: boolean; intake: Record<string, unknown> | null }>(
    `select exists (select 1 from fit.body_metrics where weight_kg is not null) as weight,
            exists (select 1 from fit.body_metrics where waist_cm is not null) as waist,
            exists (select 1 from fit.injuries i where i.zone = 'tobillo' and (i.status = 'cerrada'
                    or exists (select 1 from fit.injury_logs l where l.injury_id = i.id))) as ankle,
            exists (select 1 from fit.macrocycles where status = 'activo') as program,
            (select onboarding -> 'intake' from fit.athletes where id = auth.uid()) as intake`);
  const missing: OnboardingStatus["missing"] = [];
  const optional: OnboardingStatus["optional"] = [];
  const ask = (ok: boolean, field: OnboardingField, question: string, why: string) => { if (!ok) missing.push({ field, question, why }); };
  ask(a.heightCm != null && a.heightConfirmed, "heightCm", "¿Cuánto mides, en centímetros?",
    "Sin la altura confirmada no se calculan el gasto ni el % graso.");
  ask(a.birthDate != null, "birthDate", "¿Cuál es tu fecha de nacimiento?", "La edad entra en el gasto en reposo y en las zonas de pulso.");
  ask(f.weight, "weightKg", "¿Cuánto pesas hoy, en ayunas?", "Es el punto de partida de la tendencia de peso y de las calorías.");
  ask(f.waist, "waistCm", "¿Cuánto mide tu cintura a la altura del ombligo?", "Con la cintura se estima la grasa y se ve el progreso que la báscula no enseña.");
  ask(a.hrRest != null, "hrRest", "¿Cuál es tu pulso en reposo al despertar?", "Con él se calculan tus zonas de cardio.");
  ask(a.bedtime != null, "bedtime", "¿A qué hora te acuestas normalmente?", "Marca la hora límite de la cafeína.");
  if (!f.ankle) optional.push({ field: "ankle", question: "¿Alguna lesión o molestia ahora?", why: "Decide si hay sentadilla libre, impacto y carrera." });
  ask(f.program, "program", "¿Qué programa quieres activar?", "Sin programa activo no hay sesión de hoy ni progresión.");
  ask(a.adhdMedication != null, "adhdMedication", "¿Tomas medicación para el TDAH? Sí o no.", "Cambia lo que se puede sugerir con la cafeína.");
  ask(a.weeklyFoodBudgetEur != null, "weeklyFoodBudgetEur", "¿Cuánto quieres gastar en comida a la semana?", "La lista de la compra se ajusta a ese presupuesto.");
  ask(a.stores.length > 0, "stores", "¿En qué tiendas compras?", "Los alimentos y precios salen de esas tiendas.");
  const intake = f.intake ?? {};
  const intakeMissing = (Object.keys(INTAKE_QUESTIONS) as IntakeField[])
    .filter((k) => !answered(intake[k]) && !(k === "wakeTime" && a.wakeTime) && !(k === "bedTime" && a.bedtime))
    .map((field) => ({ field, question: INTAKE_QUESTIONS[field] }));
  return { complete: missing.length === 0, missing, optional, contradictions: a.heightConfirmed ? [] : [HEIGHT_CONTRADICTION], intakeMissing };
}

export async function getOnboardingStatus(userId: string, _input?: unknown, db?: Db): Promise<OnboardingStatus> {
  return withUser(userId, onboardingStatusTx, db);
}

const Level = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const Lift = z.number().min(0).max(500).optional();

export const SaveOnboardingInput = UpdateAthleteInput.extend({
  intake: IntakeInput.optional().describe("Ficha de ingreso: entreno, comida, salud y hábitos. Se va completando: lo nuevo se suma a lo guardado"),
  weightKg: z.number().min(30).max(300).optional().describe("Peso de hoy en kg"),
  waistCm: z.number().min(40).max(200).optional().describe("Cintura de hoy en cm"),
  neckCm: z.number().min(20).max(70).optional().describe("Cuello en cm (mejora la estimación de grasa)"),
  measuredOn: IsoDate.optional().describe("Día de esas medidas (AAAA-MM-DD). Por defecto, hoy"),
  ankle: z.object({
    status: z.enum(["abierta", "vigilancia", "cerrada"]).default("abierta").describe("Estado de la lesión de tobillo"),
    painToday: Pain.optional().describe("Dolor de hoy de 0 a 10"),
    side: z.enum(["izquierdo", "derecho", "ambos"]).optional().describe("Lado del tobillo"),
    limits: z.string().max(500).optional().describe("Qué le limita, en sus palabras"),
  }).optional().describe("Estado del tobillo"),
  classes: z.array(z.object({
    title: z.string().trim().min(1).max(120).describe("Asignatura o clase"),
    weekday: z.number().int().min(0).max(6).describe("Día de la semana: 0 domingo … 6 sábado"),
    start: ClockTime.describe("Hora de inicio (HH:MM)"),
    end: ClockTime.describe("Hora de fin (HH:MM)"),
  })).max(60).optional().describe("Clases de la UCM. Sustituye a las guardadas"),
  exams: z.array(z.object({
    title: z.string().trim().min(1).max(120).describe("Nombre del periodo de exámenes"),
    from: IsoDate.describe("Primer día (AAAA-MM-DD)"),
    to: IsoDate.describe("Último día (AAAA-MM-DD)"),
  })).max(20).optional().describe("Periodos de exámenes. Sustituye a los guardados. Cuentan como estrés alto"),
  marks: z.object({
    years: Level.describe("Años entrenando en serio: 1 (<1), 2 (1-3), 3 (3-5), 4 (>5)"),
    technique: Level.describe("Técnica de 1 a 4"),
    progress: Level.describe("Ritmo de progreso de 1 (sube cada sesión) a 4 (sube cada meses)"),
    education: Level.describe("Formación sobre entrenamiento de 1 a 4"),
    lifts: z.object({
      bench: Lift.describe("1RM de press banca en kg"),
      pullup: Lift.describe("1RM de dominada en kg (peso corporal + lastre)"),
      squat: Lift.describe("1RM de sentadilla en kg"),
      deadlift: Lift.describe("1RM de peso muerto en kg"),
    }).default({}).describe("Marcas actuales"),
  }).optional().describe("Marcas y experiencia para calcular el nivel de entrenamiento"),
});
export type SaveOnboardingInput = z.input<typeof SaveOnboardingInput>;

export type SaveOnboardingResult = {
  athlete: Athlete;
  status: OnboardingStatus;
  trainingLevel: { score: number; label: string } | null;
  warnings: string[];
};

export async function saveOnboarding(userId: string, input: SaveOnboardingInput, db?: Db): Promise<SaveOnboardingResult> {
  const a = parseInput(SaveOnboardingInput, input);
  return withUser(userId, async (tx) => {
    const warnings: string[] = [];
    const { weightKg, waistCm, neckCm, measuredOn, ankle, classes, exams, marks, intake, ...profile } = a;
    // Dar la altura en el onboarding es confirmarla, salvo que se diga lo contrario.
    if (profile.heightCm != null && profile.heightConfirmed === undefined) profile.heightConfirmed = true;
    await updateAthleteTx(tx, profile);
    const today = await dateOrToday(tx, measuredOn);

    if (weightKg != null || waistCm != null || neckCm != null) {
      const m = await upsertBodyMetricsTx(tx, { date: today, weightKg, waistCm, neckCm });
      warnings.push(...m.warnings);
    }

    if (ankle) {
      if (ankle.painToday != null && ankle.status !== "cerrada") {
        const r = await logInjuryPainTx(tx, { zone: "tobillo", pain: ankle.painToday, moment: "dia", date: today, side: ankle.side });
        await tx.query("update fit.injuries set status = $1, limits = coalesce($2, limits), side = coalesce($3, side) where id = $4",
          [ankle.status, ankle.limits ?? null, ankle.side ?? null, r.injuryId]);
      } else if (ankle.status === "cerrada") {
        const closed = await tx.query(
          "update fit.injuries set status = 'cerrada', closed_on = coalesce(closed_on, $1) where zone = 'tobillo' and status <> 'cerrada' returning id", [today]);
        const any = await tx.query("select 1 from fit.injuries where zone = 'tobillo' limit 1");
        if (!closed.length && !any.length)
          await tx.query("insert into fit.injuries (zone, side, status, closed_on, limits) values ('tobillo', $1, 'cerrada', $2, $3)",
            [ankle.side ?? null, today, ankle.limits ?? null]);
      } else {
        warnings.push("Falta el dolor de hoy del tobillo (0-10) para aplicar la regla.");
      }
    }

    if (classes) {
      await tx.query("delete from fit.schedule_blocks where kind = 'clase'");
      for (const c of classes) await upsertScheduleBlockTx(tx, { kind: "clase", title: c.title, weekday: c.weekday, start: c.start, end: c.end });
    }
    if (exams) {
      await tx.query("delete from fit.schedule_blocks where kind = 'examen'");
      for (const e of exams) await upsertScheduleBlockTx(tx, { kind: "examen", title: e.title, from: e.from, to: e.to, highStress: true });
    }

    let level: SaveOnboardingResult["trainingLevel"] = null;
    if (marks) {
      const me = await getAthleteTx(tx);
      const w = await tx.query<{ kg: number }>("select weight_kg as kg from fit.body_metrics where weight_kg is not null order by date desc limit 1");
      if (!w[0]) warnings.push("Sin peso corporal no se puede calcular el nivel de entrenamiento.");
      else {
        const lifts = Object.fromEntries(Object.entries(marks.lifts).filter(([, v]) => v != null && v > 0)) as Partial<Record<"bench" | "pullup" | "squat" | "deadlift", number>>;
        const t = trainingLevel({ sex: me.sex, bodyKg: w[0].kg, years: marks.years, technique: marks.technique, progress: marks.progress,
          education: marks.education, lifts });
        level = { score: t.score, label: t.label };
        await tx.query("update fit.athletes set training_level = $1 where id = auth.uid()", [t.score]);
      }
    }

    const { intake: _intake, ...rest } = a;
    const answers = JSON.stringify({ ...rest, savedAt: new Date().toISOString() });
    await tx.query("update fit.athletes set onboarding = onboarding || $1::jsonb, updated_at = now() where id = auth.uid()", [answers]);
    if (intake)
      await tx.query(
        "update fit.athletes set onboarding = jsonb_set(onboarding, '{intake}', coalesce(onboarding -> 'intake', '{}'::jsonb) || $1::jsonb, true) where id = auth.uid()",
        [JSON.stringify(intake)]);
    const status = await onboardingStatusTx(tx);
    if (status.complete) await tx.query("update fit.athletes set onboarded_at = coalesce(onboarded_at, now()) where id = auth.uid()");
    return { athlete: await getAthleteTx(tx), status, trainingLevel: level, warnings };
  }, db);
}
