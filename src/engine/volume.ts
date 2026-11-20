/**
 * Volumen: repeticiones y series efectivas, series fraccionales por grupo, MEV/MRV,
 * ratio estímulo-fatiga (heurística) y el REF del Excel.
 */
import type { SetLog } from "./strength";

/** Modelo de las 5 repeticiones efectivas (Ibon): cuentan las 5 últimas antes del fallo. */
export const effectiveReps = (reps: number, rir: number | null) => Math.max(0, Math.min(reps, 5 - (rir ?? 2)));

/** Serie efectiva = a 3 o menos del fallo. Sin RIR anotado se da por efectiva. */
export const isHardSet = (s: SetLog) => s.reps > 0 && (s.rir == null || s.rir <= 3);

export type MuscleEntry = { primary: string; secondary?: string[]; sets: SetLog[] };

/** Series efectivas por grupo: 1 al principal y 0,5 a cada sinergista (convención, no medición). */
export function hardSetsByMuscle(entries: MuscleEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const n = e.sets.filter(isHardSet).length;
    if (!n) continue;
    out[e.primary] = (out[e.primary] ?? 0) + n;
    for (const m of e.secondary ?? []) out[m] = (out[m] ?? 0) + n * 0.5;
  }
  return out;
}

export type VolumeStatus = "bajo_mev" | "en_rango" | "cerca_mrv" | "sobre_mrv";

export function volumeStatus(sets: number, mev: number, mrv: number): VolumeStatus {
  if (sets < mev) return "bajo_mev";
  if (sets > mrv) return "sobre_mrv";
  return sets >= mev + (mrv - mev) * 0.85 ? "cerca_mrv" : "en_rango";
}

/** Series semanales orientativas por grupo según nivel (cuaderno del máster). Arranque, no ley. */
export const LEVEL_WEEKLY_SETS: Record<1 | 2 | 3 | 4, [number, number]> = { 1: [6, 10], 2: [10, 16], 3: [16, 20], 4: [16, 25] };

/**
 * Volumen de un microciclo que no dura 7 días, expresado en series por semana: series ÷ días × 7.
 * MEV y MRV están definidos por semana: comparar el total de un microciclo de 9 o 14 días tal cual infla la fatiga real.
 */
export const weeklyEquivalentSets = (sets: number, cycleDays: number) =>
  cycleDays > 0 ? Math.round((sets / cycleDays) * 7 * 10) / 10 : sets;

/** Tope útil por sesión y grupo: la curva se aplana a partir de ~8-10 series (Ibon). */
export const SESSION_CAP = 10;
export const junkSetsInSession = (setsForMuscle: number) => Math.max(0, setsForMuscle - SESSION_CAP);

/** Qué hacer con el volumen de un grupo según el % de ejercicios que progresan. */
export function volumeAdvice(rate: number | null, status: VolumeStatus) {
  if (rate == null) return { action: "mantener" as const, why: "Aún no hay dos sesiones que comparar." };
  if (status === "sobre_mrv") return { action: "bajar" as const, why: "Por encima del máximo recuperable." };
  if (rate >= 0.7 && status !== "cerca_mrv")
    return { action: "subir" as const, why: "Progresa el 70 % o más: hay margen. Sube antes frecuencia que series por sesión." };
  if (rate < 0.4) return { action: "revisar" as const, why: "Progresa menos del 40 %: antes de añadir, revisa técnica, sueño, estrés y calorías." };
  return { action: "mantener" as const, why: "Progreso suficiente con el volumen actual." };
}

/* --- Ratio estímulo-fatiga por ejercicio (heurística declarada) --- */

export const STABILITY = {
  unilateral_libre: 1.3,
  bilateral_libre: 1.1,
  unilateral_guiado: 0.9,
  bilateral_guiado: 0.8,
} as const;
export const RESISTANCE = { constante: 1.0, variable: 1.1 } as const;

export type CostProfile = {
  /** 1,5 sentadilla y peso muerto; 1,2 press banca; 1,0 el resto (hoja «BANCO EJERCICIOS»). */
  base: number;
  stability: keyof typeof STABILITY;
  resistance: keyof typeof RESISTANCE;
};

export const fatigueCost = (c: CostProfile) => c.base * STABILITY[c.stability] * RESISTANCE[c.resistance];

export function stimulusFatigue(sets: SetLog[], cost: CostProfile) {
  const stimulus = sets.reduce((a, s) => a + effectiveReps(s.reps, s.rir), 0);
  const fatigue = sets.filter((s) => s.reps > 0).length * fatigueCost(cost);
  return { stimulus, fatigue: Math.round(fatigue * 100) / 100, sfr: fatigue > 0 ? Math.round((stimulus / fatigue) * 100) / 100 : null };
}

/* --- REF del Excel «Ratio estímulo - fatiga»: reps / (100 − %1RM) --- */

export function refIndex(kg: number, reps: number, oneRm: number): number | null {
  if (!(oneRm > 0) || !(kg > 0) || !(reps > 0)) return null;
  const pct = (kg / oneRm) * 100;
  return pct >= 100 ? null : reps / (100 - pct);
}

export const refSessionBand = (ref: number) =>
  ref < 0.4 ? "poco_estimulo" : ref <= 1.3 ? "bueno_recuperable" : ref <= 2.3 ? "acumulacion" : "muy_dificil";
export const refWeekBand = (ref: number) =>
  ref < 2.0 ? "descarga" : ref <= 3.4 ? "carga_adaptacion" : ref <= 4.6 ? "demandante" : "no_sostenible";
