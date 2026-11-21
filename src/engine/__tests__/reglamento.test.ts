/**
 * Cruce del motor con el reglamento de evidencia v1 (Claude Science, 2026-11-21).
 * Caso real: 90,07 kg, 66,83 kg de masa magra (InBody, 25,8 %), objetivo 84 kg, 5 días de pesas.
 */
import { describe, expect, it } from "vitest";
import * as E from "../index";

const alex = { kg: 90.07, leanKg: 66.83, trainDaysPerWeek: 5 };

describe("§1 · el suelo calórico y la tasa real", () => {
  it("planTargets devuelve la tasa real tras tope y suelo", () => {
    // TDEE de referencia 2.681 kcal (RMR por masa magra 1.730 × 1,55): se piden 694 kcal, el tope deja 670 y el suelo 519.
    const p = E.planTargets({ ...alex, tdee: 2681, ratePctWeek: 0.7 });
    expect(p).toMatchObject({ mode: "definicion", capped: true, floored: true, limitedBy: "suelo", floorKcal: 2162, floorBasis: "dia", requestedRatePct: 0.7 });
    expect(p.deficitKcal).toBe(519);
    expect(p.effectiveRatePct).toBe(0.52);
    expect(p.expectedKgPerWeek).toBeCloseTo(0.47, 2);
    expect(p.warnings.join(" ")).toMatch(/ritmo real es 0,52 %\/semana, no el 0,7 %/);
    // 519 kcal queda justo por encima del techo de recomposición; con 2.600 kcal de gasto (438) ya está dentro y se avisa.
    expect(p.warnings.join(" ")).not.toMatch(/terreno de recomposición/);
    expect(E.planTargets({ ...alex, tdee: 2600, ratePctWeek: 0.7 }).warnings.join(" ")).toMatch(/terreno de recomposición/);
    // Con gasto alto no recorta nada.
    expect(E.planTargets({ ...alex, tdee: 3200, ratePctWeek: 0.7 })).toMatchObject({ limitedBy: "tasa", capped: false, floored: false, effectiveRatePct: 0.7 });
    expect(E.ratePctFromDeficit(519, 90.07)).toBe(0.52);
  });

  it("el suelo es por día, también el Off; el On absorbe la diferencia sin tocar la semana", () => {
    const p = E.planTargets({ kg: 90, leanKg: 66, tdee: 2600, ratePctWeek: 0.3, trainDaysPerWeek: 5 });
    expect(p.floored).toBe(false);
    expect(p.offRaised).toBe(true);
    expect(p.off.kcal).toBe(2160);
    expect(p.on.kcal).toBeGreaterThan(p.avgKcal);
    expect(p.onOffSpreadApplied).toBeLessThan(0.12);
    expect(Math.abs(p.weeklyKcal - 7 * p.avgKcal)).toBeLessThan(6);
    // Con la media en el suelo, todos los días quedan en el suelo.
    const a = E.planTargets({ ...alex, tdee: 2681, ratePctWeek: 0.7 });
    expect(a.off.kcal).toBeGreaterThanOrEqual(a.floorKcal);
    expect(a.on.kcal).toBe(a.off.kcal);
    // Ningún día por debajo del suelo en toda la tabla del informe (antes el Off bajaba a 1.939).
    for (const tdee of [2400, 2600, 2681, 2800, 3000, 3200]) {
      const t = E.planTargets({ ...alex, tdee, ratePctWeek: 0.7 });
      expect(t.off.kcal).toBeGreaterThanOrEqual(t.floorKcal - 1);
    }
  });

  it("modo recomposición limita el déficit medio a 500 kcal", () => {
    const p = E.planTargets({ ...alex, tdee: 3200, ratePctWeek: 0.7, mode: "recomposicion" });
    expect(p).toMatchObject({ mode: "recomposicion", limitedBy: "recomposicion", deficitKcal: 500 });
    expect(p.effectiveRatePct).toBe(0.5);
    expect(p.warnings.join(" ")).toMatch(/Modo recomposición/);
    // Si el suelo recorta más, manda el suelo.
    expect(E.planTargets({ ...alex, tdee: 2500, ratePctWeek: 0.7, mode: "recomposicion" }).limitedBy).toBe("suelo");
  });

  it("la semana se juzga contra la tasa real y no pide recortar lo que el suelo impide", () => {
    const base = { targetPct: 0.7, performance: "igual" as const, waistDeltaCm: 0, readinessAvg: 65, adherencePct: 90, stepsAvg: 10500, stepsGoal: 10000 };
    // 0,3 %/semana: lento frente al 0,7 pedido, en ritmo frente al 0,52 real.
    expect(E.weeklyDecision({ ...base, ratePct: -0.3 }).action).toBe("bajar_kcal");
    expect(E.weeklyDecision({ ...base, ratePct: -0.3, effectivePct: 0.52 }).action).toBe("mantener");
    // Lento también frente a la real, pero en el suelo: la palanca es la actividad, no bajar kcal. Se acabó el bucle.
    const atFloor = E.weeklyDecision({ ...base, ratePct: -0.1, effectivePct: 0.52, atFloor: true });
    expect(atFloor.action).toBe("subir_pasos");
    expect(atFloor.why).toMatch(/suelo/);
    expect(E.weeklyDecision({ ...base, ratePct: -0.1, effectivePct: 0.52 }).action).toBe("bajar_kcal");
    // Demasiado rápido también se mide contra la real: 0,8 > 0,52 × 1,4.
    expect(E.weeklyDecision({ ...base, ratePct: -0.8, effectivePct: 0.52 }).action).toBe("subir_kcal");
  });

  it("semana de mantenimiento tras 8 semanas seguidas en déficit", () => {
    const base = { ratePct: -0.6, targetPct: 0.7, performance: "igual" as const, waistDeltaCm: -0.5, readinessAvg: 70, adherencePct: 90, stepsAvg: 10500, stepsGoal: 10000 };
    expect(E.weeklyDecision({ ...base, weeksInDeficit: 7 }).action).toBe("mantener");
    const r = E.weeklyDecision({ ...base, weeksInDeficit: 8 });
    expect(r.action).toBe("semana_mantenimiento");
    expect(r.why).toMatch(/8 semanas/);
    // La adherencia baja sigue mandando: primero se arregla eso.
    expect(E.weeklyDecision({ ...base, weeksInDeficit: 9, adherencePct: 60 }).action).toBe("arreglar_adherencia");
  });
});

describe("§2 · proteína", () => {
  it("escala con el déficit y se reparte por comida", () => {
    expect(E.proteinPerLeanKgFor(0)).toBe(2.3);
    expect(E.proteinPerLeanKgFor(15)).toBe(2.7);
    expect(E.proteinPerLeanKgFor(30)).toBe(3.1);
    expect(E.proteinPerLeanKgFor(45)).toBe(3.1);
    const p = E.planTargets({ ...alex, tdee: 2681, ratePctWeek: 0.7 });
    expect(p.proteinPerLeanKg).toBe(2.82); // déficit efectivo del 19 %
    expect(p.on.proteinG).toBe(188);
    expect(p).toMatchObject({ mealsPerDay: 4, proteinPerMealG: 47 });
    expect(E.planTargets({ ...alex, tdee: 2681, ratePctWeek: 0.7, mealsPerDay: 5 }).proteinPerMealG).toBe(38);
    // A mantenimiento, 2,3 g/kg (154 g). Con k fijado a mano, manda el fijado.
    expect(E.planTargets({ ...alex, tdee: 2929, ratePctWeek: 0 }).on.proteinG).toBe(154);
    expect(E.planTargets({ ...alex, tdee: 2681, ratePctWeek: 0.7, proteinPerLeanKg: 2.6 }).on.proteinG).toBe(174);
  });
});

describe("§3 · composición", () => {
  it("la bioimpedancia (InBody) entra como «bia» con ±4 puntos", () => {
    const c = E.bodyComposition({ kg: 90.07, heightCm: 174, waistCm: 100.5, sex: "H", measuredBfPct: 25.8, measuredMethod: "inbody" });
    expect(c).toMatchObject({ method: "bia", marginPts: 4, bfPct: 25.8, leanKg: 66.8 });
    expect(E.measuredBfMethod("InBody 270")).toBe("bia");
    expect(E.measuredBfMethod("tanita")).toBe("bia");
    expect(E.measuredBfMethod("dexa")).toBe("medido");
    expect(E.measuredBfMethod(null)).toBe("medido");
    expect(E.bodyComposition({ kg: 90, heightCm: 174, sex: "H", measuredBfPct: 20, measuredMethod: "dexa" })).toMatchObject({ method: "medido", marginPts: 2 });
  });
});

describe("§4 · ritmo, carga, descarga y volumen", () => {
  it("ritmo 0,7 % y zona de pico extremo por encima de 2,0", () => {
    expect(E.targetRatePct(90.07, 84)).toBe(0.7);
    expect(E.targetRatePct(86, 84)).toBe(0.5);
    expect(E.acwrZone(1.4)).toBe("precaucion");
    expect(E.acwrZone(1.8)).toBe("pico");
    expect(E.acwrZone(2)).toBe("pico");
    expect(E.acwrZone(2.1)).toBe("pico_extremo");
  });

  it("sueño corto y dolor tendinoso son señales de descarga, y siguen haciendo falta dos", () => {
    const calm = { e1rmDropping: false, readiness7dAvg: 65, maxWeeklyStress: 18, acwrRatio: 1.1 };
    expect(E.deloadDecision({ ...calm, shortSleepNights: 3 })).toMatchObject({ deload: false, signals: ["3 de las últimas 7 noches por debajo de 7 h"] });
    expect(E.deloadDecision({ ...calm, shortSleepNights: 2 }).signals).toEqual([]);
    expect(E.deloadDecision({ ...calm, tendonPain: 5 }).signals).toEqual([]);
    expect(E.deloadDecision({ ...calm, tendonPain: 6 }).signals).toEqual(["Dolor tendinoso de 6/10"]);
    expect(E.deloadDecision({ ...calm, shortSleepNights: 4, tendonPain: 6 }).deload).toBe(true);
    expect(E.deloadDecision({ ...calm, acwrRatio: 2.3, shortSleepNights: 3 }).deload).toBe(true);
    expect(E.deloadDecision({ ...calm, acwrRatio: 2.3 }).signals[0]).toMatch(/extremo/);
  });

  it("en déficit las series semanales se congelan en 12-16", () => {
    expect(E.weeklySetsRange(3)).toEqual([16, 20]);
    expect(E.weeklySetsRange(3, true)).toEqual([12, 16]);
    // Fuera de déficit, progresar el 70 % con margen sube series; en déficit, no.
    expect(E.volumeAdvice(0.8, "en_rango").action).toBe("subir");
    expect(E.volumeAdvice(0.8, "en_rango", { setsPerWeek: 14 }).action).toBe("mantener");
    expect(E.volumeAdvice(0.8, "en_rango", { setsPerWeek: 18 }).action).toBe("bajar");
    expect(E.volumeAdvice(null, "bajo_mev", { setsPerWeek: 4 }).action).toBe("subir");
    expect(E.volumeAdvice(0.2, "en_rango", { setsPerWeek: 14 }).action).toBe("revisar");
  });
});

describe("pendientes del cruce", () => {
  const rx: E.Prescription = { sets: 3, repMin: 8, repMax: 10, rirTarget: 1, step: 2.5, kind: "compuesto" };
  const ses = (date: string, ...s: E.SetLog[]): E.PastSession => ({ date, sets: s });
  const top = [ses("2026-11-18", { kg: 100, reps: 10, rir: 1 }, { kg: 100, reps: 10, rir: 1 }, { kg: 100, reps: 10, rir: 1 })];
  const mid = [ses("2026-11-18", { kg: 100, reps: 9, rir: 1 }, { kg: 100, reps: 9, rir: 1 }, { kg: 100, reps: 8, rir: 1 })];

  it("cintura objetivo: con 174 cm, 87 cm para quedar en 0,50 (88 cm da 0,506)", () => {
    expect(E.waistForWhtr(174)).toBe(87);
    expect(87 / 174).toBeLessThanOrEqual(0.5);
    expect(88 / 174).toBeGreaterThan(0.5);
    expect(E.waistForWhtr(180)).toBe(90);
    expect(E.bodyComposition({ kg: 90.07, heightCm: 174, waistCm: 100.5, sex: "H", measuredBfPct: 25.8, measuredMethod: "inbody" }).whtrTargetWaistCm).toBe(87);
  });

  it("en déficit, los compuestos van con un RIR más; los aislamientos no", () => {
    const normal = E.suggestNext(mid, rx);
    const cut = E.suggestNext(mid, rx, { inDeficit: true });
    expect(normal).toMatchObject({ rule: "sumar_rep", rirTarget: 1 });
    expect(cut).toMatchObject({ rule: "sumar_rep", kg: 100, rirTarget: 2 });
    expect(cut.why).toMatch(/En déficit/);
    expect(E.suggestNext(mid, { ...rx, kind: "aislamiento" }, { inDeficit: true }).rirTarget).toBe(1);
    // Con readiness bajo ya va con +1: no se suma otro.
    expect(E.suggestNext(mid, rx, { inDeficit: true, readiness: 45 })).toMatchObject({ rule: "readiness_bajo", rirTarget: 2 });
    // En descarga manda la descarga (+2).
    expect(E.suggestNext(mid, rx, { inDeficit: true, deload: true }).rirTarget).toBe(3);
  });

  it("tobillo: si a la mañana siguiente duele más que antes, la próxima pierna no progresa", () => {
    expect(E.ankleRule(1, 2, 1)).toMatchObject({ restricted: false });
    expect(E.ankleRule(1, 2, 1).holdProgression).toMatch(/2\/10.*1\/10/);
    expect(E.ankleRule(1, 2, 1).notes.join(" ")).toMatch(/sin progresar/);
    expect(E.ankleRule(1, 1, 1).holdProgression).toBeNull();
    expect(E.ankleRule(1, 2, null).holdProgression).toBeNull(); // sin dato de antes no se juzga
    // El freno convierte subir carga o sumar rep en repetir.
    const hold = "El tobillo dolió más a la mañana siguiente.";
    expect(E.suggestNext(top, rx).rule).toBe("subir_carga");
    expect(E.suggestNext(top, rx, { holdProgression: hold })).toMatchObject({ rule: "repetir", kg: 100, repsTarget: [10, 10, 10] });
    expect(E.suggestNext(mid, rx, { holdProgression: hold })).toMatchObject({ rule: "repetir", kg: 100, repsTarget: [9, 9, 8] });
  });
});

describe("§5 · lo que el motor hacía mejor que el reglamento se mantiene", () => {
  it("cafeína 9 h, tobillo > 3 y descarga con dos señales", () => {
    expect(E.caffeineCutoff("23:00")).toBe("14:00"); // 9 h, no las 6 del reglamento
    expect(E.ankleRule(4).restricted).toBe(true); // tobillo > 3, no > 5
    expect(E.ankleRule(3).restricted).toBe(false);
    expect(E.deloadDecision({ e1rmDropping: true, readiness7dAvg: 70, maxWeeklyStress: 10, acwrRatio: 1 }).deload).toBe(false); // dos señales, no OR
  });
});
