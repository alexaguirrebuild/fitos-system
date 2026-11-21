/**
 * Recuperación: readiness (fórmula heredada), recuperación Gorilangel, Hooper, línea base propia,
 * POMS de 52 ítems con el mapa corregido, decisión de descarga y regla del tobillo.
 */

export type Checkin = { sueno: number; estres: number; motiv: number; dolor: number; fatiga: number; horas?: number };

/** Readiness 0-100. Misma fórmula que SISTEMA-ALEX-APP para que el histórico sea comparable. */
export const readiness = (c: Checkin) =>
  Math.round(c.sueno * 3 + (10 - c.estres) * 2.5 + c.motiv * 2 + (10 - c.dolor) * 1.5 + (10 - c.fatiga) * 1);

export type ReadinessBand = "completa" | "mas_rir" | "solo_efectivas" | "z2";
export function readinessBand(r: number): { band: ReadinessBand; label: string } {
  if (r >= 70) return { band: "completa", label: "Sesión completa. A por marcas." };
  if (r >= 50) return { band: "mas_rir", label: "Sesión completa con una más en reserva. Sin top sets." };
  if (r >= 30) return { band: "solo_efectivas", label: "Solo las series efectivas. Fuera accesorios." };
  return { band: "z2", label: "Z2 suave o descanso. Hoy no se entrena pesado." };
}

/** Puntuación de recuperación del «Documento de seguimiento» (C17), sobre 100. Entradas 1-10. */
export function recoveryGorilangel(i: {
  fatiga: number; recuperacion: number; agujetas: number; rindeMas: boolean; duermeBien: boolean;
  calidadSueno: number; energia: number; libido: number;
}) {
  return (11 - i.fatiga) + i.recuperacion + (11 - i.agujetas) + (i.rindeMas ? 30 : 0) + (i.duermeBien ? 15 : 0) +
    i.calidadSueno + i.energia + i.libido / 2;
}

/** Índice de Hooper: sueño, estrés, fatiga y agujetas de 1 (bien) a 7 (mal). > 20 = estrés alto. */
export function hooper(sueno: number, estres: number, fatiga: number, agujetas: number) {
  const total = sueno + estres + fatiga + agujetas;
  return { total, high: total > 20 };
}

/** Desviación del valor de hoy respecto a la media propia (28 días). Sin normas poblacionales. */
export function baselineDelta(today: number, history: number[]): { mean: number; z: number } | null {
  if (history.length < 7) return null;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const sd = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length);
  return { mean: Math.round(mean * 10) / 10, z: sd > 0 ? Math.round(((today - mean) / sd) * 100) / 100 : 0 };
}

/* ------------------------------ POMS ------------------------------ */

export const POMS_ITEMS = [
  "Tenso", "Enfadado", "Agotado", "Infeliz", "Animado", "Confundido", "Dolido por actos pasados", "Agitado",
  "Enojado", "Triste", "Activo", "A punto de estallar", "Desamparado", "Inquieto", "Irritable", "Abatido",
  "Enérgico", "Desesperanzado", "Relajado", "Rencoroso", "Intranquilo", "Fatigado", "Molesto", "Desanimado",
  "Resentido", "Sin fuerzas", "Nervioso", "Solo", "Desdichado", "Aturdido", "Alegre", "Amargado", "Exhausto",
  "Ansioso", "Luchador", "Deprimido", "Desesperado", "Rebelde", "Desorientado", "Alerta", "Decepcionado",
  "Furioso", "Eficiente", "Lleno de energía", "De mal genio", "Inútil", "Aterrorizado", "Culpable", "Vigoroso",
  "Inseguro", "Cansado", "Al límite",
] as const;

export type PomsScale = "tension" | "depresion" | "colera" | "vigor" | "fatiga";

/**
 * Ítem (1-52) → escala. El Excel original enlaza mal 44, 45, 46, 49, 50, 51 y 52 y no invierte el 19;
 * aquí va corregido (ver docs/MOTOR.md).
 */
export const POMS_MAP: Record<PomsScale, number[]> = {
  depresion: [4, 6, 7, 10, 13, 16, 18, 24, 25, 28, 29, 30, 32, 36, 37, 39, 41, 46, 47, 48, 50],
  vigor: [5, 11, 17, 31, 35, 40, 43, 44, 49],
  colera: [2, 9, 12, 15, 20, 23, 38, 42, 45],
  tension: [1, 8, 14, 19, 21, 27, 34, 52],
  fatiga: [3, 22, 26, 33, 51],
};
const POMS_REVERSED = new Set([19]);

export type PomsResult = Record<PomsScale, number> & {
  tmd: number;
  /** Cada escala de 0 a 1 sobre su máximo, para dibujar el perfil. */
  normalized: Record<PomsScale, number>;
  shape: "iceberg" | "plano" | "invertido";
};

/** `answers`: 52 valores de 0 (nada) a 4 (muchísimo), en el orden de POMS_ITEMS. */
export function scorePoms(answers: number[]): PomsResult {
  if (answers.length !== 52) throw new Error("El POMS necesita 52 respuestas");
  const scale = (k: PomsScale) =>
    POMS_MAP[k].reduce((a, n) => a + (POMS_REVERSED.has(n) ? 4 - answers[n - 1] : answers[n - 1]), 0);
  const s = { tension: scale("tension"), depresion: scale("depresion"), colera: scale("colera"), vigor: scale("vigor"), fatiga: scale("fatiga") };
  const normalized = Object.fromEntries(
    (Object.keys(s) as PomsScale[]).map((k) => [k, s[k] / (POMS_MAP[k].length * 4)]),
  ) as Record<PomsScale, number>;
  const neg = (normalized.tension + normalized.depresion + normalized.colera + normalized.fatiga) / 4;
  const shape = normalized.vigor - neg >= 0.25 ? "iceberg" : neg - normalized.vigor >= 0.1 ? "invertido" : "plano";
  return { ...s, tmd: s.tension + s.depresion + s.colera + s.fatiga - s.vigor, normalized, shape };
}

/* --------------------------- Descarga --------------------------- */

export type DeloadSignals = {
  /** El e1RM de un básico cae en dos sesiones seguidas. */
  e1rmDropping: boolean;
  readiness7dAvg: number | null;
  /** Mayor estrés semanal entre los grupos musculares. */
  maxWeeklyStress: number | null;
  acwrRatio: number | null;
  /** Semana de exámenes u otro estresor externo alto. */
  externalStress?: boolean;
  /** Noches de los últimos 7 días con menos de 7 h de sueño. */
  shortSleepNights?: number | null;
  /** Peor dolor tendinoso o articular reciente, 0-10. */
  tendonPain?: number | null;
};

/** Noches cortas (< 7 h) en 7 días que cuentan como señal: la restricción seguida baja la fuerza en multiarticulares (Knowles 2018, PMID 29422383). */
export const SHORT_SLEEP_NIGHTS = 3;
/** Dolor tendinoso por encima del que cuenta como señal (Pain-Monitoring Model: ≤ 5/10; PMID 33632313). */
export const TENDON_PAIN_SIGNAL = 5;

/**
 * Hacen falta dos señales. Así una mala noche no dispara una descarga.
 * Es más estricto que el OR del reglamento (CAR-05) a propósito: se mantiene.
 */
export function deloadDecision(s: DeloadSignals) {
  const signals: string[] = [];
  if (s.e1rmDropping) signals.push("La fuerza cae dos sesiones seguidas");
  if (s.readiness7dAvg != null && s.readiness7dAvg < 50) signals.push(`Readiness medio de 7 días en ${Math.round(s.readiness7dAvg)}`);
  if (s.maxWeeklyStress != null && s.maxWeeklyStress > 26) signals.push("Estrés semanal por encima de 26 en algún grupo");
  if (s.acwrRatio != null && s.acwrRatio > 1.5) signals.push(`${s.acwrRatio > 2 ? "Pico de carga extremo" : "Pico de carga"} (ACWR ${s.acwrRatio})`);
  if (s.externalStress) signals.push("Estresor externo alto (exámenes)");
  if (s.shortSleepNights != null && s.shortSleepNights >= SHORT_SLEEP_NIGHTS) signals.push(`${s.shortSleepNights} de las últimas 7 noches por debajo de 7 h`);
  if (s.tendonPain != null && s.tendonPain > TENDON_PAIN_SIGNAL) signals.push(`Dolor tendinoso de ${s.tendonPain}/10`);
  const deload = signals.length >= 2;
  return {
    deload,
    signals,
    plan: deload ? "Una semana: 40 % menos de series, misma carga, 2 más en reserva." : null,
    /** Con exámenes y sin más señales: mantenimiento (series al mínimo efectivo), no descarga. */
    maintenance: !deload && !!s.externalStress,
  };
}

/* ---------------------------- Tobillo ---------------------------- */

export type AnkleRule = {
  restricted: boolean;
  impactAllowed: boolean;
  z2Modes: string[];
  squatCapPct: number | null;
  dropTopSet: boolean;
  swaps: Record<string, string>;
  notes: string[];
};

/** `pain` 0-10 hoy; `painDayAfterLegs` 0-10 al día siguiente de la última sesión de pierna. */
export function ankleRule(pain: number, painDayAfterLegs: number | null = null): AnkleRule {
  const restricted = pain > 3 || (painDayAfterLegs ?? 0) > 3;
  return {
    restricted,
    impactAllowed: pain <= 1 && (painDayAfterLegs ?? 0) <= 1,
    z2Modes: pain <= 1 ? ["bici", "elíptica", "cinta inclinada andando"] : ["bici", "elíptica"],
    squatCapPct: restricted ? 75 : null,
    dropTopSet: (painDayAfterLegs ?? 0) > 3,
    swaps: restricted ? { "Búlgaras": "Prensa unilateral", "Sentadilla libre": "Sentadilla multipower", "Carrera": "Bici Z2", "HIIT con impacto": "Bici por intervalos" } : {},
    notes: restricted
      ? ["El tobillo manda: cero carrera, cero saltos, cero HIIT con impacto.", "Prensa con pies altos si tira.", "Movilidad de tobillo 3 × 10 por lado, rango sin dolor."]
      : ["Sin restricción. Si duele al día siguiente de pierna, anótalo: quita el top set de la próxima."],
  };
}
