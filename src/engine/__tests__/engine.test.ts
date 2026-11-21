import { describe, expect, it } from "vitest";
import * as E from "../index";

const set = (kg: number, reps: number, rir: number | null = 1): E.SetLog => ({ kg, reps, rir });
const day = (n: number) => new Date(Date.UTC(2026, 5, 1) + n * 86_400_000).toISOString().slice(0, 10);

describe("e1RM", () => {
  it("usa reps + RIR como repeticiones al fallo", () => {
    expect(E.estimate1RM(set(100, 5, 0))!.value).toBeCloseTo(116.667, 2);
    expect(E.estimate1RM(set(100, 8, 2))).toMatchObject({ confidence: "alta" });
    expect(E.estimate1RM(set(100, 8, 2))!.value).toBeCloseTo(133.333, 2);
  });
  it("Epley y Brzycki coinciden en 10 y se promedian hasta 15", () => {
    expect(E.epley(1, 10)).toBeCloseTo(E.brzycki(1, 10), 6);
    const e = E.estimate1RM(set(60, 12, 2))!;
    expect(e.value).toBeCloseTo(60 * ((1 + 14 / 30 + 36 / 23) / 2), 4);
    expect(e.confidence).toBe("media");
  });
  it("no estima por encima de 15 reps al fallo y baja la confianza lejos del fallo", () => {
    expect(E.estimate1RM(set(50, 15, 3))).toBeNull();
    expect(E.estimate1RM(set(100, 5, 5))!.confidence).toBe("baja");
    expect(E.estimate1RM(set(100, 5, null))!.confidence).toBe("baja");
    expect(E.estimate1RM(set(170, 1, 1))!.value).toBeCloseTo(170 * (1 + 2 / 30), 4);
  });
  it("una serie de hipertrofia ya da e1RM (la app antigua devolvía null)", () => {
    expect(E.bestE1RM([set(72, 12, 2), set(80, 11, 2)])).not.toBeNull();
  });
  it("invierte la fórmula para proponer carga", () => {
    expect(E.loadForTarget(133.333, 8, 2)).toBe(100);
    expect(E.loadForTarget(100, 20, 2)).toBeNull();
  });
  it("tabla RPE de la hoja de prescripción", () => {
    expect(E.pctFromRpe(5, 10)).toBe(86.3);
    expect(E.pctFromRpe(1, 9)).toBe(95.5);
    expect(E.pctFromRpe(12, 6.5)).toBe(58.6);
    expect(E.rirToRpe(2)).toBe(8);
  });
});

describe("progresión", () => {
  const rx: E.Prescription = { sets: 3, repMin: 8, repMax: 10, rirTarget: 1, step: 2.5, kind: "compuesto" };
  const ses = (d: number, ...s: E.SetLog[]): E.PastSession => ({ date: day(d), sets: s });

  it("sin historial pide elegir carga para el suelo del rango", () => {
    expect(E.suggestNext([], rx)).toMatchObject({ rule: "primera", kg: null, repsTarget: [8, 8, 8] });
  });
  it("techo del rango en todas las series → sube carga y vuelve al suelo", () => {
    const s = E.suggestNext([ses(7, set(100, 10), set(100, 10), set(100, 10))], rx);
    expect(s).toMatchObject({ rule: "subir_carga", kg: 102.5, repsTarget: [8, 8, 8] });
  });
  it("no sube si llegó al techo yendo mucho más allá del RIR pautado", () => {
    const rx2 = { ...rx, rirTarget: 2 };
    const s = E.suggestNext([ses(7, set(100, 10, 0), set(100, 10, 0), set(100, 10, 0))], rx2);
    expect(s.rule).toBe("sumar_rep");
  });
  it("dentro del rango → misma carga y una repetición más", () => {
    const s = E.suggestNext([ses(7, set(100, 10), set(100, 9), set(100, 8))], rx);
    expect(s).toMatchObject({ rule: "sumar_rep", kg: 100, repsTarget: [10, 10, 8] });
  });
  it("por debajo del suelo → repite; dos veces → baja un 5 %", () => {
    const low = ses(7, set(100, 6), set(100, 6), set(100, 5));
    expect(E.suggestNext([low, ses(0, set(100, 9), set(100, 8), set(100, 8))], rx).rule).toBe("repetir");
    expect(E.suggestNext([low, ses(0, set(100, 7), set(100, 6), set(100, 6))], rx)).toMatchObject({ rule: "bajar_carga", kg: 95 });
  });
  it("aislamiento sube al menos un salto real de la máquina", () => {
    const iso: E.Prescription = { sets: 3, repMin: 12, repMax: 15, rirTarget: 1, step: 1, kind: "aislamiento" };
    expect(E.suggestNext([ses(7, set(12, 15), set(12, 15), set(12, 15))], iso).kg).toBe(13);
    const iso2 = { ...iso, step: 2.5 };
    expect(E.suggestNext([ses(7, set(5, 15), set(5, 15), set(5, 15))], iso2).kg).toBe(7.5);
  });
  it("descarga: menos series, misma carga, más reserva", () => {
    const s = E.suggestNext([ses(7, set(100, 9), set(100, 9), set(100, 8))], rx, { deload: true });
    expect(s).toMatchObject({ rule: "descarga", kg: 100, sets: 2, rirTarget: 3 });
  });
  it("readiness manda sobre la subida", () => {
    const h = [ses(7, set(100, 10), set(100, 10), set(100, 10))];
    expect(E.suggestNext(h, rx, { readiness: 45 })).toMatchObject({ rule: "readiness_bajo", kg: 100, rirTarget: 2 });
    expect(E.suggestNext(h, rx, { readiness: 20 })).toMatchObject({ rule: "solo_z2", kg: null });
  });
  it("marca estancamiento a las tres sesiones iguales", () => {
    const same = (d: number) => ses(d, set(100, 9), set(100, 8), set(100, 8));
    expect(E.suggestNext([same(14), same(7), same(0)], rx).stalled).toBe(true);
    expect(E.suggestNext([same(14), same(7)], rx).stalled).toBe(false);
  });
  it("calentamiento y discos", () => {
    expect(E.warmupLadder(100, "completo")).toEqual([{ kg: 30, reps: 10 }, { kg: 55, reps: 6 }, { kg: 80, reps: 3 }, { kg: 90, reps: 1 }]);
    expect(E.warmupLadder(100, "no")).toEqual([]);
    expect(E.platesPerSide(100)).toMatchObject({ plates: [25, 15], exact: true });
    expect(E.platesPerSide(121).exact).toBe(false);
  });
  it("tasa de progreso entre sesiones", () => {
    const up = { last: ses(7, set(100, 10)), prev: ses(0, set(100, 9)) };
    const flat = { last: ses(7, set(50, 10)), prev: ses(0, set(50, 10)) };
    expect(E.progressRate([up, flat])).toBe(0.5);
  });
});

describe("carga y ACWR (el fallo de la app antigua)", () => {
  const every = (from: number, to: number, load: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ date: day(from + i), load }));

  it("carga constante → ratio 1", () => {
    const r = E.acwr(every(0, 59, 500), day(59));
    expect(r.ratio).toBeCloseTo(1, 2);
    expect(r.zone).toBe("optimo");
    expect(r.reliable).toBe(true);
  });
  it("las sesiones envejecen: tras 14 días parado la aguda se hunde", () => {
    const r = E.acwr(every(0, 27, 500), day(41));
    expect(r.acute).toBeLessThan(15);
    expect(r.chronic).toBeGreaterThan(150);
    expect(r.zone).toBe("subcarga");
  });
  it("detecta un pico de carga", () => {
    const r = E.acwr([...every(0, 27, 300), ...every(28, 34, 1000)], day(34));
    expect(r.ratio!).toBeGreaterThan(1.5);
    expect(r.zone).toBe("pico");
  });
  it("sin 21 días de historial no da ratio", () => {
    const r = E.acwr(every(0, 9, 500), day(9));
    expect(r.ratio).toBeNull();
    expect(r.reliable).toBe(false);
  });
  it("los días sin sesión cuentan como cero y dos sesiones el mismo día se suman", () => {
    expect(E.dailyLoads([{ date: day(0), load: 400 }, { date: day(0), load: 100 }, { date: day(3), load: 300 }], day(0), day(4))).toEqual([500, 0, 0, 300, 0]);
  });
  it("EWMA con λ = 2/(N+1)", () => {
    expect(E.ewma([100, 0], 7)[1]).toBeCloseTo(75, 6);
    expect(E.ewma([100, 0], 28)[1]).toBeCloseTo(100 * (27 / 29), 6);
  });
  it("descriptores: tonelaje, NL, IMR y estrés", () => {
    const s = [set(100, 5), set(100, 5)];
    expect(E.tonnage(s)).toBe(1000);
    expect(E.liftCount(s)).toBe(10);
    expect(E.meanRelativeIntensity(s, 125)).toBeCloseTo(0.8, 6);
    expect(E.setStress(0)).toBeCloseTo(1.6, 6);
    expect([0, 1, 2, 3, 4].map((r) => E.setStress(r))).toEqual([1.6, 1.2, 1.0, 0.8, 0.6]);
    expect(E.setStress(0.5)).toBe(1.4);
    expect(E.setStress(6)).toBeCloseTo(0.2, 6);
    expect(E.weeklyStress(Array(20).fill(set(50, 10, 0))).band).toBe("duro");
    expect(E.weeklyStress(Array(18).fill(set(50, 10, 1))).band).toBe("medio");
    expect(E.weeklyStress(Array(10).fill(set(50, 10, 1))).band).toBe("ligero");
    expect(E.sessionStress([set(50, 10, 1), set(50, 10, 1), set(50, 10, 0)])).toEqual({ value: 4, band: "medio" });
    expect(E.sessionLoad(7, 85)).toBe(595);
  });
});

describe("volumen", () => {
  it("repeticiones efectivas: las 5 últimas antes del fallo", () => {
    expect(E.effectiveReps(10, 1)).toBe(4);
    expect(E.effectiveReps(3, 0)).toBe(3);
    expect(E.effectiveReps(10, 6)).toBe(0);
  });
  it("series fraccionales por grupo y solo las efectivas", () => {
    const v = E.hardSetsByMuscle([
      { primary: "pectoral", secondary: ["triceps", "deltoides_anterior"], sets: [set(100, 8, 1), set(100, 8, 1), set(60, 10, 5)] },
      { primary: "triceps", sets: [set(30, 12, 1)] },
    ]);
    expect(v).toEqual({ pectoral: 2, triceps: 2, deltoides_anterior: 1 });
  });
  it("estado frente a MEV/MRV y consejo de volumen", () => {
    expect(E.volumeStatus(8, 10, 20)).toBe("bajo_mev");
    expect(E.volumeStatus(14, 10, 20)).toBe("en_rango");
    expect(E.volumeStatus(19, 10, 20)).toBe("cerca_mrv");
    expect(E.volumeStatus(22, 10, 20)).toBe("sobre_mrv");
    expect(E.volumeAdvice(0.8, "en_rango").action).toBe("subir");
    expect(E.volumeAdvice(0.3, "en_rango").action).toBe("revisar");
    expect(E.junkSetsInSession(14)).toBe(4);
    expect(E.weeklyEquivalentSets(48, 14)).toBe(24);
    expect(E.weeklyEquivalentSets(18, 9)).toBe(14);
    expect(E.LEVEL_WEEKLY_SETS[2]).toEqual([10, 16]);
  });
  it("REF del Excel: 130 kg × 3 con 1RM 140 = 0,42", () => {
    expect(E.refIndex(130, 3, 140)).toBeCloseTo(0.42, 6);
    expect(E.refIndex(140, 1, 140)).toBeNull();
    expect(E.refSessionBand(0.42)).toBe("bueno_recuperable");
    expect(E.refWeekBand(4.7)).toBe("no_sostenible");
  });
  it("ratio estímulo-fatiga con los coeficientes de la hoja oculta", () => {
    const sets = [set(100, 8, 1), set(100, 8, 1), set(100, 8, 1)];
    const squat = E.stimulusFatigue(sets, { base: 1.5, stability: "bilateral_libre", resistance: "constante" });
    const machine = E.stimulusFatigue(sets, { base: 1, stability: "bilateral_guiado", resistance: "variable" });
    expect(squat.stimulus).toBe(12);
    expect(squat.fatigue).toBeCloseTo(4.95, 6);
    expect(machine.sfr!).toBeGreaterThan(squat.sfr!);
  });
});

describe("recuperación", () => {
  it("readiness con la fórmula heredada", () => {
    expect(E.readiness({ sueno: 7, estres: 4, motiv: 7, dolor: 2, fatiga: 4 })).toBe(68);
    expect(E.readinessBand(68).band).toBe("mas_rir");
    expect(E.readinessBand(25).band).toBe("z2");
  });
  it("recuperación Gorilangel: el ejemplo del Excel da 73", () => {
    expect(E.recoveryGorilangel({ fatiga: 10, recuperacion: 10, agujetas: 1, rindeMas: true, duermeBien: false, calidadSueno: 7, energia: 10, libido: 10 })).toBe(73);
  });
  it("Hooper y línea base propia", () => {
    expect(E.hooper(6, 6, 5, 4)).toEqual({ total: 21, high: true });
    expect(E.baselineDelta(50, [70, 72, 68])).toBeNull();
    expect(E.baselineDelta(50, [70, 72, 68, 70, 71, 69, 70])!.z).toBeLessThan(-2);
  });
  it("POMS: los 52 ítems están en una sola escala", () => {
    const all = Object.values(E.POMS_MAP).flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
    expect(E.POMS_ITEMS).toHaveLength(52);
    expect(E.POMS_MAP.vigor.map((n) => E.POMS_ITEMS[n - 1])).toContain("Vigoroso");
    expect(E.POMS_MAP.fatiga.map((n) => E.POMS_ITEMS[n - 1])).toContain("Cansado");
  });
  it("POMS: puntuación, TMD y forma del perfil", () => {
    const zero = E.scorePoms(Array(52).fill(0));
    expect(zero.tension).toBe(4); // «Relajado» va invertido
    expect(zero.tmd).toBe(4);
    const good = Array(52).fill(0);
    E.POMS_MAP.vigor.forEach((n) => (good[n - 1] = 4));
    good[18] = 4;
    expect(E.scorePoms(good)).toMatchObject({ vigor: 36, tmd: -36, shape: "iceberg" });
    const bad = Array(52).fill(3);
    E.POMS_MAP.vigor.forEach((n) => (bad[n - 1] = 0));
    expect(E.scorePoms(bad).shape).toBe("invertido");
    expect(() => E.scorePoms([1, 2])).toThrow();
  });
  it("descarga con dos señales; exámenes solos = mantenimiento", () => {
    expect(E.deloadDecision({ e1rmDropping: true, readiness7dAvg: 60, maxWeeklyStress: 20, acwrRatio: 1.1 }).deload).toBe(false);
    expect(E.deloadDecision({ e1rmDropping: true, readiness7dAvg: 45, maxWeeklyStress: 20, acwrRatio: 1.1 }).deload).toBe(true);
    expect(E.deloadDecision({ e1rmDropping: false, readiness7dAvg: 65, maxWeeklyStress: 10, acwrRatio: 1, externalStress: true })).toMatchObject({ deload: false, maintenance: true });
  });
  it("regla del tobillo", () => {
    expect(E.ankleRule(5)).toMatchObject({ restricted: true, impactAllowed: false, squatCapPct: 75, z2Modes: ["bici", "elíptica"] });
    expect(E.ankleRule(1, 5)).toMatchObject({ restricted: true, dropTopSet: true });
    expect(E.ankleRule(0, 0)).toMatchObject({ restricted: false, impactAllowed: true, squatCapPct: null });
  });
});

describe("nutrición", () => {
  it("Mifflin y composición por perímetros", () => {
    expect(E.mifflin(92, 174, 22, "H")).toBeCloseTo(1902.5, 6);
    expect(E.relativeFatMass(100, 174, "H")).toBeCloseTo(29.2, 6);
    expect(E.navyBodyFatMale(100, 40, 174)!).toBeCloseTo(26.2, 0);
    const c = E.bodyComposition({ kg: 92, heightCm: 174, waistCm: 100, sex: "H" });
    expect(c).toMatchObject({ method: "rfm", bfPct: 29.2, waistToHeight: 0.57 });
    expect(c.leanKg).toBeCloseTo(65.1, 1);
    expect(E.bodyComposition({ kg: 92, heightCm: 174, waistCm: 100, neckCm: 40, sex: "H" }).method).toBe("navy");
  });
  it("reparto On/Off sin cambiar el total semanal", () => {
    const p = E.planTargets({ kg: 92, leanKg: 66, tdee: 3000, ratePctWeek: 0.5, trainDaysPerWeek: 5 });
    const deficit = (92 * 0.005 * 7700) / 7;
    expect(p.deficitKcal).toBe(Math.round(deficit));
    expect(p.capped).toBe(false);
    expect(Math.abs(p.weeklyKcal - 7 * (3000 - deficit))).toBeLessThan(6);
    expect(p.on.kcal - p.off.kcal).toBeCloseTo(0.12 * p.avgKcal, -1);
    expect(p.on.proteinG).toBe(182);
    expect(p.off.proteinG).toBe(p.on.proteinG);
    expect(p.on.fatG).toBe(74);
    expect(p.on.carbG).toBeGreaterThan(p.off.carbG);
    expect(p.on.proteinG * 4 + p.on.fatG * 9 + p.on.carbG * 4).toBeCloseTo(p.on.kcal, -1);
    expect(p.on.intraCarbG![0]).toBeLessThan(p.on.intraCarbG![1]);
  });
  it("recorta el déficit al 25 % del gasto y no baja de 24 kcal por kg", () => {
    const noFloor = E.planTargets({ kg: 92, leanKg: 66, tdee: 2400, ratePctWeek: 1, trainDaysPerWeek: 5, floorKcalPerKg: 0 });
    expect(noFloor).toMatchObject({ capped: true, floored: false, avgKcal: 1800 });
    const p = E.planTargets({ kg: 92, leanKg: 66, tdee: 2400, ratePctWeek: 1, trainDaysPerWeek: 5 });
    expect(p).toMatchObject({ floored: true, avgKcal: 2208 });
    expect(p.warnings.join(" ")).toMatch(/24 kcal por kg/);
    expect(E.maxRateByBodyFat(29)).toBe(1);
    expect(E.maxRateByBodyFat(12)).toBe(0.6);
  });
  it("ritmo objetivo: más rápido lejos del objetivo", () => {
    expect(E.targetRatePct(92, 84)).toBe(0.7);
    expect(E.targetRatePct(87, 84)).toBe(0.5);
    expect(E.targetRatePct(84, 84)).toBe(0);
  });
  it("tendencia de peso y gasto medido", () => {
    const pts = Array.from({ length: 29 }, (_, i) => ({ date: day(i), kg: 92 - i * 0.1 }));
    const rate = E.weeklyRatePct(pts)!;
    expect(rate).toBeLessThan(-0.5);
    expect(rate).toBeGreaterThan(-0.9);
    expect(E.weeklyRatePct(pts.slice(0, 3))).toBeNull();
    expect(E.adaptiveTdee({ intakeAvgKcal: 2500, trendStartKg: 92, trendEndKg: 91, days: 14 })).toBe(3050);
    expect(E.adaptiveTdee({ intakeAvgKcal: 2500, trendStartKg: 92, trendEndKg: 91, days: 7 })).toBeNull();
  });
  it("decisión semanal cruzando señales", () => {
    const base = { targetPct: 0.8, performance: "igual" as const, waistDeltaCm: 0, readinessAvg: 65, adherencePct: 90, stepsAvg: 10500, stepsGoal: 10000 };
    expect(E.weeklyDecision({ ...base, ratePct: -0.7 }).action).toBe("mantener");
    expect(E.weeklyDecision({ ...base, ratePct: -0.7, adherencePct: 60 }).action).toBe("arreglar_adherencia");
    expect(E.weeklyDecision({ ...base, ratePct: -0.2, stepsAvg: 7000 }).action).toBe("subir_pasos");
    expect(E.weeklyDecision({ ...base, ratePct: -0.2 }).action).toBe("bajar_kcal");
    expect(E.weeklyDecision({ ...base, ratePct: -0.2, waistDeltaCm: -0.8 }).action).toBe("mantener");
    expect(E.weeklyDecision({ ...base, ratePct: -1.4 }).action).toBe("subir_kcal");
    expect(E.weeklyDecision({ ...base, ratePct: -0.7, performance: "baja", readinessAvg: 42 }).action).toBe("semana_mantenimiento");
  });
  it("cafeína y comida", () => {
    expect(E.caffeineCutoff("00:30")).toBe("15:30");
    expect(E.caffeineCutoff("23:00", 8)).toBe("15:00");
    expect(E.caffeineMaxMg(92)).toBe(275);
    expect(E.scaleMacros({ kcal: 110, protein: 23, carbs: 0, fat: 2 }, 250)).toEqual({ kcal: 275, protein: 57.5, carbs: 0, fat: 5 });
    expect(E.proteinPerEuro({ kcal: 110, protein: 23, carbs: 0, fat: 2 }, 7)).toBeCloseTo(32.86, 1);
    expect(E.kcalFromKj(418.4)).toBeCloseTo(100, 6);
  });
});

describe("cardio", () => {
  it("tabla ESEN: 40 años y 65 ppm en reposo", () => {
    expect(E.hrMaxTanaka(40)).toBe(180);
    expect(E.karvonen(180, 65, 1)).toBe(180);
    expect(E.karvonen(180, 65, 0.65)).toBe(140);
  });
  it("zonas contiguas y clasificación", () => {
    const z = E.hrZones(22, 60);
    expect(z).toHaveLength(5);
    expect(z[1].from).toBe(z[0].to);
    expect(E.zoneOf(z[1].from + 2, 22, 60)).toBe(2);
    expect(E.zoneOf(50, 22, 60)).toBe(0);
    expect(E.ecos(40, 2)).toBe(80);
    expect(E.ecos(40, 2, "bici")).toBe(40);
    expect(E.ecos(20, 5, "carrera")).toBe(120);
    expect(E.ecos(10, 4, "bici", 2)).toBe(40);
    expect(E.strengthEnduranceRatio(5, 1)).toEqual({ ratio: 5, ok: true });
    expect(E.strengthEnduranceRatio(3, 3).ok).toBe(false);
    expect(E.stepsGoal(false)).toBe(12000);
  });
});

describe("valoración", () => {
  it("perfil carga-velocidad: reproduce los resultados de la hoja", () => {
    const squat = E.oneRmFromVelocity([75, 80, 85, 90, 95].map((kg, i) => ({ kg, v: [0.6, 0.55, 0.5, 0.45, 0.4][i] })), E.MVT.squat)!;
    expect(squat.oneRm).toBeCloseTo(103, 6);
    expect(squat.quality).toBe("preciso");
    const bench = E.oneRmFromVelocity([80, 85, 90, 95, 100].map((kg, i) => ({ kg, v: [0.43, 0.39, 0.36, 0.32, 0.27][i] })), E.MVT.bench)!;
    expect(bench.oneRm).toBeCloseTo(111.0256, 2);
    expect(bench.r2).toBeCloseTo(0.99282, 4);
  });
  it("nivel de entrenamiento por fuerza relativa", () => {
    expect(E.liftLevel("H", "squat", 170, 92)).toBe(2);
    expect(E.liftLevel("H", "bench", 105, 92)).toBe(1);
    expect(E.liftLevel("H", "squat", 170, 84)).toBe(3);
    const l = E.trainingLevel({ sex: "H", bodyKg: 92, years: 3, technique: 3, progress: 2, education: 4, lifts: { squat: 170, bench: 105 } });
    expect(l.strength).toBe(2);
    expect(l.label).toBe("Avanzado");
  });
});
