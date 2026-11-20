/**
 * Nutrición: composición estimada, gasto (Mifflin → TDEE medido), ritmo de pérdida,
 * objetivos no lineales On/Off con el total semanal fijo, decisión semanal y cafeína.
 */

export type Sex = "H" | "M";

/** Mifflin-St Jeor (kcal/día en reposo). */
export const mifflin = (kg: number, cm: number, age: number, sex: Sex) =>
  10 * kg + 6.25 * cm - 5 * age + (sex === "H" ? 5 : -161);

/** % graso por perímetros (US Navy, hombre). Error típico ±3-4 puntos. */
export function navyBodyFatMale(waistCm: number, neckCm: number, heightCm: number): number | null {
  if (waistCm - neckCm <= 0) return null;
  return 495 / (1.0324 - 0.19077 * Math.log10(waistCm - neckCm) + 0.15456 * Math.log10(heightCm)) - 450;
}

/** Masa grasa relativa (Woolcott 2018): solo cintura y altura. Respaldo cuando no hay cuello ni pliegues. */
export const relativeFatMass = (waistCm: number, heightCm: number, sex: Sex) =>
  (sex === "H" ? 64 : 76) - 20 * (heightCm / waistCm);

export const waistToHeight = (waistCm: number, heightCm: number) => waistCm / heightCm;

export function bodyComposition(i: { kg: number; heightCm: number; waistCm?: number | null; neckCm?: number | null; sex: Sex; measuredBfPct?: number | null }) {
  let bf: number | null = i.measuredBfPct ?? null;
  let method: "medido" | "navy" | "rfm" | "sin_dato" = bf != null ? "medido" : "sin_dato";
  if (bf == null && i.waistCm && i.neckCm && i.sex === "H") { bf = navyBodyFatMale(i.waistCm, i.neckCm, i.heightCm); if (bf != null) method = "navy"; }
  if (bf == null && i.waistCm) { bf = relativeFatMass(i.waistCm, i.heightCm, i.sex); method = "rfm"; }
  const bfPct = bf == null ? null : Math.round(Math.max(4, Math.min(60, bf)) * 10) / 10;
  return {
    bfPct,
    method,
    marginPts: method === "medido" ? 2 : method === "navy" ? 3.5 : method === "rfm" ? 5 : null,
    leanKg: bfPct == null ? null : Math.round(i.kg * (1 - bfPct / 100) * 10) / 10,
    waistToHeight: i.waistCm ? Math.round(waistToHeight(i.waistCm, i.heightCm) * 100) / 100 : null,
  };
}

/* ----------------------- Tendencia de peso ----------------------- */

/** Peso suavizado (EWMA, α = 0,1 por pesada). El dato diario baila ±1 kg por agua; la tendencia no. */
export function weightTrend(points: { date: string; kg: number }[]) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const trend: { date: string; kg: number; trend: number }[] = [];
  sorted.forEach((p, i) => trend.push({ ...p, trend: i === 0 ? p.kg : trend[i - 1].trend + 0.1 * (p.kg - trend[i - 1].trend) }));
  return trend;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);

/** Ritmo en % del peso por semana (negativo = bajando), con la tendencia de los últimos `days` días. */
export function weeklyRatePct(points: { date: string; kg: number }[], days = 14): number | null {
  const t = weightTrend(points);
  if (t.length < 4) return null;
  const end = t[t.length - 1];
  const start = t.find((p) => dayDiff(p.date, end.date) <= days) ?? t[0];
  const d = dayDiff(start.date, end.date);
  if (d < 6) return null;
  return Math.round((((end.trend - start.trend) / start.trend) * 100 * 7) / d * 100) / 100;
}

/** Gasto real: lo que comiste menos lo que cambió el peso (7.700 kcal por kg). Necesita ≥ 14 días. */
export function adaptiveTdee(i: { intakeAvgKcal: number; trendStartKg: number; trendEndKg: number; days: number }): number | null {
  if (i.days < 14) return null;
  return Math.round(i.intakeAvgKcal - ((i.trendEndKg - i.trendStartKg) * 7700) / i.days);
}

/* ----------------------------- Objetivos ----------------------------- */

/** Más rápido al principio, más conservador al final (Ibon + Helms 0,5-1 %). */
export const targetRatePct = (kg: number, goalKg: number) => (kg - goalKg > 4 ? 0.8 : kg > goalKg ? 0.5 : 0);

export type PlanInput = {
  kg: number;
  leanKg: number;
  tdee: number;
  ratePctWeek: number;
  trainDaysPerWeek: number;
  /** Diferencia On−Off como fracción de la media. 0,12 por defecto; <0,10 al salir de un déficit duro. */
  onOffSpread?: number;
  proteinPerLeanKg?: number;
  fatPerKg?: number;
  /** Suelo de calorías medias: 24 kcal por kg de peso (cuaderno del máster). 0 lo desactiva. */
  floorKcalPerKg?: number;
};

export type DayTarget = { kcal: number; proteinG: number; fatG: number; carbG: number; intraCarbG?: [number, number] };

export function planTargets(i: PlanInput) {
  const spread = i.onOffSpread ?? 0.12;
  const nOn = Math.max(0, Math.min(7, i.trainDaysPerWeek));
  const nOff = 7 - nOn;
  let deficit = (i.kg * (i.ratePctWeek / 100) * 7700) / 7;
  const capped = deficit > i.tdee * 0.25;
  if (capped) deficit = i.tdee * 0.25;
  const floor = (i.floorKcalPerKg ?? 24) * i.kg;
  const floored = floor > 0 && i.tdee - deficit < floor && i.tdee > floor;
  if (floored) deficit = i.tdee - floor;
  const avg = i.tdee - deficit;
  // On − Off = spread × media, con el total semanal intacto.
  const on = avg + (spread * avg * nOff) / 7;
  const off = avg - (spread * avg * nOn) / 7;
  const proteinG = Math.round(i.leanKg * (i.proteinPerLeanKg ?? 2.3));
  const fatG = Math.round(i.kg * (i.fatPerKg ?? 0.8));
  const day = (kcal: number): DayTarget => ({
    kcal: Math.round(kcal), proteinG, fatG, carbG: Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4)),
  });
  const onDay = day(on);
  onDay.intraCarbG = [Math.round(onDay.carbG * 0.05), Math.round(onDay.carbG * 0.1)];
  const offDay = day(off);
  return {
    avgKcal: Math.round(avg),
    deficitKcal: Math.round(deficit),
    deficitPct: Math.round((deficit / i.tdee) * 100),
    capped,
    floored,
    weeklyKcal: Math.round(on) * nOn + Math.round(off) * nOff,
    on: onDay,
    off: offDay,
    expectedKgPerWeek: Math.round(((deficit * 7) / 7700) * 100) / 100,
    warnings: [
      ...(capped ? ["El déficit pedido supera el 25 % del gasto: se recorta a ese tope."] : []),
      ...(floored ? ["No se baja de " + Math.round(floor) + " kcal de media (24 kcal por kg): para perder más rápido, sube actividad."] : []),
      ...(offDay.carbG < 100 ? ["Menos de 100 g de hidratos en día Off: antes de bajar más, sube pasos."] : []),
    ],
  };
}

export type WeeklyAction = "mantener" | "arreglar_adherencia" | "subir_pasos" | "bajar_kcal" | "subir_kcal" | "semana_mantenimiento";

/** Decisión semanal cruzando peso, rendimiento, cintura y recuperación. Nunca solo la báscula. */
export function weeklyDecision(i: {
  ratePct: number | null; targetPct: number; performance: "sube" | "igual" | "baja";
  waistDeltaCm: number | null; readinessAvg: number | null; adherencePct: number | null; stepsAvg: number | null; stepsGoal: number;
}): { action: WeeklyAction; why: string } {
  if (i.adherencePct != null && i.adherencePct < 80)
    return { action: "arreglar_adherencia", why: `Adherencia del ${Math.round(i.adherencePct)} %: con menos del 80 % no se puede juzgar el plan. No se toca nada.` };
  if (i.ratePct == null) return { action: "mantener", why: "Faltan pesadas para medir el ritmo (mínimo 4 en 7 días)." };
  const loss = -i.ratePct;
  if (i.performance === "baja" && i.readinessAvg != null && i.readinessAvg < 50)
    return { action: "semana_mantenimiento", why: "Cae el rendimiento y el readiness está por debajo de 50: una semana a mantenimiento." };
  if (loss > i.targetPct * 1.4 && i.performance !== "sube")
    return { action: "subir_kcal", why: `Bajas un ${loss.toFixed(2)} %/semana (objetivo ${i.targetPct} %): demasiado rápido. Sube un 5 % en días On.` };
  const waistMoving = i.waistDeltaCm != null && i.waistDeltaCm <= -0.3;
  if (loss < i.targetPct * 0.5 && !waistMoving) {
    if (i.stepsAvg != null && i.stepsAvg < i.stepsGoal)
      return { action: "subir_pasos", why: `Ritmo lento y media de ${Math.round(i.stepsAvg)} pasos: primero llega a ${i.stepsGoal}, sobre todo en días Off.` };
    return { action: "bajar_kcal", why: "Ritmo por debajo de la mitad del objetivo dos semanas, con pasos cumplidos y cintura quieta: recorta un 5-8 %, de hidratos y en días Off." };
  }
  return { action: "mantener", why: waistMoving && loss < i.targetPct * 0.5 ? "La báscula va lenta pero la cintura baja: se mantiene." : "En ritmo. No se toca." };
}

/** Regla del cuaderno para el ritmo máximo: % graso / 20 (% del peso por semana), con techo en 1 %. */
export const maxRateByBodyFat = (bfPct: number) => Math.round(Math.min(1, bfPct / 20) * 100) / 100;

/* ----------------------------- Cafeína ----------------------------- */

/** Última hora para cafeína: 9 h antes de acostarte (400 mg a 6 h ya alteran el sueño; Drake 2013). */
export function caffeineCutoff(bedtime: string, hoursBefore = 9): string {
  const [h, m] = bedtime.split(":").map(Number);
  const t = (((h * 60 + m - hoursBefore * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
export const caffeineMaxMg = (kg: number, mgPerKg = 3) => Math.round((kg * mgPerKg) / 5) * 5;

/* ---------------------- Comida: macros y precio ---------------------- */

export type Per100 = { kcal: number; protein: number; carbs: number; fat: number };
export const scaleMacros = (per100: Per100, grams: number): Per100 => ({
  kcal: Math.round((per100.kcal * grams) / 100),
  protein: Math.round(per100.protein * grams) / 100,
  carbs: Math.round(per100.carbs * grams) / 100,
  fat: Math.round(per100.fat * grams) / 100,
});
/** Gramos de proteína por euro: lo que ordena la lista de la compra con presupuesto. */
export const proteinPerEuro = (per100: Per100, pricePerKg: number) => (pricePerKg > 0 ? (per100.protein * 10) / pricePerKg : null);
/** kcal desde kJ cuando el producto no trae kcal (Open Food Facts). */
export const kcalFromKj = (kj: number) => kj / 4.184;
