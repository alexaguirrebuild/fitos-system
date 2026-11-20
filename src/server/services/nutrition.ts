/**
 * Nutrición: objetivos (calibración → gasto medido), tipo de día On/Off, registro de comida, comidas ancla,
 * cafeína, lista de la compra y revisión semanal. Las fórmulas viven en src/engine/nutrition.ts.
 * Regla de la casa: aquí no se inventan calorías ni precios. Si falta el dato, se dice.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { stepsGoal } from "@/engine/cardio";
import {
  adaptiveTdee, bodyComposition, caffeineCutoff, caffeineMaxMg, maxRateByBodyFat, mifflin, planTargets, proteinPerEuro, scaleMacros,
  targetRatePct, weeklyDecision, weeklyRatePct, weightTrend, type Sex, type WeeklyAction,
} from "@/engine/nutrition";
import { notFound } from "@/server/errors";
import type { FetchLike } from "@/server/off";
import { addDays, diffDays, todayIn, weekStart as mondayOf } from "@/server/time";
import { Id, IsoDate, IsoDateTime, localTimeIn, parseInput, toIso } from "./annotations";
import { FOOD_STORES, hasFreshPrice, lookupBarcode, per100, preferOwn, toFood, type Food, type FoodRow } from "./foods";

/* ------------------------------- Tipos comunes ------------------------------- */

export const MEALS = ["desayuno", "comida", "cena", "pre", "intra", "post", "snack"] as const;
export type Meal = (typeof MEALS)[number];
export const DAY_TYPES = ["on", "off"] as const;
export type DayType = (typeof DAY_TYPES)[number];
export type Macros = { kcal: number; proteinG: number; carbsG: number; fatG: number };
export type NutritionPhase = "calibracion" | "deficit" | "mantenimiento" | "superavit";

/** Días con comida anotada que cuentan para medir el gasto: al menos estas kcal. */
export const MIN_LOGGED_KCAL = 1200;
export const CALIBRATION_DAYS = 14;
export const CALIBRATION_WEIGH_INS = 8;
export const CALIBRATION_ACTIVITY_FACTOR = 1.55;
const ADHD_CAFFEINE_NOTE = "Con medicación para el TDAH (o sin confirmar), la cafeína la decides con tu médico: aquí solo se registra.";

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const es = (n: number) => String(n).replace(".", ",");
const ZERO: Macros = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
const addMacros = (a: Macros, b: Macros): Macros => ({ kcal: r1(a.kcal + b.kcal), proteinG: r1(a.proteinG + b.proteinG), carbsG: r1(a.carbsG + b.carbsG), fatG: r1(a.fatG + b.fatG) });
const subMacros = (a: Macros, b: Macros): Macros => ({ kcal: r1(a.kcal - b.kcal), proteinG: r1(a.proteinG - b.proteinG), carbsG: r1(a.carbsG - b.carbsG), fatG: r1(a.fatG - b.fatG) });

type AthleteRow = {
  id: string; sex: Sex; birth_date: string | null; height_cm: number | null; height_confirmed: boolean; timezone: string;
  bedtime: string | null; wake_time: string | null; adhd_medication: boolean | null; goal_weight_kg: number | null;
  steps_goal: number; steps_off_extra: number; weekly_food_budget_eur: number | null; stores: string[];
};

async function athleteRow(tx: Tx): Promise<AthleteRow> {
  const r = await tx.query<AthleteRow>(
    `select id, sex, birth_date, height_cm, height_confirmed, timezone, bedtime, wake_time, adhd_medication, goal_weight_kg,
            steps_goal, steps_off_extra, weekly_food_budget_eur, stores from fit.athletes limit 1`,
  );
  if (!r[0]) throw notFound("El atleta");
  return r[0];
}

function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/* --------------------------------- Objetivos --------------------------------- */

export type NutritionTarget = {
  id: string | null;
  validFrom: string;
  phase: NutritionPhase;
  tdee: number;
  tdeeMethod: "mifflin" | "medido" | "manual";
  leanKg: number | null;
  ratePctWeek: number;
  avgKcal: number;
  onOffSpread: number;
  on: Macros;
  off: Macros;
  reason: string | null;
};

type TargetRow = {
  id: string; valid_from: string; phase: NutritionPhase; tdee: number; tdee_method: NutritionTarget["tdeeMethod"]; lean_kg: number | null;
  rate_pct_week: number; avg_kcal: number; on_off_spread: number; on_kcal: number; on_protein_g: number; on_carbs_g: number; on_fat_g: number;
  off_kcal: number; off_protein_g: number; off_carbs_g: number; off_fat_g: number; reason: string | null;
};

const toTarget = (r: TargetRow): NutritionTarget => ({
  id: r.id, validFrom: r.valid_from, phase: r.phase, tdee: r.tdee, tdeeMethod: r.tdee_method, leanKg: r.lean_kg, ratePctWeek: r.rate_pct_week,
  avgKcal: r.avg_kcal, onOffSpread: r.on_off_spread, reason: r.reason,
  on: { kcal: r.on_kcal, proteinG: r.on_protein_g, carbsG: r.on_carbs_g, fatG: r.on_fat_g },
  off: { kcal: r.off_kcal, proteinG: r.off_protein_g, carbsG: r.off_carbs_g, fatG: r.off_fat_g },
});

/** Objetivo vigente en `date` (el último con valid_from ≤ date). */
export async function currentTargetTx(tx: Tx, date: string): Promise<NutritionTarget | null> {
  const r = await tx.query<TargetRow>("select * from fit.nutrition_targets where valid_from <= $1::date order by valid_from desc limit 1", [date]);
  return r[0] ? toTarget(r[0]) : null;
}

export const RecalcTargetsInput = z.object({
  date: IsoDate.optional().describe("Día para el que se calculan los objetivos (AAAA-MM-DD). Por defecto, hoy."),
  force: z.boolean().optional().describe("Guarda una fila nueva aunque el cambio sea pequeño o haya objetivos manuales."),
});
export type RecalcTargetsInput = z.input<typeof RecalcTargetsInput>;

export type RecalcTargetsResult =
  | { ok: false; missing: ("peso" | "altura" | "fecha_nacimiento")[]; warnings: string[] }
  | {
      ok: true;
      saved: boolean;
      date: string;
      target: NutritionTarget;
      weeklyKcal: number;
      trainDaysPerWeek: number;
      weightKg: number;
      bodyFat: { pct: number | null; method: string; marginPts: number | null };
      expectedKgPerWeek: number;
      intraCarbG: [number, number] | null;
      calibration: { loggedDays: number; weighIns: number; needDays: number; needWeighIns: number };
      explain: string[];
      warnings: string[];
    };

/**
 * Recalcula los objetivos de kcal y macros On/Off. Calibración (Mifflin × 1,55, a mantenimiento) hasta tener
 * 14 días con comida y 8 pesadas; después, gasto medido y déficit según el peso objetivo.
 * Solo guarda fila nueva si cambia algo relevante (> 50 kcal o cambio de fase) o con `force`.
 */
export async function recalcTargets(userId: string, input: RecalcTargetsInput = {}, db?: Db): Promise<RecalcTargetsResult> {
  const i = parseInput(RecalcTargetsInput, input);
  return withUser(userId, async (tx) => {
    const a = await athleteRow(tx);
    const date = i.date ?? todayIn(a.timezone);
    const warnings: string[] = [];
    const explain: string[] = [];

    let weights = await tx.query<{ date: string; kg: number }>(
      "select date, weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1::date and date >= $1::date - 60 order by date",
      [date],
    );
    if (!weights.length) {
      weights = await tx.query<{ date: string; kg: number }>(
        "select date, weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1::date order by date desc limit 1",
        [date],
      );
      if (weights.length) warnings.push(`La última pesada es del ${weights[0].date}: pésate para afinar los objetivos.`);
    }
    const missing: ("peso" | "altura" | "fecha_nacimiento")[] = [];
    if (!weights.length) missing.push("peso");
    if (!a.height_cm) missing.push("altura");
    if (!a.birth_date) missing.push("fecha_nacimiento");
    if (missing.length) {
      const names = { peso: "una pesada", altura: "la altura", fecha_nacimiento: "la fecha de nacimiento" };
      return { ok: false, missing, warnings: [`No se pueden calcular los objetivos: falta ${missing.map((m) => names[m]).join(", ")}.`] };
    }
    if (!a.height_confirmed) warnings.push("Altura sin confirmar: los objetivos pueden moverse cuando la confirmes.");

    const trend = weightTrend(weights);
    const end = trend[trend.length - 1];
    const kg = r1(end.trend);
    const heightCm = a.height_cm!;
    const age = ageOn(a.birth_date!, date);
    explain.push(`Peso de tendencia: ${es(kg)} kg (${weights.length} ${weights.length === 1 ? "pesada" : "pesadas"} en 60 días, la última el ${end.date}).`);
    explain.push(`Altura ${es(heightCm)} cm${a.height_confirmed ? "" : " (sin confirmar)"}, ${age} años, sexo ${a.sex}.`);

    const m = (await tx.query<{ waist_cm: number | null; neck_cm: number | null; bf_pct: number | null }>(
      `select
         (select waist_cm from fit.body_metrics where waist_cm is not null and date <= $1::date order by date desc limit 1) as waist_cm,
         (select neck_cm from fit.body_metrics where neck_cm is not null and date <= $1::date order by date desc limit 1) as neck_cm,
         (select bf_pct from fit.body_metrics where bf_pct is not null and date <= $1::date and date >= $1::date - 60
             and coalesce(bf_method, '') not in ('navy', 'rfm', 'sin_dato') order by date desc limit 1) as bf_pct`,
      [date],
    ))[0];
    const comp = bodyComposition({ kg, heightCm, waistCm: m.waist_cm, neckCm: m.neck_cm, sex: a.sex, measuredBfPct: m.bf_pct });
    let leanKg = comp.leanKg;
    if (leanKg == null) {
      leanKg = r1(kg * 0.8);
      warnings.push("Sin cintura ni % graso medido: la proteína se calcula suponiendo un 20 % de grasa. Mide la cintura.");
      explain.push(`Composición: sin dato. Masa magra supuesta ${es(leanKg)} kg (80 % del peso).`);
    } else {
      explain.push(`Composición: ${es(comp.bfPct!)} % de grasa (método ${comp.method}, ±${es(comp.marginPts!)} puntos) → ${es(leanKg)} kg de masa magra.`);
    }

    const tr = (await tx.query<{ n: number; first: string | null }>(
      `select
         (select count(distinct w.date)::int from fit.workouts w left join fit.session_templates st on st.id = w.session_template_id
           where w.status = 'hecha' and w.date > $1::date - 28 and w.date <= $1::date
             and coalesce(st.is_cardio, false) = false and coalesce(st.is_rest, false) = false) as n,
         (select min(w.date) from fit.workouts w where w.status = 'hecha' and w.date <= $1::date) as first`,
      [date],
    ))[0];
    let trainDays = 5;
    if (tr.n > 0 && tr.first) {
      const weeks = Math.max(1, Math.min(4, Math.ceil((diffDays(tr.first, date) + 1) / 7)));
      trainDays = Math.max(1, Math.min(7, Math.round(tr.n / weeks)));
      explain.push(`Días de entreno por semana: ${trainDays} (${tr.n} sesiones hechas en las últimas ${weeks === 1 ? "1 semana" : `${weeks} semanas`}).`);
    } else {
      explain.push("Días de entreno por semana: 5 (sin sesiones hechas en las últimas 4 semanas, se supone 5).");
    }

    const rmr = mifflin(kg, heightCm, age, a.sex);
    explain.push(`Gasto en reposo (Mifflin-St Jeor): ${r0(rmr)} kcal.`);

    // ¿Se puede medir el gasto? Hace falta un tramo de 14-28 días entre dos pesadas, con comida anotada y pesadas suficientes.
    const from14 = addDays(date, -(CALIBRATION_DAYS - 1));
    const intake = await tx.query<{ date: string; kcal: number }>(
      "select date, sum(kcal) as kcal from fit.food_logs where date > $1::date - 29 and date <= $1::date group by date",
      [date],
    );
    const logged = intake.filter((d) => d.kcal >= MIN_LOGGED_KCAL);
    const calibration = {
      loggedDays: logged.filter((d) => d.date >= from14).length,
      weighIns: weights.filter((w) => w.date >= from14).length,
      needDays: Math.ceil(CALIBRATION_DAYS * 0.8),
      needWeighIns: CALIBRATION_WEIGH_INS,
    };

    let measured: number | null = null;
    const start = diffDays(end.date, date) <= 3
      ? [...trend].reverse().find((p) => { const d = diffDays(p.date, end.date); return d >= CALIBRATION_DAYS && d <= 28; })
      : undefined;
    if (start) {
      const span = diffDays(start.date, end.date);
      const days = logged.filter((d) => d.date > start.date && d.date <= end.date);
      const weighIns = weights.filter((w) => w.date >= start.date && w.date <= end.date).length;
      if (days.length >= Math.ceil(span * 0.8) && weighIns >= CALIBRATION_WEIGH_INS) {
        const intakeAvg = days.reduce((s, d) => s + d.kcal, 0) / days.length;
        const t = adaptiveTdee({ intakeAvgKcal: intakeAvg, trendStartKg: start.trend, trendEndKg: end.trend, days: span });
        if (t != null && t >= rmr && t <= rmr * 2.5) {
          measured = t;
          explain.push(`TDEE medido: ${r0(intakeAvg)} kcal de media en ${days.length} días anotados y la tendencia pasó de ${es(r1(start.trend))} a ${es(r1(end.trend))} kg en ${span} días → ${t} kcal.`);
        } else if (t != null) {
          warnings.push(`El gasto medido (${t} kcal) no es creíble frente al reposo (${r0(rmr)} kcal): se sigue en calibración. Revisa lo anotado.`);
        }
      }
    }

    let phase: NutritionPhase;
    let tdee: number;
    let tdeeMethod: NutritionTarget["tdeeMethod"];
    let rate = 0;
    if (measured == null) {
      phase = "calibracion";
      tdeeMethod = "mifflin";
      tdee = r0(rmr * CALIBRATION_ACTIVITY_FACTOR);
      explain.push(`Fase de calibración: TDEE estimado = Mifflin × ${es(CALIBRATION_ACTIVITY_FACTOR)} = ${tdee} kcal. Se come a mantenimiento hasta poder medirlo.`);
      explain.push(`Para medirlo hacen falta ${CALIBRATION_DAYS} días con comida anotada (al menos ${calibration.needDays} con ${MIN_LOGGED_KCAL} kcal o más) y ${CALIBRATION_WEIGH_INS} pesadas. En los últimos ${CALIBRATION_DAYS} días llevas ${calibration.loggedDays} días y ${calibration.weighIns} pesadas.`);
    } else {
      tdeeMethod = "medido";
      tdee = measured;
      if (a.goal_weight_kg == null) {
        warnings.push("Sin peso objetivo en tu ficha: se queda a mantenimiento.");
      } else {
        rate = targetRatePct(kg, a.goal_weight_kg);
        // Tope del motor: con poca grasa se pierde más despacio (% graso / 20, máximo 1 %).
        const cap = comp.bfPct != null ? maxRateByBodyFat(comp.bfPct) : null;
        if (cap != null && rate > cap) {
          explain.push(`Ritmo recortado de ${es(rate)} a ${es(cap)} % por semana: con un ${es(comp.bfPct!)} % de grasa no conviene ir más rápido.`);
          rate = cap;
        }
      }
      phase = rate > 0 ? "deficit" : "mantenimiento";
      explain.push(rate > 0
        ? `Ritmo objetivo: ${es(rate)} % del peso por semana (peso objetivo ${es(a.goal_weight_kg!)} kg).`
        : "Ritmo objetivo: 0 % (mantenimiento).");
    }

    const plan = planTargets({ kg, leanKg, tdee, ratePctWeek: rate, trainDaysPerWeek: trainDays });
    warnings.push(...plan.warnings);
    const macros = (d: typeof plan.on): Macros => ({ kcal: d.kcal, proteinG: d.proteinG, carbsG: d.carbG, fatG: d.fatG });
    const on = macros(plan.on);
    const off = macros(plan.off);
    const line = (t: Macros) => `${t.kcal} kcal · proteína ${t.proteinG} g · hidratos ${t.carbsG} g · grasa ${t.fatG} g`;
    if (plan.deficitKcal > 0) explain.push(`Déficit: ${plan.deficitKcal} kcal al día (${plan.deficitPct} % del gasto) → unos ${es(plan.expectedKgPerWeek)} kg por semana.`);
    explain.push(`Proteína: 2,3 g por kg de masa magra. Grasa: 0,8 g por kg de peso. El resto, hidratos.`);
    explain.push(`Día On (${trainDays} por semana): ${line(on)}.`);
    explain.push(`Día Off (${7 - trainDays} por semana): ${line(off)}.`);
    explain.push(`Total semanal: ${plan.weeklyKcal} kcal (media ${plan.avgKcal} al día).`);

    const prevRow = (await tx.query<TargetRow>("select * from fit.nutrition_targets where valid_from <= $1::date order by valid_from desc limit 1", [date]))[0];
    const changed = !prevRow || prevRow.phase !== phase
      || Math.abs(prevRow.avg_kcal - plan.avgKcal) > 50 || Math.abs(prevRow.on_kcal - on.kcal) > 50 || Math.abs(prevRow.off_kcal - off.kcal) > 50;
    const reason = phase === "calibracion" ? "Calibración: Mifflin × 1,55 a mantenimiento." : `Gasto medido (${tdee} kcal), ritmo ${es(rate)} %/semana.`;
    let target: NutritionTarget = {
      id: null, validFrom: date, phase, tdee, tdeeMethod, leanKg, ratePctWeek: rate, avgKcal: plan.avgKcal, onOffSpread: 0.12, on, off, reason,
    };
    let saved = false;
    if (prevRow?.tdee_method === "manual" && !i.force) {
      warnings.push("Tienes objetivos puestos a mano: no se pisan. Usa `force` para sustituirlos por estos.");
    } else if (changed || i.force) {
      const ins = await tx.query<TargetRow>(
        `insert into fit.nutrition_targets as t (user_id, valid_from, phase, tdee, tdee_method, lean_kg, rate_pct_week, avg_kcal, on_off_spread,
           on_kcal, on_protein_g, on_carbs_g, on_fat_g, off_kcal, off_protein_g, off_carbs_g, off_fat_g, protein_per_lean_kg, fat_per_kg, reason)
         values ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, 0.12, $9, $10, $11, $12, $13, $14, $15, $16, 2.3, 0.8, $17)
         on conflict (user_id, valid_from) do update set phase = excluded.phase, tdee = excluded.tdee, tdee_method = excluded.tdee_method,
           lean_kg = excluded.lean_kg, rate_pct_week = excluded.rate_pct_week, avg_kcal = excluded.avg_kcal, on_off_spread = excluded.on_off_spread,
           on_kcal = excluded.on_kcal, on_protein_g = excluded.on_protein_g, on_carbs_g = excluded.on_carbs_g, on_fat_g = excluded.on_fat_g,
           off_kcal = excluded.off_kcal, off_protein_g = excluded.off_protein_g, off_carbs_g = excluded.off_carbs_g, off_fat_g = excluded.off_fat_g,
           protein_per_lean_kg = excluded.protein_per_lean_kg, fat_per_kg = excluded.fat_per_kg, reason = excluded.reason
         returning *`,
        [userId, date, phase, tdee, tdeeMethod, leanKg, rate, plan.avgKcal, on.kcal, on.proteinG, on.carbsG, on.fatG, off.kcal, off.proteinG, off.carbsG, off.fatG, reason],
      );
      target = toTarget(ins[0]);
      saved = true;
    } else {
      explain.push(`Sin cambio relevante frente a los objetivos del ${prevRow.valid_from} (menos de 50 kcal y misma fase): no se guarda fila nueva.`);
    }

    return {
      ok: true, saved, date, target, weeklyKcal: plan.weeklyKcal, trainDaysPerWeek: trainDays, weightKg: kg,
      bodyFat: { pct: comp.bfPct, method: comp.method, marginPts: comp.marginPts },
      expectedKgPerWeek: plan.expectedKgPerWeek, intraCarbG: plan.on.intraCarbG ?? null, calibration, explain, warnings,
    };
  }, db);
}

/* ------------------------------- Tipo de día ------------------------------- */

type PlanInfo = {
  templates: { id: string; isRest: boolean; isCardio: boolean }[];
  microcycleDays: number;
  mesoStart: string | null;
  weightsPerCycle: number;
  last: { index: number; date: string } | null;
};

/** Rueda de sesiones del mesociclo en curso del macrociclo activo. null si no hay plan. */
async function planInfoTx(tx: Tx, today: string): Promise<PlanInfo | null> {
  const rows = await tx.query<{ id: string; is_rest: boolean; is_cardio: boolean; mesocycle_id: string; microcycle_days: number; meso_start: string | null; macro_id: string }>(
    `select st.id, st.is_rest, st.is_cardio, st.mesocycle_id, me.microcycle_days, me.start_date as meso_start, ma.id as macro_id
       from fit.session_templates st
       join fit.mesocycles me on me.id = st.mesocycle_id
       join fit.macrocycles ma on ma.id = me.macrocycle_id
      where ma.status = 'activo'
      order by ma.start_date desc, ma.created_at desc, me.position, st.position`,
  );
  if (!rows.length) return null;
  const inMacro = rows.filter((r) => r.macro_id === rows[0].macro_id);
  const lastW = (await tx.query<{ session_template_id: string; date: string }>(
    `select session_template_id, date from fit.workouts
      where session_template_id is not null and status in ('hecha', 'en_curso', 'saltada') and date <= $1::date
      order by date desc, created_at desc limit 1`,
    [today],
  ))[0];
  let mesoId = lastW ? inMacro.find((r) => r.id === lastW.session_template_id)?.mesocycle_id : undefined;
  if (!mesoId) {
    const started = inMacro.filter((r) => r.meso_start && r.meso_start <= today).sort((x, y) => y.meso_start!.localeCompare(x.meso_start!));
    mesoId = (started[0] ?? inMacro[0]).mesocycle_id;
  }
  const meso = inMacro.filter((r) => r.mesocycle_id === mesoId);
  const index = lastW ? meso.findIndex((r) => r.id === lastW.session_template_id) : -1;
  return {
    templates: meso.map((r) => ({ id: r.id, isRest: r.is_rest, isCardio: r.is_cardio })),
    microcycleDays: meso[0].microcycle_days,
    mesoStart: meso[0].meso_start,
    weightsPerCycle: meso.filter((r) => !r.is_rest && !r.is_cardio).length,
    last: index >= 0 ? { index, date: lastW.date } : null,
  };
}

/** Días On por semana según el plan (sesiones de pesas de la rueda llevadas a 7 días). null sin plan. */
function plannedOnDays(plan: PlanInfo | null): number | null {
  if (!plan || !plan.templates.length) return null;
  const cycle = Math.max(plan.microcycleDays, plan.templates.length);
  return Math.max(0, Math.min(7, Math.round((plan.weightsPerCycle * 7) / cycle)));
}

export type DayTypeInfo = {
  date: string;
  dayType: DayType;
  forced: boolean;
  /** true si no se ha podido determinar y se supone. */
  assumed: boolean;
  basis: "forzado" | "sesion" | "plan" | "sin_sesion" | "sin_plan";
};

export async function dayTypeTx(tx: Tx, date: string, today: string): Promise<DayTypeInfo> {
  const forced = await tx.query<{ day_type: DayType }>("select day_type from fit.nutrition_days where date = $1::date and forced", [date]);
  if (forced[0]) return { date, dayType: forced[0].day_type, forced: true, assumed: false, basis: "forzado" };

  const ws = await tx.query<{ status: string }>(
    `select w.status from fit.workouts w left join fit.session_templates st on st.id = w.session_template_id
      where w.date = $1::date and coalesce(st.is_cardio, false) = false and coalesce(st.is_rest, false) = false`,
    [date],
  );
  if (ws.some((w) => w.status === "hecha" || w.status === "en_curso")) return { date, dayType: "on", forced: false, assumed: false, basis: "sesion" };
  if (date < today || ws.length) return { date, dayType: "off", forced: false, assumed: false, basis: "sin_sesion" };

  const plan = await planInfoTx(tx, today);
  const n = plan?.templates.length ?? 0;
  if (!plan || !n) return { date, dayType: "off", forced: false, assumed: true, basis: "sin_plan" };
  const ahead = diffDays(today, date);
  const implicitRest = n < plan.microcycleDays; // la rueda no dice qué días se descansa
  if (implicitRest) {
    if (ahead > 0) return { date, dayType: "off", forced: false, assumed: true, basis: "sin_plan" };
    const next = plan.templates[((plan.last?.index ?? -1) + 1) % n];
    return { date, dayType: next.isRest || next.isCardio ? "off" : "on", forced: false, assumed: true, basis: "plan" };
  }
  // Rueda con los descansos escritos: una casilla por día desde la última sesión (o desde el inicio del mesociclo).
  const slot = plan.last
    ? plan.last.index + diffDays(plan.last.date, date)
    : plan.mesoStart && plan.mesoStart <= date ? diffDays(plan.mesoStart, date) : ahead;
  const t = plan.templates[((slot % n) + n) % n];
  return { date, dayType: t.isRest || t.isCardio ? "off" : "on", forced: false, assumed: false, basis: "plan" };
}

export const GetDayTypeInput = z.object({
  date: IsoDate.optional().describe("Día (AAAA-MM-DD). Por defecto, hoy."),
});
export type GetDayTypeInput = z.input<typeof GetDayTypeInput>;

/** 'on' si hay sesión de pesas ese día (hecha o en curso) o el plan la prevé; si no se puede saber, 'off' con `assumed: true`. */
export async function getDayType(userId: string, input: GetDayTypeInput = {}, db?: Db): Promise<DayTypeInfo> {
  const i = parseInput(GetDayTypeInput, input);
  return withUser(userId, async (tx) => {
    const today = todayIn((await athleteRow(tx)).timezone);
    return dayTypeTx(tx, i.date ?? today, today);
  }, db);
}

export const SetDayTypeInput = z.object({
  date: IsoDate.optional().describe("Día (AAAA-MM-DD). Por defecto, hoy."),
  dayType: z.enum(["on", "off", "auto"]).describe("on u off para forzarlo; auto quita el forzado y vuelve a deducirse."),
});
export type SetDayTypeInput = z.input<typeof SetDayTypeInput>;

export async function setDayType(userId: string, input: SetDayTypeInput, db?: Db): Promise<DayTypeInfo> {
  const i = parseInput(SetDayTypeInput, input);
  return withUser(userId, async (tx) => {
    const today = todayIn((await athleteRow(tx)).timezone);
    const date = i.date ?? today;
    if (i.dayType === "auto") await tx.query("delete from fit.nutrition_days where date = $1::date", [date]);
    else
      await tx.query(
        `insert into fit.nutrition_days as d (user_id, date, day_type, forced) values ($1::uuid, $2::date, $3, true)
         on conflict (user_id, date) do update set day_type = excluded.day_type, forced = true, updated_at = now()`,
        [userId, date, i.dayType],
      );
    return dayTypeTx(tx, date, today);
  }, db);
}

/* ------------------------------ Registro del día ------------------------------ */

export type FoodLog = {
  id: string;
  date: string;
  loggedAt: string;
  meal: Meal;
  foodId: string | null;
  foodName: string | null;
  description: string | null;
  grams: number | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  estimated: boolean;
  source: "app" | "barcode" | "muse" | "plantilla" | "import";
};

type FoodLogRow = {
  id: string; date: string; logged_at: Date | string; meal: Meal; food_id: string | null; food_name?: string | null; description: string | null;
  grams: number | null; kcal: number; protein_g: number; carbs_g: number; fat_g: number; estimated: boolean; source: FoodLog["source"];
};

const toLog = (r: FoodLogRow, foodName?: string | null): FoodLog => ({
  id: r.id, date: r.date, loggedAt: toIso(r.logged_at)!, meal: r.meal, foodId: r.food_id, foodName: foodName ?? r.food_name ?? null,
  description: r.description, grams: r.grams, kcal: r.kcal, proteinG: r.protein_g, carbsG: r.carbs_g, fatG: r.fat_g, estimated: r.estimated, source: r.source,
});
const logMacros = (l: FoodLog): Macros => ({ kcal: l.kcal, proteinG: l.proteinG, carbsG: l.carbsG, fatG: l.fatG });

async function dayLogsTx(tx: Tx, date: string): Promise<{ logs: FoodLog[]; totals: Macros }> {
  const rows = await tx.query<FoodLogRow>(
    "select l.*, f.name as food_name from fit.food_logs l left join fit.foods f on f.id = l.food_id where l.date = $1::date order by l.logged_at, l.id",
    [date],
  );
  const logs = rows.map((r) => toLog(r));
  return { logs, totals: logs.reduce((s, l) => addMacros(s, logMacros(l)), ZERO) };
}

export type DayTotals = { date: string; dayType: DayType; target: Macros | null; totals: Macros; remaining: Macros | null };

async function dayTotalsTx(tx: Tx, date: string, today: string): Promise<DayTotals> {
  const [{ totals }, dt, target] = [await dayLogsTx(tx, date), await dayTypeTx(tx, date, today), await currentTargetTx(tx, date)];
  const t = target ? target[dt.dayType] : null;
  return { date, dayType: dt.dayType, target: t, totals, remaining: t ? subMacros(t, totals) : null };
}

/** Minutos desde el corte, dentro de la ventana corte → hora de levantarse (o 15 h si no hay). */
function isAfterCutoff(time: string, cutoff: string, wakeTime: string | null): boolean {
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const delta = (mins(time) - mins(cutoff) + 1440) % 1440;
  const window = wakeTime ? (mins(wakeTime) - mins(cutoff) + 1440) % 1440 : 15 * 60;
  return delta > 0 && delta < window;
}

export const GetNutritionDayInput = z.object({
  date: IsoDate.optional().describe("Día (AAAA-MM-DD). Por defecto, hoy."),
});
export type GetNutritionDayInput = z.input<typeof GetNutritionDayInput>;

export type CaffeineStatus = { cutoff: string | null; maxMg: number | null; todayMg: number; lateDoses: number; note?: string };

export type NutritionDay = {
  date: string;
  dayType: DayType;
  dayTypeForced: boolean;
  dayTypeAssumed: boolean;
  phase: NutritionPhase | null;
  /** Objetivo del día según sea On u Off; null si aún no hay objetivos calculados. */
  target: Macros | null;
  logs: FoodLog[];
  totals: Macros;
  remaining: Macros | null;
  byMeal: Partial<Record<Meal, Macros & { items: number }>>;
  /** Proteína comida sobre el objetivo de proteína, en %. */
  proteinPct: number | null;
  caffeine: CaffeineStatus;
  steps: { goal: number; done: number | null };
};

async function caffeineStatusTx(tx: Tx, a: AthleteRow, date: string): Promise<CaffeineStatus> {
  const c = (await tx.query<{ mg: number; late: number }>(
    `select coalesce(sum(mg), 0)::int as mg, (count(*) filter (where after_cutoff))::int as late
       from fit.caffeine_logs where (taken_at at time zone $2)::date = $1::date`,
    [date, a.timezone],
  ))[0];
  const cutoff = a.bedtime ? caffeineCutoff(a.bedtime.slice(0, 5)) : null;
  if (a.adhd_medication !== false) return { cutoff, maxMg: null, todayMg: c.mg, lateDoses: c.late, note: ADHD_CAFFEINE_NOTE };
  const w = await tx.query<{ kg: number }>("select weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1::date order by date desc limit 1", [date]);
  return { cutoff, maxMg: w[0] ? caffeineMaxMg(w[0].kg) : null, todayMg: c.mg, lateDoses: c.late };
}

export async function getNutritionDay(userId: string, input: GetNutritionDayInput = {}, db?: Db): Promise<NutritionDay> {
  const i = parseInput(GetNutritionDayInput, input);
  return withUser(userId, async (tx) => {
    const a = await athleteRow(tx);
    const today = todayIn(a.timezone);
    const date = i.date ?? today;
    const dt = await dayTypeTx(tx, date, today);
    const target = await currentTargetTx(tx, date);
    const { logs, totals } = await dayLogsTx(tx, date);
    const t = target ? target[dt.dayType] : null;
    const byMeal: NutritionDay["byMeal"] = {};
    for (const l of logs) {
      const prev = byMeal[l.meal] ?? { ...ZERO, items: 0 };
      byMeal[l.meal] = { ...addMacros(prev, logMacros(l)), items: prev.items + 1 };
    }
    const act = await tx.query<{ steps: number | null }>("select steps from fit.daily_activity where date = $1::date", [date]);
    return {
      date, dayType: dt.dayType, dayTypeForced: dt.forced, dayTypeAssumed: dt.assumed, phase: target?.phase ?? null, target: t, logs, totals,
      remaining: t ? subMacros(t, totals) : null, byMeal,
      proteinPct: t && t.proteinG > 0 ? r0((totals.proteinG / t.proteinG) * 100) : null,
      caffeine: await caffeineStatusTx(tx, a, date),
      steps: { goal: stepsGoal(dt.dayType === "on", a.steps_goal, a.steps_off_extra), done: act[0]?.steps ?? null },
    };
  }, db);
}

/* ------------------------------- Anotar comida ------------------------------- */

const grams = z.number().positive().max(5000);
const macroG = z.number().min(0).max(2000);

export const LogFoodInput = z.object({
  date: IsoDate.optional().describe("Día (AAAA-MM-DD). Por defecto, hoy."),
  meal: z.enum(MEALS).optional().describe("Comida: desayuno, comida, cena, pre, intra, post o snack. Por defecto, según la hora."),
  foodId: Id.optional().describe("Id de un alimento del catálogo. Necesita `grams`."),
  barcode: z.string().trim().min(8).max(32).optional().describe("Código de barras del producto. Necesita `grams`."),
  description: z.string().trim().max(300).optional().describe("Texto libre («2 huevos y 80 g de avena»). Por sí solo no basta: hacen falta gramos o macros."),
  grams: grams.optional().describe("Gramos (o mililitros) consumidos del alimento."),
  kcal: z.number().min(0).max(10_000).optional().describe("Calorías, si se anotan a mano."),
  proteinG: macroG.optional().describe("Gramos de proteína, si se anotan a mano."),
  carbsG: macroG.optional().describe("Gramos de hidratos, si se anotan a mano."),
  fatG: macroG.optional().describe("Gramos de grasa, si se anotan a mano."),
  source: z.enum(["app", "barcode", "muse", "plantilla", "import"]).optional().describe("Origen del apunte. Por defecto, app (o barcode si viene con código)."),
});
export type LogFoodInput = z.input<typeof LogFoodInput>;

export type LogFoodResult =
  | { ok: false; problems: string[] }
  | { ok: true; log: FoodLog; day: DayTotals; warnings: string[] };

function mealByHour(time: string): Meal {
  const h = Number(time.slice(0, 2));
  return h < 11 ? "desayuno" : h < 16 ? "comida" : h < 20 ? "snack" : "cena";
}

async function insertLogTx(tx: Tx, userId: string, v: {
  date: string; meal: Meal; foodId: string | null; description: string | null; grams: number | null; m: Macros; estimated: boolean; source: FoodLog["source"];
}): Promise<FoodLogRow> {
  const rows = await tx.query<FoodLogRow>(
    `insert into fit.food_logs (user_id, date, meal, food_id, description, grams, kcal, protein_g, carbs_g, fat_g, estimated, source)
     values ($1::uuid, $2::date, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
    [userId, v.date, v.meal, v.foodId, v.description, v.grams, r1(v.m.kcal), r1(v.m.proteinG), r1(v.m.carbsG), r1(v.m.fatG), v.estimated, v.source],
  );
  return rows[0];
}

const foodMacros = (f: Food, g: number): Macros => {
  const s = scaleMacros(per100(f), g);
  return { kcal: s.kcal, proteinG: s.protein, carbsG: s.carbs, fatG: s.fat };
};

/**
 * Anota comida. Con alimento (id o código) + gramos calcula los macros; con macros directos los guarda como estimados;
 * con solo una descripción no escribe nada y pide gramos o macros: no se inventan calorías.
 */
export async function logFood(userId: string, input: LogFoodInput, db?: Db, fetchImpl?: FetchLike): Promise<LogFoodResult> {
  const i = parseInput(LogFoodInput, input);
  const hasDirect = i.kcal != null || (i.proteinG != null && i.carbsG != null && i.fatG != null);

  let scanned: Food | null = null;
  if (!i.foodId && i.barcode) {
    const found = await lookupBarcode(userId, { barcode: i.barcode }, db, fetchImpl);
    if (!found.food) return { ok: false, problems: [found.reason] };
    scanned = found.food;
  }

  return withUser(userId, async (tx): Promise<LogFoodResult> => {
    let food = scanned;
    if (i.foodId) {
      const rows = await tx.query<FoodRow>("select * from fit.foods where id = $1::uuid", [i.foodId]);
      if (!rows[0]) throw notFound("El alimento");
      food = toFood(rows[0]);
    }
    const problems: string[] = [];
    const warnings: string[] = [];
    let m: Macros;
    let estimated = false;
    if (food && i.grams != null) {
      m = foodMacros(food, i.grams);
    } else if (hasDirect) {
      const p = i.proteinG ?? 0, c = i.carbsG ?? 0, f = i.fatG ?? 0;
      m = { kcal: i.kcal ?? p * 4 + c * 4 + f * 9, proteinG: p, carbsG: c, fatG: f };
      estimated = true;
      const none = [i.proteinG == null && "proteína", i.carbsG == null && "hidratos", i.fatG == null && "grasa"].filter(Boolean);
      if (none.length) warnings.push(`Sin ${none.join(", ")}: cuenta como 0 g.`);
    } else {
      if (food) problems.push(`Faltan los gramos de «${food.name}».${food.servingG ? ` Una ración son ${es(food.servingG)} g.` : ""}`);
      else if (i.description) problems.push("Con la descripción sola no se anota: dime los gramos de un alimento del catálogo o las kcal y los macros. No se inventan calorías.");
      else problems.push("Falta qué has comido: un alimento con sus gramos, o las kcal y los macros.");
      return { ok: false, problems };
    }

    const a = await athleteRow(tx);
    const today = todayIn(a.timezone);
    const date = i.date ?? today;
    const meal = i.meal ?? (i.date && i.date !== today ? "comida" : mealByHour(localTimeIn(a.timezone, new Date())));
    const row = await insertLogTx(tx, userId, {
      date, meal, foodId: food?.id ?? null, description: i.description ?? food?.name ?? null, grams: i.grams ?? null, m, estimated,
      source: i.source ?? (scanned ? "barcode" : "app"),
    });
    return { ok: true, log: toLog(row, food?.name ?? null), day: await dayTotalsTx(tx, date, today), warnings };
  }, db);
}

export const UpdateFoodLogInput = z.object({
  logId: Id.describe("Id del apunte de comida."),
  date: IsoDate.optional().describe("Mueve el apunte a otro día."),
  meal: z.enum(MEALS).optional().describe("Cambia la comida."),
  description: z.string().trim().max(300).optional().describe("Cambia el texto."),
  grams: grams.optional().describe("Nuevos gramos: los macros se recalculan con el alimento (o en proporción si no lo hay)."),
  kcal: z.number().min(0).max(10_000).optional().describe("Calorías a mano (marca el apunte como estimado)."),
  proteinG: macroG.optional().describe("Proteína a mano."),
  carbsG: macroG.optional().describe("Hidratos a mano."),
  fatG: macroG.optional().describe("Grasa a mano."),
});
export type UpdateFoodLogInput = z.input<typeof UpdateFoodLogInput>;

export type FoodLogResult = { log: FoodLog; day: DayTotals };

export async function updateFoodLog(userId: string, input: UpdateFoodLogInput, db?: Db): Promise<FoodLogResult> {
  const i = parseInput(UpdateFoodLogInput, input);
  return withUser(userId, async (tx) => {
    const cur = (await tx.query<FoodLogRow>("select * from fit.food_logs where id = $1::uuid", [i.logId]))[0];
    if (!cur) throw notFound("El apunte de comida");
    let m: Macros = { kcal: cur.kcal, proteinG: cur.protein_g, carbsG: cur.carbs_g, fatG: cur.fat_g };
    let estimated = cur.estimated;
    let foodName: string | null = null;
    if (cur.food_id) {
      const f = (await tx.query<FoodRow>("select * from fit.foods where id = $1::uuid", [cur.food_id]))[0];
      if (f) {
        foodName = f.name;
        if (i.grams != null) { m = foodMacros(toFood(f), i.grams); estimated = false; }
      }
    }
    if (i.grams != null && !foodName && cur.grams && cur.grams > 0) {
      const k = i.grams / cur.grams;
      m = { kcal: m.kcal * k, proteinG: m.proteinG * k, carbsG: m.carbsG * k, fatG: m.fatG * k };
    }
    if (i.kcal != null || i.proteinG != null || i.carbsG != null || i.fatG != null) {
      m = { kcal: i.kcal ?? m.kcal, proteinG: i.proteinG ?? m.proteinG, carbsG: i.carbsG ?? m.carbsG, fatG: i.fatG ?? m.fatG };
      estimated = true;
    }
    const rows = await tx.query<FoodLogRow>(
      `update fit.food_logs set date = $2::date, meal = $3, description = $4, grams = $5, kcal = $6, protein_g = $7, carbs_g = $8, fat_g = $9, estimated = $10
        where id = $1::uuid returning *`,
      [cur.id, i.date ?? cur.date, i.meal ?? cur.meal, i.description ?? cur.description, i.grams ?? cur.grams, r1(m.kcal), r1(m.proteinG), r1(m.carbsG), r1(m.fatG), estimated],
    );
    const today = todayIn((await athleteRow(tx)).timezone);
    return { log: toLog(rows[0], foodName), day: await dayTotalsTx(tx, rows[0].date, today) };
  }, db);
}

export const DeleteFoodLogInput = z.object({
  logId: Id.describe("Id del apunte de comida que se borra."),
});
export type DeleteFoodLogInput = z.input<typeof DeleteFoodLogInput>;

export async function deleteFoodLog(userId: string, input: DeleteFoodLogInput, db?: Db): Promise<{ deleted: true; day: DayTotals }> {
  const i = parseInput(DeleteFoodLogInput, input);
  return withUser(userId, async (tx) => {
    const rows = await tx.query<{ date: string }>("delete from fit.food_logs where id = $1::uuid returning date", [i.logId]);
    if (!rows[0]) throw notFound("El apunte de comida");
    const today = todayIn((await athleteRow(tx)).timezone);
    return { deleted: true as const, day: await dayTotalsTx(tx, rows[0].date, today) };
  }, db);
}

export const RepeatMealInput = z.object({
  fromDate: IsoDate.describe("Día del que se copia (AAAA-MM-DD)."),
  meal: z.enum(MEALS).describe("Comida que se repite: desayuno, comida, cena, pre, intra, post o snack."),
  toDate: IsoDate.optional().describe("Día en el que se anota. Por defecto, hoy."),
});
export type RepeatMealInput = z.input<typeof RepeatMealInput>;

export type RepeatMealResult = { ok: false; problems: string[] } | { ok: true; copied: number; logs: FoodLog[]; day: DayTotals };

export async function repeatMeal(userId: string, input: RepeatMealInput, db?: Db): Promise<RepeatMealResult> {
  const i = parseInput(RepeatMealInput, input);
  return withUser(userId, async (tx): Promise<RepeatMealResult> => {
    const today = todayIn((await athleteRow(tx)).timezone);
    const toDate = i.toDate ?? today;
    const rows = await tx.query<FoodLogRow>(
      `insert into fit.food_logs (user_id, date, meal, food_id, description, grams, kcal, protein_g, carbs_g, fat_g, estimated, source)
       select $1::uuid, $3::date, meal, food_id, description, grams, kcal, protein_g, carbs_g, fat_g, estimated, 'app'
         from fit.food_logs where date = $2::date and meal = $4 order by logged_at, id
       returning *`,
      [userId, i.fromDate, toDate, i.meal],
    );
    if (!rows.length) return { ok: false, problems: [`No hay nada anotado en «${i.meal}» el ${i.fromDate}.`] };
    return { ok: true, copied: rows.length, logs: rows.map((r) => toLog(r)), day: await dayTotalsTx(tx, toDate, today) };
  }, db);
}

/* -------------------------------- Comidas ancla -------------------------------- */

export type MealTemplate = {
  id: string;
  name: string;
  meal: Meal;
  dayType: DayType | null;
  items: { foodId: string; grams: number; name: string | null }[];
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  /** null si algún alimento no tiene precio vigente. */
  costEur: number | null;
};

type TemplateRow = {
  id: string; name: string; meal: Meal; day_type: DayType | null; items: { food_id: string; grams: number }[];
  kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; cost_eur: number | null;
};

async function foodsByIdTx(tx: Tx, ids: string[]): Promise<Map<string, Food>> {
  if (!ids.length) return new Map();
  const rows = await tx.query<FoodRow>("select * from fit.foods where id = any($1::uuid[])", [[...new Set(ids)]]);
  return new Map(rows.map((r) => [r.id, toFood(r)]));
}

const toTemplate = (r: TemplateRow, foods: Map<string, Food>): MealTemplate => ({
  id: r.id, name: r.name, meal: r.meal, dayType: r.day_type,
  items: (r.items ?? []).map((it) => ({ foodId: it.food_id, grams: it.grams, name: foods.get(it.food_id)?.name ?? null })),
  kcal: r.kcal, proteinG: r.protein_g, carbsG: r.carbs_g, fatG: r.fat_g, costEur: r.cost_eur,
});

export const SaveMealTemplateInput = z.object({
  id: Id.optional().describe("Id de la comida ancla si se está editando; sin él se crea una nueva."),
  name: z.string().trim().min(1).max(120).describe("Nombre de la comida ancla («Desayuno de siempre»)."),
  meal: z.enum(MEALS).optional().describe("A qué comida corresponde. Por defecto, comida."),
  dayType: z.enum(DAY_TYPES).optional().describe("Si solo vale para días On u Off. Sin él, vale para cualquiera."),
  items: z.array(z.object({
    foodId: Id.describe("Id del alimento."),
    grams: grams.describe("Gramos de ese alimento."),
  })).min(1).max(30).describe("Alimentos de la comida con sus gramos."),
});
export type SaveMealTemplateInput = z.input<typeof SaveMealTemplateInput>;

export async function saveMealTemplate(userId: string, input: SaveMealTemplateInput, db?: Db): Promise<MealTemplate> {
  const i = parseInput(SaveMealTemplateInput, input);
  return withUser(userId, async (tx) => {
    const a = await athleteRow(tx);
    const today = todayIn(a.timezone);
    const foods = await foodsByIdTx(tx, i.items.map((x) => x.foodId));
    const lost = i.items.find((x) => !foods.has(x.foodId));
    if (lost) throw notFound("Uno de los alimentos de la comida");
    const total = i.items.reduce((s, it) => addMacros(s, foodMacros(foods.get(it.foodId)!, it.grams)), ZERO);
    const priced = i.items.every((it) => hasFreshPrice(foods.get(it.foodId)!, today));
    const cost = priced ? Math.round(i.items.reduce((s, it) => s + (it.grams / 1000) * foods.get(it.foodId)!.pricePerKg!, 0) * 100) / 100 : null;
    const params = [i.name, i.meal ?? "comida", i.dayType ?? null, JSON.stringify(i.items.map((it) => ({ food_id: it.foodId, grams: it.grams }))), total.kcal, total.proteinG, total.carbsG, total.fatG, cost];
    const rows = i.id
      ? await tx.query<TemplateRow>(
          `update fit.meal_templates set name = $2, meal = $3, day_type = $4, items = $5::jsonb, kcal = $6, protein_g = $7, carbs_g = $8, fat_g = $9, cost_eur = $10
            where id = $1::uuid returning *`, [i.id, ...params])
      : await tx.query<TemplateRow>(
          `insert into fit.meal_templates (user_id, name, meal, day_type, items, kcal, protein_g, carbs_g, fat_g, cost_eur)
           values ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10) returning *`, [userId, ...params]);
    if (!rows[0]) throw notFound("La comida ancla");
    return toTemplate(rows[0], foods);
  }, db);
}

export const ListMealTemplatesInput = z.object({
  dayType: z.enum(DAY_TYPES).optional().describe("Solo las que valen para ese tipo de día (incluye las que valen para cualquiera)."),
});
export type ListMealTemplatesInput = z.input<typeof ListMealTemplatesInput>;

async function listTemplatesTx(tx: Tx, dayType?: DayType): Promise<{ rows: TemplateRow[]; foods: Map<string, Food> }> {
  const rows = await tx.query<TemplateRow>(
    "select * from fit.meal_templates where ($1::text is null or day_type is null or day_type = $1) order by meal, name", [dayType ?? null]);
  return { rows, foods: await foodsByIdTx(tx, rows.flatMap((r) => (r.items ?? []).map((it) => it.food_id))) };
}

export async function listMealTemplates(userId: string, input: ListMealTemplatesInput = {}, db?: Db): Promise<MealTemplate[]> {
  const i = parseInput(ListMealTemplatesInput, input);
  return withUser(userId, async (tx) => {
    const { rows, foods } = await listTemplatesTx(tx, i.dayType);
    return rows.map((r) => toTemplate(r, foods));
  }, db);
}

export const LogMealTemplateInput = z.object({
  templateId: Id.describe("Id de la comida ancla."),
  date: IsoDate.optional().describe("Día en el que se anota. Por defecto, hoy."),
  meal: z.enum(MEALS).optional().describe("Comida en la que se anota. Por defecto, la de la plantilla."),
});
export type LogMealTemplateInput = z.input<typeof LogMealTemplateInput>;

export type LogMealTemplateResult = { logs: FoodLog[]; day: DayTotals; warnings: string[] };

/** Anota de un toque todos los alimentos de una comida ancla, con los macros actuales de cada alimento. */
export async function logMealTemplate(userId: string, input: LogMealTemplateInput, db?: Db): Promise<LogMealTemplateResult> {
  const i = parseInput(LogMealTemplateInput, input);
  return withUser(userId, async (tx) => {
    const t = (await tx.query<TemplateRow>("select * from fit.meal_templates where id = $1::uuid", [i.templateId]))[0];
    if (!t) throw notFound("La comida ancla");
    const today = todayIn((await athleteRow(tx)).timezone);
    const date = i.date ?? today;
    const foods = await foodsByIdTx(tx, (t.items ?? []).map((it) => it.food_id));
    const logs: FoodLog[] = [];
    const warnings: string[] = [];
    for (const it of t.items ?? []) {
      const f = foods.get(it.food_id);
      if (!f) { warnings.push("Un alimento de la plantilla ya no existe: no se ha anotado."); continue; }
      const row = await insertLogTx(tx, userId, {
        date, meal: i.meal ?? t.meal, foodId: f.id, description: f.name, grams: it.grams, m: foodMacros(f, it.grams), estimated: false, source: "plantilla",
      });
      logs.push(toLog(row, f.name));
    }
    return { logs, day: await dayTotalsTx(tx, date, today), warnings };
  }, db);
}

/* ---------------------------------- Cafeína ---------------------------------- */

export const LogCaffeineInput = z.object({
  mg: z.number().int().min(1).max(1000).describe("Miligramos de cafeína (un café ≈ 80-100 mg)."),
  at: IsoDateTime.optional().describe("Cuándo se tomó (ISO 8601). Por defecto, ahora."),
  source: z.string().trim().max(60).optional().describe("De qué viene: café, pre-entreno, bebida energética…"),
});
export type LogCaffeineInput = z.input<typeof LogCaffeineInput>;

export type LogCaffeineResult = {
  log: { id: string; takenAt: string; mg: number; source: string | null; afterCutoff: boolean };
  caffeine: CaffeineStatus;
  warnings: string[];
};

/** Registra cafeína. Marca `after_cutoff` si cae después del corte (9 h antes de acostarse) y avisa. */
export async function logCaffeine(userId: string, input: LogCaffeineInput, db?: Db): Promise<LogCaffeineResult> {
  const i = parseInput(LogCaffeineInput, input);
  return withUser(userId, async (tx) => {
    const a = await athleteRow(tx);
    const at = i.at ? new Date(i.at) : new Date();
    const cutoff = a.bedtime ? caffeineCutoff(a.bedtime.slice(0, 5)) : null;
    const after = cutoff ? isAfterCutoff(localTimeIn(a.timezone, at), cutoff, a.wake_time ? a.wake_time.slice(0, 5) : null) : false;
    const row = (await tx.query<{ id: string; taken_at: Date | string; mg: number; source: string | null; after_cutoff: boolean }>(
      "insert into fit.caffeine_logs (user_id, taken_at, mg, source, after_cutoff) values ($1::uuid, $2::timestamptz, $3, $4, $5) returning *",
      [userId, at.toISOString(), i.mg, i.source || null, after],
    ))[0];
    const caffeine = await caffeineStatusTx(tx, a, todayIn(a.timezone, at));
    const warnings: string[] = [];
    if (after) warnings.push(`Pasas del corte de cafeína (${cutoff}): tan tarde puede quitarte sueño.`);
    if (!cutoff) warnings.push("Sin hora de acostarte en tu ficha no se puede calcular el corte de cafeína.");
    if (caffeine.maxMg != null && caffeine.todayMg > caffeine.maxMg) warnings.push(`Llevas ${caffeine.todayMg} mg hoy; la referencia para tu peso son ${caffeine.maxMg} mg.`);
    return { log: { id: row.id, takenAt: toIso(row.taken_at)!, mg: row.mg, source: row.source, afterCutoff: row.after_cutoff }, caffeine, warnings };
  }, db);
}

/* ------------------------------ Lista de la compra ------------------------------ */

export const BuildShoppingListInput = z.object({
  weekStart: IsoDate.optional().describe("Lunes de la semana (o cualquier día de ella). Por defecto, la semana actual."),
  store: z.enum(FOOD_STORES).optional().describe("Tienda en la que se compra. Sin ella, las tiendas de tu ficha."),
  budgetEur: z.number().min(0).max(10_000).optional().describe("Presupuesto de la semana en euros. Por defecto, el de tu ficha."),
});
export type BuildShoppingListInput = z.input<typeof BuildShoppingListInput>;

export type ShoppingLine = { foodId: string; name: string; category: string | null; grams: number; packs: number | null; costEur: number | null };

export type BuildShoppingListResult =
  | { ok: false; problems: string[] }
  | {
      ok: true;
      id: string;
      weekStart: string;
      store: string | null;
      mode: "comidas_ancla" | "cesta_base";
      days: { on: number; off: number; fromPlan: boolean };
      lines: ShoppingLine[];
      /** Suma de las líneas con precio vigente; null si ninguna lo tiene. */
      totalEur: number | null;
      budgetEur: number | null;
      overBudget: boolean;
      /** Alimentos de la lista sin precio fechado en los últimos 60 días: su importe no se inventa. */
      missingPrices: string[];
      perDay: { kcal: number; proteinG: number; targetKcal: number; targetProteinG: number };
      notes: string[];
    };

const BASKET_CATEGORIES = ["proteina", "hidrato", "grasa", "verdura", "fruta"] as const;
const VEG_G_PER_DAY = 300;
const FRUIT_G_PER_DAY = 200;

/**
 * Lista de la compra de la semana. Con comidas ancla, sale de ellas; sin ellas, una cesta base por categorías
 * eligiendo por gramos de proteína por euro entre lo que tiene precio vigente. Sin precios fechados lo dice y no pone importes.
 */
export async function buildShoppingList(userId: string, input: BuildShoppingListInput = {}, db?: Db): Promise<BuildShoppingListResult> {
  const i = parseInput(BuildShoppingListInput, input);
  return withUser(userId, async (tx): Promise<BuildShoppingListResult> => {
    const a = await athleteRow(tx);
    const today = todayIn(a.timezone);
    const ws = mondayOf(i.weekStart ?? today);
    const target = await currentTargetTx(tx, addDays(ws, 6));
    if (!target) return { ok: false, problems: ["Aún no hay objetivos de nutrición: calcúlalos antes de pedir la lista."] };

    const planOn = plannedOnDays(await planInfoTx(tx, today));
    const nOn = planOn ?? 5;
    const nOff = 7 - nOn;
    const weekly: Macros = {
      kcal: target.on.kcal * nOn + target.off.kcal * nOff, proteinG: target.on.proteinG * nOn + target.off.proteinG * nOff,
      carbsG: target.on.carbsG * nOn + target.off.carbsG * nOff, fatG: target.on.fatG * nOn + target.off.fatG * nOff,
    };
    const budget = i.budgetEur ?? a.weekly_food_budget_eur ?? null;
    const notes: string[] = [];
    const need = new Map<string, { food: Food; grams: number }>();
    const addNeed = (food: Food, g: number) => { if (g > 0) need.set(food.id, { food, grams: (need.get(food.id)?.grams ?? 0) + g }); };

    const { rows: templates, foods: tFoods } = await listTemplatesTx(tx);
    const mode: "comidas_ancla" | "cesta_base" = templates.length ? "comidas_ancla" : "cesta_base";
    if (templates.length) {
      for (const t of templates) {
        const times = t.day_type === "on" ? nOn : t.day_type === "off" ? nOff : 7;
        for (const it of t.items ?? []) {
          const f = tFoods.get(it.food_id);
          if (f) addNeed(f, it.grams * times);
        }
      }
      notes.push(`Sale de tus ${templates.length} comidas ancla: las de día On × ${nOn}, las de día Off × ${nOff} y el resto × 7.`);
    } else {
      const stores = i.store ? [i.store] : a.stores;
      const rows = await tx.query<FoodRow>(
        "select * from fit.foods where category = any($1::text[]) and store = any($2::text[])", [[...BASKET_CATEGORIES], stores]);
      const catalog = preferOwn(rows.map(toFood));
      // Primero lo que tiene precio vigente, por proteína por euro; después lo demás, por proteína por 100 g.
      const pick = (category: string, n: number): Food[] =>
        catalog.filter((f) => f.category === category).map((f) => ({
          f, fresh: hasFreshPrice(f, today), ppe: hasFreshPrice(f, today) ? (proteinPerEuro(per100(f), f.pricePerKg!) ?? 0) : 0,
        })).sort((x, y) => Number(y.fresh) - Number(x.fresh) || y.ppe - x.ppe || y.f.protein100 - x.f.protein100 || x.f.name.localeCompare(y.f.name))
          .slice(0, n).map((x) => x.f);
      const covered = (): Macros => [...need.values()].reduce((s, x) => addMacros(s, foodMacros(x.food, x.grams)), ZERO);
      const split = (foods: Food[], total: number, per: (f: Food) => number) => {
        for (const f of foods) if (per(f) > 0) addNeed(f, total / foods.length / (per(f) / 100));
      };
      for (const f of pick("verdura", 2)) addNeed(f, (VEG_G_PER_DAY * 7) / Math.min(2, catalog.filter((x) => x.category === "verdura").length));
      for (const f of pick("fruta", 2)) addNeed(f, (FRUIT_G_PER_DAY * 7) / Math.min(2, catalog.filter((x) => x.category === "fruta").length));
      split(pick("proteina", 2), Math.max(0, weekly.proteinG * 0.75 - covered().proteinG), (f) => f.protein100);
      split(pick("grasa", 1), Math.max(0, weekly.fatG - covered().fatG) * 0.6, (f) => f.fat100);
      split(pick("hidrato", 2), Math.max(0, weekly.carbsG - covered().carbsG), (f) => f.carbs100);
      const empty = BASKET_CATEGORIES.filter((c) => !catalog.some((f) => f.category === c));
      if (!need.size) return { ok: false, problems: [`No hay alimentos con categoría en el catálogo de ${stores.join(" o ")}: no se puede proponer una cesta.`] };
      notes.push("Cesta base: aún no tienes comidas ancla. Proteína para cubrir el 75 % del objetivo, hidratos y grasa para el resto, 300 g de verdura y 200 g de fruta al día.");
      if (empty.length) notes.push(`Sin alimentos de ${empty.join(", ")} en el catálogo de esa tienda: esa parte queda fuera.`);
    }

    const missingPrices: string[] = [];
    const lines: ShoppingLine[] = [...need.values()].map(({ food, grams: g }) => {
      const packs = food.packageG && food.packageG > 0 ? Math.max(1, Math.ceil(g / food.packageG - 1e-9)) : null;
      const fresh = hasFreshPrice(food, today);
      if (!fresh) missingPrices.push(food.name);
      const cost = !fresh ? null : packs != null && food.priceEur != null ? packs * food.priceEur : (g / 1000) * food.pricePerKg!;
      return { foodId: food.id, name: food.name, category: food.category, grams: r0(g), packs, costEur: cost == null ? null : Math.round(cost * 100) / 100 };
    }).sort((x, y) => (x.category ?? "").localeCompare(y.category ?? "") || x.name.localeCompare(y.name));
    const pricedLines = lines.filter((l) => l.costEur != null);
    const totalEur = pricedLines.length ? Math.round(pricedLines.reduce((s, l) => s + l.costEur!, 0) * 100) / 100 : null;
    if (missingPrices.length === lines.length) notes.push("Ningún alimento de la lista tiene precio fechado en los últimos 60 días: no hay importes. Apunta los precios al comprar.");
    else if (missingPrices.length) notes.push(`Sin precio vigente: ${missingPrices.join(", ")}. El total solo suma lo que tiene precio.`);
    const overBudget = budget != null && totalEur != null && totalEur > budget;
    if (overBudget) notes.push(`La lista se pasa del presupuesto en ${es(Math.round((totalEur! - budget!) * 100) / 100)} €.`);
    const got = [...need.values()].reduce((s, x) => addMacros(s, foodMacros(x.food, x.grams)), ZERO);

    await tx.query("delete from fit.shopping_lists where week_start = $1::date and store is not distinct from $2::text", [ws, i.store ?? null]);
    const saved = await tx.query<{ id: string }>(
      "insert into fit.shopping_lists (user_id, week_start, store, budget_eur, total_eur, items) values ($1::uuid, $2::date, $3, $4, $5, $6::jsonb) returning id",
      [userId, ws, i.store ?? null, budget, totalEur, JSON.stringify(lines.map((l) => ({ food_id: l.foodId, name: l.name, grams: l.grams, packs: l.packs, cost_eur: l.costEur, done: false })))],
    );
    return {
      ok: true, id: saved[0].id, weekStart: ws, store: i.store ?? null, mode, days: { on: nOn, off: nOff, fromPlan: planOn != null }, lines, totalEur,
      budgetEur: budget, overBudget, missingPrices,
      perDay: { kcal: r0(got.kcal / 7), proteinG: r0(got.proteinG / 7), targetKcal: r0(weekly.kcal / 7), targetProteinG: r0(weekly.proteinG / 7) },
      notes,
    };
  }, db);
}

/* ------------------------------- Revisión semanal ------------------------------- */

export const WeeklyNutritionReviewInput = z.object({
  weekStart: IsoDate.optional().describe("Lunes de la semana a revisar (o cualquier día de ella). Por defecto, la semana de ayer."),
});
export type WeeklyNutritionReviewInput = z.input<typeof WeeklyNutritionReviewInput>;

export type WeeklyNutritionReview = {
  weekStart: string;
  weekEnd: string;
  action: WeeklyAction;
  why: string;
  /** Cambio de calorías que se propone. Nunca se aplica solo. */
  proposal: { onKcal: number; offKcal: number; note: string; applied: false } | null;
  data: {
    phase: NutritionPhase | null;
    weightAvgKg: number | null;
    weighIns: number;
    ratePct: number | null;
    targetPct: number;
    waistCm: number | null;
    waistDeltaCm: number | null;
    adherencePct: number | null;
    adherentDays: number;
    daysCounted: number;
    stepsAvg: number | null;
    stepsGoal: number;
    readinessAvg: number | null;
    performance: "sube" | "igual" | "baja";
    performancePct: number | null;
    exercisesCompared: number;
    sessionsDone: number;
    sessionsPlanned: number | null;
    engineDecision: { action: WeeklyAction; why: string };
  };
};

/** Junta peso, cintura, adherencia, pasos, readiness y rendimiento de la semana y propone qué hacer. No cambia los objetivos. */
export async function weeklyNutritionReview(userId: string, input: WeeklyNutritionReviewInput = {}, db?: Db): Promise<WeeklyNutritionReview> {
  const i = parseInput(WeeklyNutritionReviewInput, input);
  return withUser(userId, async (tx) => {
    const a = await athleteRow(tx);
    const today = todayIn(a.timezone);
    const ws = mondayOf(i.weekStart ?? addDays(today, -1));
    const we = addDays(ws, 6);

    const weights = await tx.query<{ date: string; kg: number }>(
      "select date, weight_kg as kg from fit.body_metrics where weight_kg is not null and date <= $1::date and date >= $1::date - 60 order by date", [we]);
    const inWeek = weights.filter((w) => w.date >= ws);
    const ratePct = weeklyRatePct(weights, 14);
    const weightAvgKg = inWeek.length ? Math.round((inWeek.reduce((s, w) => s + w.kg, 0) / inWeek.length) * 100) / 100 : null;

    const waist = (await tx.query<{ now: number | null; before: number | null }>(
      `select
         (select waist_cm from fit.body_metrics where waist_cm is not null and date between $1::date and $2::date order by date desc limit 1) as now,
         (select waist_cm from fit.body_metrics where waist_cm is not null and date < $1::date and date >= $1::date - 21 order by date desc limit 1) as before`,
      [ws, we],
    ))[0];
    const waistDeltaCm = waist.now != null && waist.before != null ? r1(waist.now - waist.before) : null;

    // Adherencia: días dentro de ±10 % de kcal y con al menos el 90 % de la proteína. Un día sin anotar no cuenta como cumplido.
    const targets = (await tx.query<TargetRow>("select * from fit.nutrition_targets where valid_from <= $1::date order by valid_from desc", [we])).map(toTarget);
    const target = targets[0] ?? null;
    const eaten = new Map((await tx.query<{ date: string; kcal: number; protein: number }>(
      "select date, sum(kcal) as kcal, sum(protein_g) as protein from fit.food_logs where date between $1::date and $2::date group by date", [ws, we])).map((r) => [r.date, r]));
    const forced = new Map((await tx.query<{ date: string; day_type: DayType }>(
      "select date, day_type from fit.nutrition_days where forced and date between $1::date and $2::date", [ws, we])).map((r) => [r.date, r.day_type]));
    const trained = new Set((await tx.query<{ date: string }>(
      `select distinct w.date from fit.workouts w left join fit.session_templates st on st.id = w.session_template_id
        where w.date between $1::date and $2::date and w.status in ('hecha', 'en_curso')
          and coalesce(st.is_cardio, false) = false and coalesce(st.is_rest, false) = false`, [ws, we])).map((r) => r.date));
    let adherentDays = 0;
    let daysCounted = 0;
    for (let d = ws; d <= we && d <= today; d = addDays(d, 1)) {
      const t = targets.find((x) => x.validFrom <= d);
      if (!t) continue;
      daysCounted++;
      const goal = t[forced.get(d) ?? (trained.has(d) ? "on" : "off")];
      const e = eaten.get(d);
      if (e && Math.abs(e.kcal - goal.kcal) <= goal.kcal * 0.1 && e.protein >= goal.proteinG * 0.9) adherentDays++;
    }
    const adherencePct = daysCounted ? r1((adherentDays / daysCounted) * 100) : null;

    const avgs = (await tx.query<{ steps: number | null; readiness: number | null; sessions: number }>(
      `select
         (select avg(steps)::float from fit.daily_activity where steps is not null and date between $1::date and $2::date) as steps,
         (select avg(readiness)::float from fit.checkins where readiness is not null and date between $1::date and $2::date) as readiness,
         (select count(*)::int from fit.workouts where status = 'hecha' and date between $1::date and $2::date) as sessions`,
      [ws, we],
    ))[0];

    // Rendimiento: e1RM medio por ejercicio, esta semana frente a la anterior, solo en los ejercicios que se repiten.
    const e1 = await tx.query<{ exercise_id: string; cur: boolean; e1rm: number }>(
      `select s.exercise_id, (w.date >= $2::date) as cur, avg(s.e1rm)::float as e1rm
         from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
        where w.date between $1::date and $3::date and w.status <> 'saltada' and s.e1rm is not null and s.exercise_id is not null and s.set_type <> 'aproximacion'
        group by s.exercise_id, (w.date >= $2::date)`,
      [addDays(ws, -7), ws, we],
    );
    const prevBy = new Map(e1.filter((r) => !r.cur).map((r) => [r.exercise_id, r.e1rm]));
    const changes = e1.filter((r) => r.cur && (prevBy.get(r.exercise_id) ?? 0) > 0).map((r) => (r.e1rm - prevBy.get(r.exercise_id)!) / prevBy.get(r.exercise_id)!);
    const performancePct = changes.length ? r1((changes.reduce((s, x) => s + x, 0) / changes.length) * 100) : null;
    const performance = performancePct == null ? "igual" : performancePct > 1 ? "sube" : performancePct < -1 ? "baja" : "igual";

    const lastKg = weights.length ? weights[weights.length - 1].kg : null;
    const targetPct = target ? target.ratePctWeek : lastKg != null && a.goal_weight_kg != null ? targetRatePct(lastKg, a.goal_weight_kg) : 0;
    const engineDecision = weeklyDecision({
      ratePct, targetPct, performance, waistDeltaCm, readinessAvg: avgs.readiness == null ? null : r1(avgs.readiness),
      adherencePct, stepsAvg: avgs.steps == null ? null : r0(avgs.steps), stepsGoal: a.steps_goal,
    });
    // En calibración no se tocan las calorías: se está midiendo el gasto.
    const decision = target?.phase === "calibracion" && engineDecision.action !== "arreglar_adherencia"
      ? { action: "mantener" as WeeklyAction, why: "Fase de calibración: se sigue a mantenimiento y anotando hasta poder medir tu gasto. No se toca nada." }
      : engineDecision;

    let proposal: WeeklyNutritionReview["proposal"] = null;
    if (target) {
      if (decision.action === "subir_kcal") proposal = { onKcal: r0(target.on.kcal * 1.05), offKcal: target.off.kcal, note: "Sube un 5 % los días On, en hidratos.", applied: false };
      if (decision.action === "bajar_kcal") proposal = { onKcal: target.on.kcal, offKcal: r0(target.off.kcal * 0.94), note: "Recorta un 6 % los días Off, de hidratos.", applied: false };
      if (decision.action === "semana_mantenimiento") proposal = { onKcal: r0(target.tdee * (target.on.kcal / target.avgKcal)), offKcal: r0(target.tdee * (target.off.kcal / target.avgKcal)), note: "Una semana comiendo lo que gastas.", applied: false };
    }

    const plan = await planInfoTx(tx, today);
    const data: WeeklyNutritionReview["data"] = {
      phase: target?.phase ?? null, weightAvgKg, weighIns: inWeek.length, ratePct, targetPct, waistCm: waist.now, waistDeltaCm, adherencePct, adherentDays, daysCounted,
      stepsAvg: avgs.steps == null ? null : r0(avgs.steps), stepsGoal: a.steps_goal, readinessAvg: avgs.readiness == null ? null : r1(avgs.readiness),
      performance, performancePct, exercisesCompared: changes.length, sessionsDone: avgs.sessions, sessionsPlanned: plannedOnDays(plan), engineDecision,
    };
    await tx.query(
      `insert into fit.weekly_reviews as r (user_id, week_start, weight_avg_kg, weight_rate_pct, waist_cm, adherence_pct, sessions_done, sessions_planned, action, why, data)
       values ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       on conflict (user_id, week_start) do update set weight_avg_kg = excluded.weight_avg_kg, weight_rate_pct = excluded.weight_rate_pct, waist_cm = excluded.waist_cm,
         adherence_pct = excluded.adherence_pct, sessions_done = excluded.sessions_done, sessions_planned = coalesce(excluded.sessions_planned, r.sessions_planned),
         action = excluded.action, why = excluded.why, data = coalesce(r.data, '{}'::jsonb) || excluded.data`,
      [userId, ws, weightAvgKg, ratePct, waist.now, adherencePct, avgs.sessions, data.sessionsPlanned, decision.action, decision.why, JSON.stringify({ ...data, proposal })],
    );
    return { weekStart: ws, weekEnd: we, action: decision.action, why: decision.why, proposal, data };
  }, db);
}
