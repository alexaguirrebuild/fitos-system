/**
 * Carga de entrenamiento: sRPE×min, EWMA aguda/crónica por día de calendario (el arreglo del ACWR),
 * tonelaje, NL, IMR e índice de estrés por RIR.
 */
import type { SetLog } from "./strength";

export const sessionLoad = (srpe: number, minutes: number) => Math.round(srpe * minutes);

const DAY = 86_400_000;
const toDay = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / DAY);
export const daysBetween = (a: string, b: string) => toDay(b) - toDay(a);

/** Suma la carga por día entre `from` y `to` (incluidos). Los días sin sesión valen 0: ese era el fallo de la app antigua. */
export function dailyLoads(sessions: { date: string; load: number }[], from: string, to: string): number[] {
  const n = daysBetween(from, to) + 1;
  if (n <= 0) return [];
  const out = Array(n).fill(0) as number[];
  const d0 = toDay(from);
  for (const s of sessions) {
    const i = toDay(s.date) - d0;
    if (i >= 0 && i < n) out[i] += s.load;
  }
  return out;
}

/** Media móvil exponencial: λ = 2/(N+1); EWMA_hoy = carga_hoy·λ + (1−λ)·EWMA_ayer. */
export function ewma(values: number[], n: number): number[] {
  const lambda = 2 / (n + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * lambda + (1 - lambda) * out[i - 1]));
  return out;
}

export type AcwrZone = "subcarga" | "optimo" | "precaucion" | "pico" | "pico_extremo";

/**
 * 0,8-1,3 es la franja de menor riesgo (Maupin 2020, PMID 32158285). Por encima de 2,0 el riesgo relativo de lesión
 * fue de 6,5 a 21 (Williams 2017, PMID 28003238). Es una bandera de «salto de carga», no un objetivo (Impellizzeri 2020).
 */
export function acwrZone(r: number): AcwrZone {
  if (r < 0.8) return "subcarga";
  if (r <= 1.3) return "optimo";
  if (r <= 1.5) return "precaucion";
  if (r <= 2) return "pico";
  return "pico_extremo";
}

export type Acwr = {
  acute: number;
  chronic: number;
  ratio: number | null;
  zone: AcwrZone | null;
  days: number;
  /** Con menos de 21 días de historial el ratio no dice nada. */
  reliable: boolean;
  series: { acute: number[]; chronic: number[] };
};

/**
 * ACWR con EWMA 7/28 desde la primera sesión hasta `today`.
 * Es un semáforo de picos de carga, no una probabilidad de lesión (Impellizzeri 2020).
 */
export function acwr(sessions: { date: string; load: number }[], today: string): Acwr {
  const dated = sessions.filter((s) => daysBetween(s.date, today) >= 0);
  if (!dated.length)
    return { acute: 0, chronic: 0, ratio: null, zone: null, days: 0, reliable: false, series: { acute: [], chronic: [] } };
  const first = dated.reduce((a, s) => (s.date < a ? s.date : a), dated[0].date).slice(0, 10);
  const loads = dailyLoads(dated, first, today);
  const a = ewma(loads, 7);
  const c = ewma(loads, 28);
  const acute = a[a.length - 1];
  const chronic = c[c.length - 1];
  const reliable = loads.length >= 21;
  const ratio = chronic > 0 ? acute / chronic : null;
  return {
    acute: Math.round(acute),
    chronic: Math.round(chronic),
    ratio: reliable && ratio != null ? Math.round(ratio * 100) / 100 : null,
    zone: reliable && ratio != null ? acwrZone(ratio) : null,
    days: loads.length,
    reliable,
    series: { acute: a, chronic: c },
  };
}

export const tonnage = (sets: SetLog[]) => sets.reduce((a, s) => a + s.kg * s.reps, 0);
/** NL: número de levantamientos (repeticiones totales). */
export const liftCount = (sets: SetLog[]) => sets.reduce((a, s) => a + s.reps, 0);
/** IMR: intensidad media relativa = (tonelaje / NL) / 1RM. */
export function meanRelativeIntensity(sets: SetLog[], oneRm: number): number | null {
  const nl = liftCount(sets);
  return nl > 0 && oneRm > 0 ? tonnage(sets) / nl / oneRm : null;
}

/**
 * Índice de estrés por serie (tabla de Robert Frederick / Tuchscherer, cuaderno del máster):
 * RIR 4 = 0,6 · RIR 3 = 0,8 · RIR 2 = 1,0 · RIR 1 = 1,2 · RIR 0 = 1,6. Medios puntos, interpolados. Heurística.
 */
const STRESS_BY_RIR = [1.6, 1.2, 1.0, 0.8, 0.6];
export function setStress(rir: number | null): number {
  const r = Math.max(0, rir ?? 2);
  if (r >= 4) return Math.max(0.2, 0.6 - 0.2 * (r - 4));
  const lo = Math.floor(r);
  return Math.round((STRESS_BY_RIR[lo] + (STRESS_BY_RIR[lo + 1] - STRESS_BY_RIR[lo]) * (r - lo)) * 100) / 100;
}

export type StressBand = "ligero" | "medio" | "duro";
const sumStress = (sets: SetLog[]) => Math.round(sets.reduce((a, s) => a + setStress(s.rir), 0) * 10) / 10;

/** Estrés de UNA sesión para un grupo muscular o patrón: fácil 2,5 · moderado 3,5 · duro 4,5. */
export function sessionStress(sets: SetLog[]): { value: number; band: StressBand } {
  const value = sumStress(sets);
  return { value, band: value >= 4.5 ? "duro" : value >= 3.5 ? "medio" : "ligero" };
}

/** Estrés semanal de un grupo muscular o patrón de movimiento: fácil 14 · moderado 20 · duro 26. */
export function weeklyStress(sets: SetLog[]): { value: number; band: StressBand } {
  const value = sumStress(sets);
  return { value, band: value >= 26 ? "duro" : value >= 20 ? "medio" : "ligero" };
}
