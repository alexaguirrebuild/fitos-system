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

export type BfMethod = "medido" | "bia" | "navy" | "rfm" | "sin_dato";

/** Bioimpedancia (InBody, Tanita, báscula): error típico de ±3-5 puntos frente a DXA, así que no cuenta como «medido» fino. */
const BIA_RE = /^(bia|inbody|tanita|omron|bioimpedancia|bascula|báscula)/i;

/** Clasifica el método con el que se guardó un % graso medido (texto libre de la base). */
export const measuredBfMethod = (stored: string | null | undefined): "medido" | "bia" =>
  stored && BIA_RE.test(stored.trim()) ? "bia" : "medido";

/** Margen en puntos de % graso según el método. BIA ±4 (punto medio de ±3-5 frente a DXA). */
export const BF_MARGIN_PTS: Record<Exclude<BfMethod, "sin_dato">, number> = { medido: 2, bia: 4, navy: 3.5, rfm: 5 };

export function bodyComposition(i: {
  kg: number; heightCm: number; waistCm?: number | null; neckCm?: number | null; sex: Sex; measuredBfPct?: number | null;
  /** Método guardado con el % graso medido («inbody», «dexa»…). La bioimpedancia pasa a «bia», ±4 puntos. */
  measuredMethod?: string | null;
}) {
  let bf: number | null = i.measuredBfPct ?? null;
  let method: BfMethod = bf != null ? measuredBfMethod(i.measuredMethod) : "sin_dato";
  if (bf == null && i.waistCm && i.neckCm && i.sex === "H") { bf = navyBodyFatMale(i.waistCm, i.neckCm, i.heightCm); if (bf != null) method = "navy"; }
  if (bf == null && i.waistCm) { bf = relativeFatMass(i.waistCm, i.heightCm, i.sex); method = "rfm"; }
  const bfPct = bf == null ? null : Math.round(Math.max(4, Math.min(60, bf)) * 10) / 10;
  return {
    bfPct,
    method,
    marginPts: method === "sin_dato" ? null : BF_MARGIN_PTS[method],
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

/**
 * Ritmo pedido: 0,7 %/semana a más de 4 kg del objetivo, 0,5 % después.
 * A 0,7 % los atletas ganaron magra (+2,1 %); al 1,4 % la perdieron (Garthe 2011, PMID 21558571).
 */
export const targetRatePct = (kg: number, goalKg: number) => (kg - goalKg > 4 ? 0.7 : kg > goalKg ? 0.5 : 0);

/**
 * Recomposición: el déficit medio no pasa de 500 kcal (a partir de ahí desaparece la ganancia de magra; Murphy 2022, PMID 34623696).
 * Definición: manda el ritmo en % del peso. Son modos excluyentes: el motor no promedia entre los dos.
 */
export type DietMode = "recomposicion" | "definicion";
export const RECOMP_MAX_DEFICIT_KCAL = 500;
/** Comidas al día para repartir la proteína (reparto homogéneo; Mamerow 2014, PMID 24477298). */
export const DEFAULT_MEALS_PER_DAY = 4;
/** Suelo de kcal por kg de peso, por día. */
export const DEFAULT_FLOOR_KCAL_PER_KG = 24;

/**
 * Proteína por kg de masa magra, más alta cuanto más duro el déficit: 2,3 sin déficit y 3,1 con un 30 % o más
 * (Helms 2014, PMID 24092765; Hector 2015, PMID 25014731). k = 2,3 + 0,8 × min(1, déficit % / 30).
 */
export const proteinPerLeanKgFor = (deficitPct: number) =>
  Math.round((2.3 + 0.8 * Math.min(1, Math.max(0, deficitPct) / 30)) * 100) / 100;

/** % del peso por semana que da un déficit diario (7.700 kcal por kg). */
export const ratePctFromDeficit = (deficitKcal: number, kg: number) =>
  kg > 0 ? Math.round(((Math.max(0, deficitKcal) * 7) / 7700 / kg) * 100 * 100) / 100 : 0;

export type PlanInput = {
  kg: number;
  leanKg: number;
  tdee: number;
  /** Ritmo pedido en % del peso por semana. El que sale de verdad es `effectiveRatePct`. */
  ratePctWeek: number;
  trainDaysPerWeek: number;
  /** «definicion» por defecto. */
  mode?: DietMode;
  /** Diferencia On−Off como fracción de la media. 0,12 por defecto; <0,10 al salir de un déficit duro. */
  onOffSpread?: number;
  /** Fija los g de proteína por kg magro. Sin él, escalan con el déficit (`proteinPerLeanKgFor`). */
  proteinPerLeanKg?: number;
  fatPerKg?: number;
  /** Suelo por DÍA: ningún día (tampoco el Off) baja de 24 kcal por kg de peso (cuaderno del máster). 0 lo desactiva. */
  floorKcalPerKg?: number;
  mealsPerDay?: number;
};

export type DayTarget = { kcal: number; proteinG: number; fatG: number; carbG: number; intraCarbG?: [number, number] };

/** Qué recortó el déficit pedido: nada («tasa»), el techo de recomposición, el tope del 25 % del gasto o el suelo de kcal. */
export type DeficitLimit = "tasa" | "recomposicion" | "tope" | "suelo";

export function planTargets(i: PlanInput) {
  const mode: DietMode = i.mode ?? "definicion";
  const spread = i.onOffSpread ?? 0.12;
  const nOn = Math.max(0, Math.min(7, i.trainDaysPerWeek));
  const nOff = 7 - nOn;
  let deficit = (i.kg * (i.ratePctWeek / 100) * 7700) / 7;
  let limitedBy: DeficitLimit = "tasa";
  const recompCapped = mode === "recomposicion" && deficit > RECOMP_MAX_DEFICIT_KCAL;
  if (recompCapped) {
    deficit = RECOMP_MAX_DEFICIT_KCAL;
    limitedBy = "recomposicion";
  }
  const capped = deficit > i.tdee * 0.25;
  if (capped) { deficit = i.tdee * 0.25; limitedBy = "tope"; }
  const floor = (i.floorKcalPerKg ?? DEFAULT_FLOOR_KCAL_PER_KG) * i.kg;
  const floored = floor > 0 && i.tdee - deficit < floor && i.tdee > floor;
  if (floored) { deficit = i.tdee - floor; limitedBy = "suelo"; }
  deficit = Math.max(0, deficit);
  const avg = i.tdee - deficit;

  // On − Off = spread × media, con el total semanal intacto.
  let on = avg + (spread * avg * nOff) / 7;
  let off = avg - (spread * avg * nOn) / 7;
  // El suelo es por día: si el Off cae por debajo, el Off se queda en el suelo y el On absorbe el resto de la semana.
  const offRaised = floor > 0 && nOn > 0 && nOff > 0 && off < floor && avg >= floor;
  if (offRaised) {
    off = floor;
    on = (7 * avg - nOff * off) / nOn;
  }
  const spreadApplied = avg > 0 ? Math.round(((on - off) / avg) * 100) / 100 : 0;

  const deficitPctRaw = i.tdee > 0 ? (deficit / i.tdee) * 100 : 0;
  const proteinPerLeanKg = i.proteinPerLeanKg ?? proteinPerLeanKgFor(deficitPctRaw);
  const proteinG = Math.round(i.leanKg * proteinPerLeanKg);
  const mealsPerDay = Math.max(1, Math.round(i.mealsPerDay ?? DEFAULT_MEALS_PER_DAY));
  const fatG = Math.round(i.kg * (i.fatPerKg ?? 0.8));
  const day = (kcal: number): DayTarget => ({
    kcal: Math.round(kcal), proteinG, fatG, carbG: Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4)),
  });
  const onDay = day(on);
  onDay.intraCarbG = [Math.round(onDay.carbG * 0.05), Math.round(onDay.carbG * 0.1)];
  const offDay = day(off);
  const effectiveRatePct = ratePctFromDeficit(deficit, i.kg);
  const es = (n: number) => String(n).replace(".", ",");
  return {
    mode,
    avgKcal: Math.round(avg),
    deficitKcal: Math.round(deficit),
    deficitPct: Math.round(deficitPctRaw),
    /** Ritmo pedido (% del peso por semana). */
    requestedRatePct: i.ratePctWeek,
    /** Ritmo real tras el techo de recomposición, el tope del 25 % y el suelo. Es contra el que se juzga la semana. */
    effectiveRatePct,
    limitedBy,
    capped,
    floored,
    /** El suelo, en kcal, y a qué se aplica: a cada día, también al Off. */
    floorKcal: Math.round(floor),
    floorBasis: "dia" as const,
    offRaised,
    onOffSpreadApplied: spreadApplied,
    weeklyKcal: Math.round(on) * nOn + Math.round(off) * nOff,
    on: onDay,
    off: offDay,
    proteinPerLeanKg,
    mealsPerDay,
    proteinPerMealG: Math.round(proteinG / mealsPerDay),
    expectedKgPerWeek: Math.round(((deficit * 7) / 7700) * 100) / 100,
    warnings: [
      ...(recompCapped
        ? [`Modo recomposición: el déficit medio no pasa de ${RECOMP_MAX_DEFICIT_KCAL} kcal; por encima se pierde la ganancia de masa magra.`] : []),
      ...(capped ? ["El déficit pedido supera el 25 % del gasto: se recorta a ese tope."] : []),
      ...(floored
        ? [`Ningún día baja de ${Math.round(floor)} kcal (24 kcal por kg). Con ese suelo el ritmo real es ${es(effectiveRatePct)} %/semana, no el ${es(i.ratePctWeek)} % pedido: para ir más rápido, sube actividad.`]
        : []),
      ...(offRaised ? [`El día Off se queda en el suelo (${Math.round(floor)} kcal): el reparto On/Off baja a ±${Math.round(spreadApplied * 100)} %.`] : []),
      ...(mode === "definicion" && (capped || floored) && deficit > 0 && deficit <= RECOMP_MAX_DEFICIT_KCAL
        ? [`Con ${Math.round(deficit)} kcal de déficit efectivo estás en terreno de recomposición (≤ ${RECOMP_MAX_DEFICIT_KCAL}): conservas magra, pero pierdes más despacio de lo pedido.`]
        : []),
      ...(nOff > 0 && offDay.carbG < 100 ? ["Menos de 100 g de hidratos en día Off: antes de bajar más, sube pasos."] : []),
    ],
  };
}

export type PlanTargets = ReturnType<typeof planTargets>;

export type WeeklyAction = "mantener" | "arreglar_adherencia" | "subir_pasos" | "bajar_kcal" | "subir_kcal" | "semana_mantenimiento";

/** Semanas seguidas en déficit a partir de las que toca 1-2 semanas a mantenimiento (Byrne 2018, PMID 28925405). */
export const DIET_BREAK_WEEKS = 8;

/** Decisión semanal cruzando peso, rendimiento, cintura y recuperación. Nunca solo la báscula. */
export function weeklyDecision(i: {
  ratePct: number | null;
  /** Ritmo pedido (% del peso por semana). */
  targetPct: number;
  /** Ritmo que el plan puede dar de verdad tras tope y suelo. Si llega, la semana se juzga contra él y no contra el pedido. */
  effectivePct?: number | null;
  /** El plan ya está en el suelo de kcal: recortar más no es una opción. */
  atFloor?: boolean;
  /** Semanas seguidas en déficit sin pausa. A partir de 8, semana de mantenimiento. */
  weeksInDeficit?: number | null;
  performance: "sube" | "igual" | "baja";
  waistDeltaCm: number | null; readinessAvg: number | null; adherencePct: number | null; stepsAvg: number | null; stepsGoal: number;
}): { action: WeeklyAction; why: string } {
  if (i.adherencePct != null && i.adherencePct < 80)
    return { action: "arreglar_adherencia", why: `Adherencia del ${Math.round(i.adherencePct)} %: con menos del 80 % no se puede juzgar el plan. No se toca nada.` };
  if (i.weeksInDeficit != null && i.weeksInDeficit >= DIET_BREAK_WEEKS)
    return { action: "semana_mantenimiento", why: `Llevas ${i.weeksInDeficit} semanas seguidas en déficit: 1-2 semanas a mantenimiento, con la misma proteína. Ayuda a la adherencia y al gasto; no acelera la pérdida de grasa.` };
  if (i.ratePct == null) return { action: "mantener", why: "Faltan pesadas para medir el ritmo (mínimo 4 en 7 días)." };
  const loss = -i.ratePct;
  const goal = i.effectivePct != null && i.effectivePct > 0 ? Math.min(i.targetPct, i.effectivePct) : i.targetPct;
  const goalText = goal < i.targetPct ? `${goal} % real (pediste ${i.targetPct} %, el tope o el suelo lo recortan)` : `${goal} %`;
  if (i.performance === "baja" && i.readinessAvg != null && i.readinessAvg < 50)
    return { action: "semana_mantenimiento", why: "Cae el rendimiento y el readiness está por debajo de 50: una semana a mantenimiento." };
  if (loss > goal * 1.4 && i.performance !== "sube")
    return { action: "subir_kcal", why: `Bajas un ${loss.toFixed(2)} %/semana (objetivo ${goalText}): demasiado rápido. Sube un 5 % en días On.` };
  const waistMoving = i.waistDeltaCm != null && i.waistDeltaCm <= -0.3;
  if (loss < goal * 0.5 && !waistMoving) {
    if (i.stepsAvg != null && i.stepsAvg < i.stepsGoal)
      return { action: "subir_pasos", why: `Ritmo lento y media de ${Math.round(i.stepsAvg)} pasos: primero llega a ${i.stepsGoal}, sobre todo en días Off.` };
    if (i.atFloor)
      return { action: "subir_pasos", why: `Ritmo por debajo de la mitad de ${goalText}, pero ya estás en el suelo de kcal: no se recorta más. La palanca es la actividad (unos 2.000 pasos más que tu objetivo) o aceptar el ritmo.` };
    return { action: "bajar_kcal", why: `Ritmo por debajo de la mitad del objetivo (${goalText}), con pasos cumplidos y cintura quieta: recorta un 5-8 %, de hidratos y en días Off.` };
  }
  return { action: "mantener", why: waistMoving && loss < goal * 0.5 ? "La báscula va lenta pero la cintura baja: se mantiene." : `En ritmo (objetivo ${goalText}). No se toca.` };
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
