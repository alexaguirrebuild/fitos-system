/** Cardio: FC máx (Tanaka), zonas por reserva (Karvonen, tabla ESEN) y carga de resistencia (ECOS simplificado). */

export const hrMaxTanaka = (age: number) => 208 - 0.7 * age;
export const karvonen = (hrMax: number, hrRest: number, pct: number) => Math.round((hrMax - hrRest) * pct + hrRest);

/** Tabla ESEN: Z1 40-50 %, Z2 55-65 %, Z3 70-75 %, Z4 80-85 %, Z5 90-100 %. Aquí con bordes contiguos. */
const ZONE_PCT: [number, number][] = [[0.4, 0.55], [0.55, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1]];
export const ZONE_LABEL = ["Muy suave", "Suave", "Moderado", "Intenso", "Muy intenso"];

export function hrZones(age: number, hrRest: number) {
  const max = hrMaxTanaka(age);
  return ZONE_PCT.map(([lo, hi], i) => ({ zone: i + 1, label: ZONE_LABEL[i], from: karvonen(max, hrRest, lo), to: karvonen(max, hrRest, hi) }));
}

export function zoneOf(hr: number, age: number, hrRest: number): number {
  const z = hrZones(age, hrRest);
  if (hr < z[0].from) return 0;
  return z.findLast((x) => hr >= x.from)?.zone ?? 0;
}

/** ECOS simplificado: minutos × factor de zona (Z1 = 1 … Z5 = 5). */
export const ecos = (minutes: number, zone: number) => Math.round(minutes * Math.max(1, Math.min(5, zone)));

/** Ratio fuerza:resistencia de la semana. Con objetivo estético se busca 3:1 o más. */
export function strengthEnduranceRatio(strengthSessions: number, enduranceSessions: number) {
  if (enduranceSessions === 0) return { ratio: null, ok: true };
  const ratio = Math.round((strengthSessions / enduranceSessions) * 10) / 10;
  return { ratio, ok: ratio >= 3 };
}

/** Objetivo de pasos: base en día On y más en día Off (Ibon: aprieta la actividad los días de descanso). */
export const stepsGoal = (isTrainingDay: boolean, base = 10_000, offExtra = 2_000) => (isTrainingDay ? base : base + offExtra);
