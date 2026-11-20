/**
 * Planificación: plantillas de programa (data/seed/programs/<slug>.json), activación, plan activo
 * y sesiones «en rueda» (se hacen en orden, sin día de la semana fijo).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { AppError, invalid, notFound } from "@/server/errors";
import { addDays, diffDays } from "@/server/time";
import { DateInput, IsoDate, Uuid, dateOrToday, parseDateInput, parseInput } from "./athlete";
import { loadLibraryTx } from "./library";

/* ───────────────────────── Plantilla ───────────────────────── */

const WarmupKind = z.enum(["no", "reducido", "completo"]);

export const ProgramTemplateExercise = z.object({
  exercise: z.string().min(1).describe("Slug del ejercicio en la librería"),
  sets: z.number().int().min(0).max(12).describe("Series efectivas"),
  rep_min: z.number().int().min(0).max(999).nullable().optional().describe("Repeticiones mínimas del rango (o minutos, en cardio)"),
  rep_max: z.number().int().min(0).max(999).nullable().optional().describe("Repeticiones máximas del rango"),
  rir_target: z.number().min(0).max(10).nullable().optional().describe("Repeticiones en reserva objetivo"),
  rest_seconds: z.number().int().min(0).max(1200).nullable().optional().describe("Descanso entre series, en segundos"),
  tempo: z.string().max(40).nullable().optional().describe("Tempo"),
  warmup_kind: WarmupKind.nullable().optional().describe("Calentamiento: no, reducido o completo"),
  technique: z.string().max(60).nullable().optional().describe("Técnica de intensidad (slug del glosario)"),
  load_cap_pct: z.number().int().min(1).max(100).nullable().optional().describe("Tope de carga en % del 1RM estimado"),
  notes: z.string().max(1000).nullable().optional().describe("Notas de la pauta"),
}).refine((e) => e.rep_min == null || e.rep_max == null || e.rep_min <= e.rep_max, "rep_min no puede superar a rep_max");

export const ProgramTemplateSession = z.object({
  name: z.string().min(1).max(80).describe("Nombre de la sesión"),
  focus: z.string().max(200).nullable().optional().describe("Enfoque de la sesión"),
  is_rest: z.boolean().default(false).describe("Día de descanso"),
  is_cardio: z.boolean().default(false).describe("Sesión de cardio"),
  planned_minutes: z.number().int().min(0).max(600).nullable().optional().describe("Duración prevista en minutos"),
  exercises: z.array(ProgramTemplateExercise).max(30).default([]).describe("Ejercicios en orden"),
});

export const ProgramTemplateMesocycle = z.object({
  name: z.string().min(1).max(120).describe("Nombre del mesociclo"),
  block_type: z.enum(["hipertrofia", "fuerza_base", "volumen", "intensificacion", "peaking", "tapering", "pivot", "descarga", "mantenimiento"])
    .default("hipertrofia").describe("Tipo de bloque"),
  focus: z.enum(["intensidad", "volumen", "tecnica"]).nullable().optional().describe("Foco del bloque"),
  microcycle_days: z.number().int().min(3).max(21).default(7).describe("Días que dura cada microciclo"),
  microcycles_planned: z.number().int().min(1).max(26).default(4).describe("Microciclos previstos"),
  sessions: z.array(ProgramTemplateSession).min(1).max(21).describe("Sesiones del microciclo, en el orden de la rueda"),
});

export const ProgramTemplate = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Identificador del programa"),
  name: z.string().min(1).max(160).describe("Nombre del programa"),
  goal: z.enum(["definicion", "volumen", "recomposicion", "mantenimiento", "fuerza"]).describe("Objetivo del macrociclo"),
  source: z.string().max(500).nullable().optional().describe("De dónde sale el programa"),
  mesocycles: z.array(ProgramTemplateMesocycle).min(1).max(12).describe("Mesociclos en orden"),
});
export type ProgramTemplate = z.output<typeof ProgramTemplate>;

export type PlanFileOptions = {
  /** Carpeta de plantillas. Por defecto, data/seed/programs. */
  dir?: string;
  /** Plantilla ya cargada (tests). */
  template?: unknown;
};

const programsDir = (dir?: string) => dir ?? path.join(process.cwd(), "data", "seed", "programs");

export type ProgramTemplateSummary = {
  slug: string;
  name: string;
  goal: ProgramTemplate["goal"];
  source: string | null;
  weeks: number;
  mesocycles: { name: string; blockType: string; microcycleDays: number; microcyclesPlanned: number; sessions: string[] }[];
};

/** Lee la carpeta de plantillas. Las que no validan no se listan: salen en `invalid` con su error. */
export function listProgramTemplates(opts: PlanFileOptions = {}): { templates: ProgramTemplateSummary[]; invalid: { file: string; error: string }[] } {
  const dir = programsDir(opts.dir);
  const templates: ProgramTemplateSummary[] = [];
  const bad: { file: string; error: string }[] = [];
  if (!existsSync(dir)) return { templates, invalid: bad };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const t = parseInput(ProgramTemplate, JSON.parse(readFileSync(path.join(dir, file), "utf8")));
      templates.push({
        slug: t.slug, name: t.name, goal: t.goal, source: t.source ?? null,
        weeks: Math.round(t.mesocycles.reduce((a, m) => a + m.microcycle_days * m.microcycles_planned, 0) / 7),
        mesocycles: t.mesocycles.map((m) => ({ name: m.name, blockType: m.block_type, microcycleDays: m.microcycle_days,
          microcyclesPlanned: m.microcycles_planned, sessions: m.sessions.map((s) => s.name) })),
      });
    } catch (e) {
      bad.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { templates, invalid: bad };
}

export function loadProgramTemplate(slug: string, opts: PlanFileOptions = {}): ProgramTemplate {
  if (opts.template) return parseInput(ProgramTemplate, opts.template);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw invalid("Slug de programa no válido.");
  const file = path.join(programsDir(opts.dir), `${slug}.json`);
  if (!existsSync(file)) throw notFound(`El programa «${slug}»`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw invalid(`La plantilla «${slug}» no es JSON válido.`);
  }
  return parseInput(ProgramTemplate, raw);
}

/* ───────────────────────── Tipos del plan ───────────────────────── */

export type Macrocycle = {
  id: string; name: string; goal: ProgramTemplate["goal"]; startDate: string; endDate: string | null;
  startWeightKg: number | null; targetWeightKg: number | null; status: "borrador" | "activo" | "cerrado"; notes: string | null;
};
export type Mesocycle = {
  id: string; position: number; name: string; blockType: string; focus: string | null;
  microcycleDays: number; microcyclesPlanned: number; startDate: string | null;
};
export type Microcycle = {
  id: string; mesocycleId: string; position: number; lengthDays: number; startDate: string; endDate: string;
  isDeload: boolean; objective: string | null;
};
export type PrescriptionView = {
  id: string;
  position: number;
  exerciseId: string;
  exercise: { slug: string; name: string; primaryMuscle: string | null; kind: string; equipment: string | null; ankleLoad: string };
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
export type SessionTemplate = {
  id: string; position: number; name: string; focus: string | null; isRest: boolean; isCardio: boolean;
  plannedMinutes: number | null; prescriptions: PrescriptionView[];
};
export type ActivePlan = {
  macrocycle: Macrocycle;
  mesocycles: Mesocycle[];
  /** Mesociclo y microciclo que tocan en la fecha consultada. */
  mesocycle: Mesocycle;
  microcycle: Microcycle;
  microcycles: Microcycle[];
  /** La fecha cae después del último microciclo previsto: se sigue en el último. */
  beyondEnd: boolean;
  sessions: SessionTemplate[];
};

const MACRO_COLS = `id, name, goal, start_date as "startDate", end_date as "endDate", start_weight_kg as "startWeightKg",
  target_weight_kg as "targetWeightKg", status, notes`;
const MESO_COLS = `id, position, name, block_type as "blockType", focus, microcycle_days as "microcycleDays",
  microcycles_planned as "microcyclesPlanned", start_date as "startDate"`;
const MICRO_COLS = `id, mesocycle_id as "mesocycleId", position, length_days as "lengthDays", start_date as "startDate",
  end_date as "endDate", is_deload as "isDeload", objective`;

/* ───────────────────────── Lectura ───────────────────────── */

type RxRow = Omit<PrescriptionView, "exercise"> & {
  sessionTemplateId: string; microcyclePosition: number | null;
  slug: string; name: string; primaryMuscle: string | null; kind: string; equipment: string | null; ankleLoad: string;
};

/** Pautas de unas sesiones para un microciclo: la específica de ese microciclo gana a la general del mesociclo. */
export async function prescriptionsForTx(tx: Tx, templateIds: string[], microPosition: number | null): Promise<Map<string, PrescriptionView[]>> {
  const out = new Map<string, PrescriptionView[]>(templateIds.map((id) => [id, []]));
  if (!templateIds.length) return out;
  const rows = await tx.query<RxRow>(
    `select p.id, p.session_template_id as "sessionTemplateId", p.position, p.microcycle_position as "microcyclePosition",
       p.exercise_id as "exerciseId", p.sets, p.rep_min as "repMin", p.rep_max as "repMax", p.rir_target as "rirTarget",
       p.rest_seconds as "restSeconds", p.tempo, p.technique, p.warmup_kind as "warmupKind", p.load_cap_pct as "loadCapPct", p.notes,
       e.slug, e.name, e.primary_muscle as "primaryMuscle", e.kind, e.equipment, e.ankle_load as "ankleLoad"
     from fit.prescriptions p join fit.exercises e on e.id = p.exercise_id
     where p.session_template_id = any($1::uuid[]) and (p.microcycle_position is null or p.microcycle_position = $2)
     order by p.session_template_id, p.position, p.microcycle_position nulls last`,
    [templateIds, microPosition]);
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.sessionTemplateId}:${r.position}`;
    if (seen.has(key)) continue; // ya entró la específica del microciclo
    seen.add(key);
    const { sessionTemplateId, microcyclePosition: _mp, slug, name, primaryMuscle, kind, equipment, ankleLoad, ...rx } = r;
    out.get(sessionTemplateId)!.push({ ...rx, exercise: { slug, name, primaryMuscle, kind, equipment, ankleLoad } });
  }
  return out;
}

export async function activePlanTx(tx: Tx, date: string): Promise<ActivePlan | null> {
  const [macrocycle] = await tx.query<Macrocycle>(
    `select ${MACRO_COLS} from fit.macrocycles where status = 'activo' order by start_date desc, created_at desc limit 1`);
  if (!macrocycle) return null;
  const mesocycles = await tx.query<Mesocycle>(`select ${MESO_COLS} from fit.mesocycles where macrocycle_id = $1 order by position`, [macrocycle.id]);
  if (!mesocycles.length) return null;
  const order = new Map(mesocycles.map((m) => [m.id, m.position]));
  const all = (await tx.query<Microcycle>(
    `select ${MICRO_COLS} from fit.microcycles where mesocycle_id = any($1::uuid[])`, [mesocycles.map((m) => m.id)]))
    .sort((a, b) => order.get(a.mesocycleId)! - order.get(b.mesocycleId)! || a.position - b.position);
  if (!all.length) return null;
  const last = all[all.length - 1];
  const microcycle = all.find((m) => date <= m.endDate) ?? last; // antes del inicio → el primero; pasado el final → el último
  const mesocycle = mesocycles.find((m) => m.id === microcycle.mesocycleId)!;
  const templates = await tx.query<Omit<SessionTemplate, "prescriptions">>(
    `select id, position, name, focus, is_rest as "isRest", is_cardio as "isCardio", planned_minutes as "plannedMinutes"
     from fit.session_templates where mesocycle_id = $1 order by position`, [mesocycle.id]);
  const rx = await prescriptionsForTx(tx, templates.map((t) => t.id), microcycle.position);
  return {
    macrocycle, mesocycles, mesocycle, microcycle,
    microcycles: all.filter((m) => m.mesocycleId === mesocycle.id),
    beyondEnd: date > last.endDate,
    sessions: templates.map((t) => ({ ...t, prescriptions: rx.get(t.id) ?? [] })),
  };
}

export async function getActivePlan(userId: string, input?: DateInput, db?: Db): Promise<ActivePlan | null> {
  const date = parseDateInput(input);
  return withUser(userId, async (tx) => activePlanTx(tx, await dateOrToday(tx, date)), db);
}

/* ───────────────────────── Activar un programa ───────────────────────── */

export const ActivateProgramInput = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Slug de la plantilla de programa (ver la lista de programas)"),
  startDate: IsoDate.describe("Primer día del programa (AAAA-MM-DD)"),
  startWeightKg: z.number().min(30).max(300).optional().describe("Peso de partida en kg. Por defecto, la última pesada"),
  targetWeightKg: z.number().min(30).max(300).optional().describe("Peso objetivo en kg. Por defecto, el de la ficha"),
});
export type ActivateProgramInput = z.input<typeof ActivateProgramInput>;

const rows = (v: unknown[]) => JSON.stringify(v);

/** Crea el macrociclo activo (cierra el anterior) con sus mesociclos, microciclos encadenados, sesiones y pautas. */
export async function activateProgram(userId: string, input: ActivateProgramInput, db?: Db, opts: PlanFileOptions = {}): Promise<ActivePlan> {
  const i = parseInput(ActivateProgramInput, input);
  const t = loadProgramTemplate(i.slug, opts);
  return withUser(userId, async (tx) => {
    const bySlug = new Map((await loadLibraryTx(tx)).map((e) => [e.slug, e.id]));
    const wanted = new Set(t.mesocycles.flatMap((m) => m.sessions.flatMap((s) => s.exercises.map((e) => e.exercise))));
    const missing = [...wanted].filter((s) => !bySlug.has(s)).sort();
    if (missing.length)
      throw invalid(`Faltan ${missing.length} ejercicios en la librería: ${missing.join(", ")}.`, { missing });

    await tx.query(
      `update fit.macrocycles set status = 'cerrado',
         end_date = case when end_date is null or end_date >= $1::date then greatest(start_date, $1::date - 1) else end_date end
       where status = 'activo'`, [i.startDate]);
    const [w] = await tx.query<{ kg: number | null; waist: number | null }>(
      `select (select weight_kg from fit.body_metrics where weight_kg is not null order by date desc limit 1) as kg,
              (select waist_cm from fit.body_metrics where waist_cm is not null order by date desc limit 1) as waist`);
    const [goal] = await tx.query<{ kg: number | null; waist: number | null }>(
      `select goal_weight_kg as kg, goal_waist_cm as waist from fit.athletes where id = auth.uid()`);
    const totalDays = t.mesocycles.reduce((a, m) => a + m.microcycle_days * m.microcycles_planned, 0);
    const [macro] = await tx.query<{ id: string }>(
      `insert into fit.macrocycles (name, goal, start_date, end_date, start_weight_kg, target_weight_kg, start_waist_cm, target_waist_cm, status, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'activo', $9) returning id`,
      [t.name, t.goal, i.startDate, addDays(i.startDate, totalDays - 1), i.startWeightKg ?? w?.kg ?? null,
        i.targetWeightKg ?? goal?.kg ?? null, w?.waist ?? null, goal?.waist ?? null, t.source ? `Programa: ${t.slug}. ${t.source}` : `Programa: ${t.slug}`]);

    let cursor = i.startDate;
    for (const [mi, m] of t.mesocycles.entries()) {
      const [meso] = await tx.query<{ id: string }>(
        `insert into fit.mesocycles (macrocycle_id, position, name, block_type, focus, microcycle_days, microcycles_planned, start_date)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [macro.id, mi + 1, m.name, m.block_type, m.focus ?? null, m.microcycle_days, m.microcycles_planned, cursor]);
      const micros = Array.from({ length: m.microcycles_planned }, (_, k) => {
        const start = addDays(cursor, k * m.microcycle_days);
        return { position: k + 1, length_days: m.microcycle_days, start_date: start, end_date: addDays(start, m.microcycle_days - 1),
          is_deload: m.block_type === "descarga" };
      });
      await tx.query(
        `insert into fit.microcycles (mesocycle_id, position, length_days, start_date, end_date, is_deload)
         select $1::uuid, x.position, x.length_days, x.start_date, x.end_date, x.is_deload
         from jsonb_to_recordset($2::jsonb) as x(position smallint, length_days smallint, start_date date, end_date date, is_deload boolean)`,
        [meso.id, rows(micros)]);
      cursor = addDays(cursor, m.microcycle_days * m.microcycles_planned);

      const templates = await tx.query<{ id: string; position: number }>(
        `insert into fit.session_templates (mesocycle_id, position, name, focus, is_rest, is_cardio, planned_minutes)
         select $1::uuid, x.position, x.name, x.focus, x.is_rest, x.is_cardio, x.planned_minutes
         from jsonb_to_recordset($2::jsonb) as x(position smallint, name text, focus text, is_rest boolean, is_cardio boolean, planned_minutes smallint)
         returning id, position`,
        [meso.id, rows(m.sessions.map((s, k) => ({ position: k + 1, name: s.name, focus: s.focus ?? null, is_rest: s.is_rest,
          is_cardio: s.is_cardio, planned_minutes: s.planned_minutes ?? null })))]);
      const templateId = new Map(templates.map((r) => [r.position, r.id]));
      const rx = m.sessions.flatMap((s, k) => s.exercises.map((e, p) => ({
        session_template_id: templateId.get(k + 1), exercise_id: bySlug.get(e.exercise), position: p + 1, sets: e.sets,
        rep_min: e.rep_min ?? null, rep_max: e.rep_max ?? null, rir_target: e.rir_target ?? null, rest_seconds: e.rest_seconds ?? null,
        tempo: e.tempo ?? null, technique: e.technique ?? null, warmup_kind: e.warmup_kind ?? null, load_cap_pct: e.load_cap_pct ?? null,
        notes: e.notes ?? null,
      })));
      if (rx.length)
        await tx.query(
          `insert into fit.prescriptions (session_template_id, exercise_id, position, sets, rep_min, rep_max, rir_target, rest_seconds,
             tempo, technique, warmup_kind, load_cap_pct, notes)
           select x.session_template_id, x.exercise_id, x.position, x.sets, x.rep_min, x.rep_max, x.rir_target, x.rest_seconds,
             x.tempo, x.technique, x.warmup_kind, x.load_cap_pct, x.notes
           from jsonb_to_recordset($1::jsonb) as x(session_template_id uuid, exercise_id uuid, position smallint, sets smallint,
             rep_min smallint, rep_max smallint, rir_target numeric, rest_seconds smallint, tempo text, technique text,
             warmup_kind text, load_cap_pct smallint, notes text)`,
          [rows(rx)]);
    }
    const plan = await activePlanTx(tx, i.startDate);
    if (!plan) throw new AppError("conflicto", "El programa se creó vacío.");
    return plan;
  }, db);
}

/* ───────────────────────── Sesiones en rueda ───────────────────────── */

export type NextSession = {
  date: string;
  /** en_curso: ya hay una sesión abierta hoy · siguiente: la que sigue a la última hecha · primera: aún no hay ninguna hecha · sin_plan. */
  reason: "en_curso" | "siguiente" | "primera" | "sin_plan";
  session: SessionTemplate | null;
  workoutId: string | null;
  lastDone: { sessionTemplateId: string; name: string; date: string } | null;
  /** Días de descanso de la rueda entre la última sesión hecha y la que toca. */
  restBetween: number;
  microcycle: Microcycle | null;
  isDeload: boolean;
  doneInMicrocycle: number;
  plannedInMicrocycle: number;
  dayOfMicrocycle: number | null;
};

export async function nextSessionTx(tx: Tx, date: string): Promise<NextSession> {
  const plan = await activePlanTx(tx, date);
  if (!plan)
    return { date, reason: "sin_plan", session: null, workoutId: null, lastDone: null, restBetween: 0, microcycle: null, isDeload: false,
      doneInMicrocycle: 0, plannedInMicrocycle: 0, dayOfMicrocycle: null };
  const ids = plan.sessions.map((s) => s.id);
  const wheel = plan.sessions.filter((s) => !s.isRest);
  const [{ n: done }] = await tx.query<{ n: number }>(
    "select count(*)::int as n from fit.workouts where status = 'hecha' and microcycle_id = $1", [plan.microcycle.id]);
  const base = {
    date, microcycle: plan.microcycle, isDeload: plan.microcycle.isDeload, doneInMicrocycle: done, plannedInMicrocycle: wheel.length,
    dayOfMicrocycle: Math.min(plan.microcycle.lengthDays, Math.max(1, diffDays(plan.microcycle.startDate, date) + 1)),
  };
  const [last] = await tx.query<{ sessionTemplateId: string; date: string }>(
    `select session_template_id as "sessionTemplateId", date from fit.workouts
     where status = 'hecha' and session_template_id = any($1::uuid[])
     order by date desc, coalesce(ended_at, created_at) desc, created_at desc limit 1`, [ids]);
  const lastTemplate = last ? plan.sessions.find((s) => s.id === last.sessionTemplateId) : undefined;
  const lastDone = last && lastTemplate ? { sessionTemplateId: last.sessionTemplateId, name: lastTemplate.name, date: last.date } : null;

  const [open] = await tx.query<{ id: string; sessionTemplateId: string }>(
    `select id, session_template_id as "sessionTemplateId" from fit.workouts
     where status = 'en_curso' and date = $1 and session_template_id = any($2::uuid[]) order by created_at desc limit 1`, [date, ids]);
  if (open)
    return { ...base, reason: "en_curso", session: plan.sessions.find((s) => s.id === open.sessionTemplateId)!, workoutId: open.id, lastDone, restBetween: 0 };
  if (!wheel.length) return { ...base, reason: "primera", session: null, workoutId: null, lastDone, restBetween: 0 };
  if (!lastTemplate) return { ...base, reason: "primera", session: wheel[0], workoutId: null, lastDone: null, restBetween: 0 };

  // Recorre la rueda desde la última hecha hasta la siguiente sesión que no sea descanso.
  const n = plan.sessions.length;
  const from = plan.sessions.findIndex((s) => s.id === lastTemplate.id);
  let restBetween = 0;
  for (let k = 1; k <= n; k++) {
    const s = plan.sessions[(from + k) % n];
    if (s.isRest) { restBetween++; continue; }
    return { ...base, reason: "siguiente", session: s, workoutId: null, lastDone, restBetween };
  }
  return { ...base, reason: "siguiente", session: wheel[0], workoutId: null, lastDone, restBetween };
}

export async function getNextSession(userId: string, input?: DateInput, db?: Db): Promise<NextSession> {
  const date = parseDateInput(input);
  return withUser(userId, async (tx) => nextSessionTx(tx, await dateOrToday(tx, date)), db);
}

/* ───────────────────────── Descarga y avance ───────────────────────── */

export const SetDeloadInput = z.object({
  microcycleId: Uuid.describe("Id del microciclo"),
  isDeload: z.boolean().describe("Verdadero para marcarlo como semana de descarga"),
});

export async function setDeload(userId: string, input: z.input<typeof SetDeloadInput>, db?: Db): Promise<Microcycle> {
  const i = parseInput(SetDeloadInput, input);
  return withUser(userId, async (tx) => {
    const r = await tx.query<Microcycle>(
      `update fit.microcycles set is_deload = $1, objective = case when $1 then coalesce(objective, 'Descarga') else nullif(objective, 'Descarga') end
       where id = $2 returning ${MICRO_COLS}`, [i.isDeload, i.microcycleId]);
    if (!r[0]) throw notFound("El microciclo");
    return r[0];
  }, db);
}

export const AdvanceMicrocycleInput = z.object({
  date: IsoDate.optional().describe("Día en que empieza el siguiente microciclo (AAAA-MM-DD). Por defecto, hoy"),
});

/**
 * Cierra el microciclo actual el día anterior a `date` y empieza el siguiente ese día, re-encadenando las fechas
 * de todos los posteriores. Sirve cuando la rueda se termina antes o después de lo previsto.
 */
export async function advanceMicrocycle(userId: string, input?: z.input<typeof AdvanceMicrocycleInput>, db?: Db): Promise<ActivePlan> {
  const i = parseInput(AdvanceMicrocycleInput, input ?? {});
  return withUser(userId, async (tx) => {
    const date = await dateOrToday(tx, i.date);
    const plan = await activePlanTx(tx, date);
    if (!plan) throw notFound("El programa activo");
    const order = new Map(plan.mesocycles.map((m) => [m.id, m.position]));
    const all = (await tx.query<Microcycle>(
      `select ${MICRO_COLS} from fit.microcycles where mesocycle_id = any($1::uuid[])`, [plan.mesocycles.map((m) => m.id)]))
      .sort((a, b) => order.get(a.mesocycleId)! - order.get(b.mesocycleId)! || a.position - b.position);
    const at = all.findIndex((m) => m.id === plan.microcycle.id);
    const later = all.slice(at + 1);
    if (!later.length) throw new AppError("conflicto", "Es el último microciclo del programa: no hay siguiente.");
    if (date <= plan.microcycle.startDate) throw invalid("El microciclo actual empieza ese día o después: no se puede cerrar antes.");
    await tx.query("update fit.microcycles set end_date = $1 where id = $2", [addDays(date, -1), plan.microcycle.id]);
    let cursor = date;
    const mesoStart = new Map<string, string>();
    for (const m of later) {
      const end = addDays(cursor, m.lengthDays - 1);
      await tx.query("update fit.microcycles set start_date = $1, end_date = $2 where id = $3", [cursor, end, m.id]);
      if (!mesoStart.has(m.mesocycleId) && m.position === 1) mesoStart.set(m.mesocycleId, cursor);
      cursor = addDays(end, 1);
    }
    for (const [id, start] of mesoStart) await tx.query("update fit.mesocycles set start_date = $1 where id = $2", [start, id]);
    await tx.query("update fit.macrocycles set end_date = $1 where id = $2", [addDays(cursor, -1), plan.macrocycle.id]);
    return (await activePlanTx(tx, date))!;
  }, db);
}
