/** Valoración: nivel de entrenamiento (Excel «Comprueba tu verdadero nivel») y perfil carga-velocidad (hoja MyLift). */
import type { Sex } from "./nutrition";

type Lift = "bench" | "pullup" | "squat" | "deadlift";
/** Cortes de fuerza relativa (1RM / peso corporal): principiante ≤ a · intermedio ≤ b · avanzado < c · experto ≥ c. */
const CUTS: Record<Sex, Record<Lift, [number, number, number]>> = {
  H: { bench: [1.2, 1.5, 1.8], pullup: [1.1, 1.3, 1.5], squat: [1.5, 2.0, 2.4], deadlift: [1.5, 2.2, 2.8] },
  M: { bench: [0.5, 1.0, 1.3], pullup: [0.6, 1.0, 1.2], squat: [0.8, 1.3, 1.7], deadlift: [1.0, 1.5, 2.2] },
};
export const LEVELS = ["Principiante", "Intermedio", "Avanzado", "Experto"] as const;

export function liftLevel(sex: Sex, lift: Lift, oneRm: number, bodyKg: number): 1 | 2 | 3 | 4 {
  const r = oneRm / bodyKg;
  const [a, b, c] = CUTS[sex][lift];
  return r >= c ? 4 : r > b ? 3 : r > a ? 2 : 1;
}

/** Media redondeada de 5 criterios (1-4): años, fuerza relativa, técnica, ritmo de progreso y formación. */
export function trainingLevel(i: {
  sex: Sex; bodyKg: number; years: 1 | 2 | 3 | 4; technique: 1 | 2 | 3 | 4; progress: 1 | 2 | 3 | 4; education: 1 | 2 | 3 | 4;
  lifts: Partial<Record<Lift, number>>;
}) {
  const perLift = (Object.entries(i.lifts) as [Lift, number][]).filter(([, v]) => v > 0)
    .map(([k, v]) => ({ lift: k, ratio: Math.round((v / i.bodyKg) * 100) / 100, level: liftLevel(i.sex, k, v, i.bodyKg) }));
  const strength = perLift.length ? Math.round(perLift.reduce((a, l) => a + l.level, 0) / perLift.length) : null;
  const parts = [i.years, strength, i.technique, i.progress, i.education].filter((x): x is 1 | 2 | 3 | 4 => x != null);
  const score = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  return { score, label: LEVELS[score - 1], strength, perLift };
}

/* -------------------- Perfil carga-velocidad -------------------- */

export function linearRegression(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

/** Velocidad umbral del 1RM (m/s) que usa la hoja. */
export const MVT = { bench: 0.19, squat: 0.32, deadlift: 0.36 } as const;

/** 1RM a partir de un test de cargas y velocidades: carga a la que la recta cruza la velocidad umbral. */
export function oneRmFromVelocity(points: { kg: number; v: number }[], mvt: number) {
  if (points.length < 3) return null;
  const { slope, intercept, r2 } = linearRegression(points.map((p) => p.kg), points.map((p) => p.v));
  if (!(slope < 0)) return null;
  return {
    oneRm: (mvt - intercept) / slope,
    slope,
    intercept,
    r2,
    quality: r2 > 0.99 ? "preciso" : r2 >= 0.98 ? "sesgo_hasta_5pct" : "repetir_test",
  } as const;
}
