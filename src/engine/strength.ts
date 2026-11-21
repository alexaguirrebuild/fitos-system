/**
 * Fuerza: e1RM con RIR, tabla RPE→%1RM, progresión autorregulada, calentamiento y discos.
 * Funciones puras. Fuentes y decisiones: docs/MOTOR.md.
 */

export type SetLog = { kg: number; reps: number; rir: number | null };
export type Confidence = "alta" | "media" | "baja";

export const epley = (kg: number, repsToFailure: number) =>
  repsToFailure <= 1 ? kg : kg * (1 + repsToFailure / 30);

export const brzycki = (kg: number, repsToFailure: number) =>
  repsToFailure <= 1 ? kg : (kg * 36) / (37 - repsToFailure);

/** Factor 1RM/carga. Epley hasta 10 reps al fallo; media Epley-Brzycki de 11 a 15 (coinciden en 10). */
export function rmFactor(repsToFailure: number): number | null {
  if (repsToFailure < 1 || repsToFailure > 15) return null;
  if (repsToFailure <= 1) return 1;
  if (repsToFailure <= 10) return 1 + repsToFailure / 30;
  return (1 + repsToFailure / 30 + 36 / (37 - repsToFailure)) / 2;
}

export function estimate1RM(set: SetLog): { value: number; confidence: Confidence } | null {
  if (!(set.kg > 0) || !(set.reps >= 1)) return null;
  const rtf = set.reps + (set.rir ?? 0);
  const f = rmFactor(rtf);
  if (f == null) return null;
  // El RIR se estima con ±1 hasta RIR 3; más lejos del fallo el error crece a 2-3 reps.
  let confidence: Confidence = "baja";
  if (set.rir != null && set.rir <= 3) confidence = rtf <= 10 ? "alta" : "media";
  return { value: set.kg * f, confidence };
}

const RANK: Record<Confidence, number> = { alta: 3, media: 2, baja: 1 };

/** Mejor e1RM de una lista de series: gana la confianza y, a igualdad, el valor. */
export function bestE1RM(sets: SetLog[]): { value: number; confidence: Confidence } | null {
  let best: { value: number; confidence: Confidence } | null = null;
  for (const s of sets) {
    const e = estimate1RM(s);
    if (!e) continue;
    if (
      !best ||
      RANK[e.confidence] > RANK[best.confidence] ||
      (RANK[e.confidence] === RANK[best.confidence] && e.value > best.value)
    )
      best = e;
  }
  return best;
}

export function roundToStep(kg: number, step: number, mode: "nearest" | "up" | "down" = "nearest") {
  if (!(step > 0)) return kg;
  const q = kg / step;
  const r = mode === "up" ? Math.ceil(q - 1e-9) : mode === "down" ? Math.floor(q + 1e-9) : Math.round(q);
  return Math.round(r * step * 1000) / 1000;
}

/** Carga para hacer `reps` dejando `rir` en reserva, dado un e1RM. */
export function loadForTarget(e1rm: number, reps: number, rir: number, step = 2.5): number | null {
  const f = rmFactor(reps + rir);
  return f == null ? null : roundToStep(e1rm / f, step);
}

/** Tabla RPE × reps → %1RM (Tuchscherer/RTS), tal como viene en la hoja «PRESCRIPCIÓN» de Gorilangel. */
export const RPE_TABLE: Record<string, number[]> = {
  "10": [100, 95.5, 92.2, 89.2, 86.3, 83.7, 81.1, 78.6, 76.2, 73.9, 70.7, 68.0],
  "9.5": [97.8, 93.9, 90.7, 87.8, 85.0, 82.4, 79.9, 77.4, 75.1, 72.3, 69.4, 66.7],
  "9": [95.5, 92.2, 89.2, 86.3, 83.7, 81.1, 78.6, 76.2, 73.9, 70.7, 68.0, 65.3],
  "8.5": [93.9, 90.7, 87.8, 85.0, 82.4, 79.9, 77.4, 75.1, 72.3, 69.4, 66.7, 64.0],
  "8": [92.2, 89.2, 86.3, 83.7, 81.1, 78.6, 76.2, 73.9, 70.7, 68.0, 65.3, 62.6],
  "7.5": [90.7, 87.8, 85.0, 82.4, 79.9, 77.4, 75.1, 72.3, 69.4, 66.7, 64.0, 61.3],
  "7": [89.2, 86.3, 83.7, 81.1, 78.6, 76.2, 73.9, 70.7, 68.0, 65.3, 62.6, 59.9],
  // La hoja trae 85,5 en la 2.ª columna de esta fila; por el patrón de la tabla es 85,0.
  "6.5": [87.8, 85.0, 82.4, 79.9, 77.4, 75.1, 72.3, 69.4, 66.7, 64.0, 61.3, 58.6],
};

export const rirToRpe = (rir: number) => 10 - rir;

export function pctFromRpe(reps: number, rpe: number): number | null {
  const row = RPE_TABLE[String(Math.round(rpe * 2) / 2)];
  if (!row || reps < 1 || reps > 12) return null;
  return row[Math.round(reps) - 1];
}

/* ------------------------------------------------------------------ */
/* Progresión: doble progresión con RIR, función pura del historial.   */
/* ------------------------------------------------------------------ */

export type Prescription = {
  sets: number;
  repMin: number;
  repMax: number;
  rirTarget: number;
  /** Salto real de carga del ejercicio (2,5 barra; placa de la máquina; 1-2 mancuerna). */
  step: number;
  kind: "compuesto" | "aislamiento";
};

export type PastSession = { date: string; sets: SetLog[] };

export type ProgressionRule =
  | "primera"
  | "subir_carga"
  | "sumar_rep"
  | "repetir"
  | "bajar_carga"
  | "descarga"
  | "readiness_bajo"
  | "solo_z2";

export type Suggestion = {
  rule: ProgressionRule;
  kg: number | null;
  sets: number;
  repsTarget: number[];
  rirTarget: number;
  why: string;
  stalled: boolean;
};

export type DayContext = {
  readiness?: number | null;
  deload?: boolean;
  /** Fase de déficit: los compuestos van con una repetición más en reserva (RIR-02 del reglamento). */
  inDeficit?: boolean;
  /** No progresar hoy (p. ej., el tobillo dolió más a la mañana siguiente que antes de la última sesión de pierna). */
  holdProgression?: string | null;
};

const workingLoad = (s: PastSession) => (s.sets.length ? s.sets[0].kg : 0);
const atLoad = (s: PastSession, kg: number) => s.sets.filter((x) => x.kg === kg);
const totalReps = (s: PastSession) => s.sets.reduce((a, x) => a + x.reps, 0);

/**
 * Qué toca hoy en un ejercicio. `history` va de la sesión más reciente a la más antigua
 * y solo lleva series efectivas (sin aproximaciones).
 */
export function suggestNext(history: PastSession[], rx: Prescription, ctx: DayContext = {}): Suggestion {
  const base = { sets: rx.sets, rirTarget: rx.rirTarget, stalled: false };
  const floor = Array(rx.sets).fill(rx.repMin) as number[];
  const readiness = ctx.readiness ?? null;

  if (readiness != null && readiness < 30)
    return { ...base, rule: "solo_z2", kg: null, repsTarget: [], sets: 0,
      why: `Readiness ${readiness}: hoy Z2 suave o descanso, sin pesas pesadas.` };

  const last = history.find((h) => h.sets.length > 0);
  if (!last)
    return { ...base, rule: "primera", kg: null, repsTarget: floor,
      why: `Sin historial. Elige una carga con la que salgan ${rx.repMin} reps dejando ${rx.rirTarget} en reserva.` };

  const w = workingLoad(last);
  const ws = atLoad(last, w);

  if (ctx.deload) {
    const n = Math.max(1, Math.ceil(rx.sets * 0.6));
    return { ...base, rule: "descarga", kg: w, sets: n, repsTarget: Array(n).fill(rx.repMin),
      rirTarget: rx.rirTarget + 2,
      why: `Descarga: ${n} series en vez de ${rx.sets}, misma carga, ${rx.rirTarget + 2} en reserva.` };
  }

  const reachedTop =
    ws.length >= rx.sets &&
    ws.slice(0, rx.sets).every((s) => s.reps >= rx.repMax && (s.rir ?? rx.rirTarget) >= rx.rirTarget - 1);
  const tooHeavy = ws[0].reps < rx.repMin;

  // Estancamiento: tres sesiones con la misma carga sin sumar repeticiones.
  const same = history.filter((h) => h.sets.length && workingLoad(h) === w).slice(0, 3);
  const stalled = same.length === 3 && totalReps(same[0]) <= totalReps(same[2]) && !reachedTop;

  let out: Suggestion;
  if (reachedTop) {
    const inc = rx.kind === "compuesto" ? 0.025 : 0.05;
    let kg = roundToStep(w * (1 + inc), rx.step, "up");
    if (kg <= w) kg = roundToStep(w + rx.step, rx.step);
    out = { ...base, rule: "subir_carga", kg, repsTarget: floor,
      why: `Llegaste a ${rx.repMax} reps en las ${rx.sets} series con ${w} kg. Sube a ${kg} kg y vuelve a ${rx.repMin}.` };
  } else if (tooHeavy) {
    const prev = history.filter((h) => h !== last && h.sets.length)[0];
    const prevAlsoHeavy = !!prev && workingLoad(prev) >= w && prev.sets[0].reps < rx.repMin;
    if (prevAlsoHeavy) {
      const kg = roundToStep(w * 0.95, rx.step, "down");
      out = { ...base, rule: "bajar_carga", kg, repsTarget: floor,
        why: `Dos sesiones por debajo de ${rx.repMin} reps con ${w} kg. Baja a ${kg} kg y reconstruye.` };
    } else {
      out = { ...base, rule: "repetir", kg: w, repsTarget: floor,
        why: `La primera serie se quedó en ${ws[0].reps} (el rango empieza en ${rx.repMin}). Repite ${w} kg.` };
    }
  } else {
    const target = Array.from({ length: rx.sets }, (_, i) => Math.min(rx.repMax, ws[i]?.reps ?? rx.repMin));
    const i = target.findIndex((r) => r < rx.repMax);
    if (i >= 0) target[i] += 1;
    out = { ...base, rule: "sumar_rep", kg: w, repsTarget: target,
      why: `Misma carga (${w} kg). Objetivo: una repetición más en la serie ${i + 1}.` };
  }

  if (readiness != null && readiness < 50) {
    const keep = Array.from({ length: rx.sets }, (_, i) => Math.max(rx.repMin, Math.min(rx.repMax, ws[i]?.reps ?? rx.repMin)));
    out = { ...out, rule: "readiness_bajo", kg: w, repsTarget: keep, rirTarget: rx.rirTarget + 1,
      why: `Readiness ${readiness}: misma carga y repeticiones que la última vez, con una más en reserva. Hoy no se buscan marcas.` };
  }
  // Freno externo (tobillo): ni carga ni repeticiones nuevas. Se repite lo de la última vez.
  if (ctx.holdProgression && (out.rule === "subir_carga" || out.rule === "sumar_rep")) {
    const keep = Array.from({ length: rx.sets }, (_, i) => Math.max(rx.repMin, Math.min(rx.repMax, ws[i]?.reps ?? rx.repMin)));
    out = { ...out, rule: "repetir", kg: w, repsTarget: keep, why: `${ctx.holdProgression} Repite ${w} kg y las mismas repeticiones, sin progresar.` };
  }
  // En déficit, los básicos se alejan un punto del fallo: la fuerza se mantiene y la fatiga cuesta más (RIR-02; PMID 38970765, 36334240).
  if (ctx.inDeficit && rx.kind === "compuesto" && out.rirTarget === rx.rirTarget) {
    out = { ...out, rirTarget: rx.rirTarget + 1, why: `${out.why} En déficit, los básicos van con ${rx.rirTarget + 1} en reserva.` };
  }
  if (stalled) out = { ...out, stalled: true,
    why: out.why + " Llevas 3 sesiones sin sumar: revisa sueño, estrés, calorías del día y orden del ejercicio antes de tocar el volumen." };
  return out;
}

/** % de ejercicios que progresan (más reps totales o más carga que la sesión anterior). Regla de Ibon para tocar volumen. */
export function progressRate(pairs: { last: PastSession; prev: PastSession }[]): number | null {
  if (!pairs.length) return null;
  const up = pairs.filter(({ last, prev }) => {
    const a = bestE1RM(last.sets)?.value ?? 0;
    const b = bestE1RM(prev.sets)?.value ?? 0;
    return a > b * 1.001 || (workingLoad(last) === workingLoad(prev) && totalReps(last) > totalReps(prev));
  }).length;
  return up / pairs.length;
}

/* ------------------------------------------------------------------ */
/* Calentamiento y discos                                               */
/* ------------------------------------------------------------------ */

export type WarmupKind = "no" | "reducido" | "completo";

/** Aproximaciones al peso del día. Mezcla la escalera de RV Strength y la pauta de Gorilangel. No cuentan como series efectivas. */
export function warmupLadder(targetKg: number, kind: WarmupKind, step = 2.5, bar = 20) {
  const steps: [number, number][] =
    kind === "completo" ? [[0.3, 10], [0.55, 6], [0.8, 3], [0.9, 1]] : kind === "reducido" ? [[0.5, 8], [0.8, 3]] : [];
  return steps
    .map(([pct, reps]) => ({ kg: Math.max(Math.min(bar, targetKg), roundToStep(targetKg * pct, step)), reps }))
    .filter((s, i, a) => s.kg < targetKg && (i === 0 || s.kg > a[i - 1].kg));
}

/** Discos por lado para una carga en barra (hoja F-V: CEILING((carga − barra) / 2; disco mínimo)). */
export function platesPerSide(targetKg: number, bar = 20, plates = [25, 20, 15, 10, 5, 2.5, 1.25]) {
  let side = Math.max(0, (targetKg - bar) / 2);
  const out: number[] = [];
  for (const p of plates) while (side >= p - 1e-9) { out.push(p); side -= p; }
  return { plates: out, perSide: out.reduce((a, b) => a + b, 0), exact: side < 1e-9 };
}
