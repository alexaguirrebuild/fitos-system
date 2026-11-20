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

/** Factor de intensidad ECOS por zona (R0 = 1, R1 = 2, R2 = 3, R3 = 4, R3+ = 6), con Z1…Z5 ≈ R0…R3+. */
const ECOS_ZONE = [1, 1, 2, 3, 4, 6];
/** Factor de modalidad ECOS: carrera 1, bici 0,5, natación 0,25 (cuaderno). Andar y elíptica no vienen en la fuente: valor asumido. */
export const ECOS_MODE: Record<string, number> = {
  carrera: 1, hiit: 1, cinta_andando: 0.75, caminar: 0.75, eliptica: 0.5, bici: 0.5, remo: 0.5, natacion: 0.25, otro: 1,
};

/**
 * ECOS = minutos en zona × factor de intensidad × modalidad × densidad (trabajo:descanso; 1 en continuo).
 * Sin `mode` el factor de modalidad es 1.
 */
export const ecos = (minutes: number, zone: number, mode?: string, density = 1) =>
  Math.round(minutes * ECOS_ZONE[Math.max(0, Math.min(5, Math.round(zone)))] * (mode ? (ECOS_MODE[mode] ?? 1) : 1) * density);

/** Ratio fuerza:resistencia de la semana. Con objetivo estético se busca 3:1 o más. */
export function strengthEnduranceRatio(strengthSessions: number, enduranceSessions: number) {
  if (enduranceSessions === 0) return { ratio: null, ok: true };
  const ratio = Math.round((strengthSessions / enduranceSessions) * 10) / 10;
  return { ratio, ok: ratio >= 3 };
}

/** Objetivo de pasos: base en día On y más en día Off (Ibon: aprieta la actividad los días de descanso). */
export const stepsGoal = (isTrainingDay: boolean, base = 10_000, offExtra = 2_000) => (isTrainingDay ? base : base + offExtra);
