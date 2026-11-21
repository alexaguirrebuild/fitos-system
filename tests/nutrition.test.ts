import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { adaptiveTdee, caffeineMaxMg, mifflin, ratePctFromDeficit, weightTrend } from "@/engine/nutrition";
import {
  buildShoppingList, deleteFoodLog, getDayType, getNutritionDay, getTargets, listMealTemplates, logCaffeine, logFood, logMealTemplate, recalcTargets,
  repeatMeal, saveMealTemplate, setDayType, updateFoodLog, weeklyNutritionReview,
} from "@/server/services/nutrition";
import { addDays } from "@/server/time";

/** Martes. Todas las fechas de los tests son fijas y pasadas: no dependen del día en que se ejecuten. */
const D = "2026-10-20";

let db: Db;
/** Calibración: pocas pesadas. Altura sin confirmar. */
let cal: string;
/** Dos semanas de comida y pesadas: gasto medido. */
let med: string;
/** Sin altura: no se puede calcular. */
let bare: string;
const food: Record<string, string> = {};

const count = async (userId: string, table: string) =>
  (await withUser(userId, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from fit.${table}`), db))[0].n;

beforeAll(async () => {
  db = await openMemoryDb();
  const rows = await asSystem((tx) => tx.query<{ id: string }>(
    `insert into fit.athletes (email, sex, birth_date, height_cm, height_confirmed, bedtime, wake_time, goal_weight_kg, adhd_medication) values
       ('cal@test.local', 'H', '2004-05-10', 174, false, '23:30', '07:30', 80, null),
       ('med@test.local', 'H', '2004-05-10', 174, true, '23:30', '07:30', 80, false),
       ('bare@test.local', 'H', '2004-05-10', null, false, null, null, null, null)
     returning id`), db);
  [cal, med, bare] = rows.map((r) => r.id);

  const foods = await asSystem((tx) => tx.query<{ id: string; name: string }>(
    `insert into fit.foods (name, brand, barcode, store, category, source, kcal_100, protein_100, carbs_100, fat_100, serving_g, package_g, price_eur, price_checked_on) values
       ('Pechuga de pollo', 'Hacendado', '8480000000011', 'mercadona', 'proteina', 'catalogo', 110, 23, 0, 2, null, 1000, 6.50, current_date - 5),
       ('Huevos L', 'Hacendado', null, 'mercadona', 'proteina', 'catalogo', 150, 12.5, 0.7, 11, 60, 720, 2.40, current_date - 5),
       ('Arroz redondo', 'Hacendado', null, 'mercadona', 'hidrato', 'catalogo', 350, 7, 78, 0.9, null, 1000, 1.30, current_date - 5),
       ('Aceite de oliva', 'Hacendado', null, 'mercadona', 'grasa', 'catalogo', 900, 0, 0, 100, 10, 1000, 8.90, current_date - 5),
       ('Brócoli', null, null, 'mercadona', 'verdura', 'catalogo', 34, 2.8, 4, 0.4, null, 500, 1.60, current_date - 5),
       ('Plátano', null, null, 'mercadona', 'fruta', 'catalogo', 89, 1.1, 20, 0.3, 120, 1000, 1.90, current_date - 5),
       ('Pavo en lonchas', 'Dulano', null, 'lidl', 'proteina', 'catalogo', 105, 21, 1, 2, null, 400, null, null),
       ('Pasta', 'Combino', null, 'lidl', 'hidrato', 'catalogo', 355, 12, 72, 1.5, null, 500, 0.85, current_date - 200)
     returning id, name`), db);
  for (const f of foods) food[f.name] = f.id;

  // cal: tres pesadas y cintura + cuello.
  await withUser(cal, (tx) => tx.query(
    `insert into fit.body_metrics (date, weight_kg, waist_cm, neck_cm) values
       ($1::date - 6, 92.6, null, null), ($1::date - 3, 92.2, null, null), ($1::date, 92.0, 100, 40)`, [D]), db);

  // med: 15 pesadas seguidas bajando 0,1 kg al día y 14 días con 2.400 kcal anotadas.
  await withUser(med, async (tx) => {
    for (let k = 14; k >= 0; k--)
      await tx.query("insert into fit.body_metrics (date, weight_kg, waist_cm, neck_cm) values ($1::date, $2, $3, $4)", [addDays(D, -k), Math.round((92 - 0.1 * (14 - k)) * 10) / 10, k === 0 ? 98 : null, k === 0 ? 40 : null]);
    for (let k = 13; k >= 0; k--)
      await tx.query("insert into fit.food_logs (date, meal, description, kcal, protein_g, carbs_g, fat_g, estimated) values ($1::date, 'comida', 'día entero', 2400, 160, 280, 70, true)", [addDays(D, -k)]);
  }, db);
});
afterAll(async () => db.close());

describe("recalcTargets", () => {
  it("sin altura devuelve lo que falta y no escribe", async () => {
    const r = await recalcTargets(bare, { date: D }, db);
    expect(r).toMatchObject({ ok: false, missing: ["peso", "altura"] });
    expect(await count(bare, "nutrition_targets")).toBe(0);
  });

  it("fase de calibración: Mifflin × 1,55 a mantenimiento, repartido On/Off", async () => {
    const r = await recalcTargets(cal, { date: D }, db);
    if (!r.ok) throw new Error("debería calcular");
    const kg = Math.round(weightTrend([{ date: addDays(D, -6), kg: 92.6 }, { date: addDays(D, -3), kg: 92.2 }, { date: D, kg: 92.0 }])[2].trend * 10) / 10;
    expect(r.weightKg).toBe(kg);
    expect(r.target).toMatchObject({ phase: "calibracion", tdeeMethod: "mifflin", ratePctWeek: 0, tdee: Math.round(mifflin(kg, 174, 22, "H") * 1.55) });
    expect(r.target.avgKcal).toBe(r.target.tdee); // sin déficit
    expect(r.bodyFat.method).toBe("navy");
    expect(r.trainDaysPerWeek).toBe(5); // sin historia
    expect(r.calibration).toMatchObject({ loggedDays: 0, weighIns: 3, needDays: 12, needWeighIns: 8 });
    expect(r.warnings.join(" ")).toMatch(/Altura sin confirmar/);
    expect(r.explain.join(" ")).toMatch(/Fase de calibración/);
    expect(r.saved).toBe(true);
    expect(await count(cal, "nutrition_targets")).toBe(1);

    // Total semanal: 5 On + 2 Off suman la media × 7 (salvo redondeo), con el On por encima del Off y la misma proteína.
    expect(r.weeklyKcal).toBe(r.target.on.kcal * 5 + r.target.off.kcal * 2);
    expect(Math.abs(r.weeklyKcal - r.target.avgKcal * 7)).toBeLessThanOrEqual(7);
    expect(r.target.on.kcal).toBeGreaterThan(r.target.off.kcal);
    expect(r.target.on.kcal - r.target.off.kcal).toBeCloseTo(0.12 * r.target.avgKcal, -1);
    expect(r.target.on.proteinG).toBe(r.target.off.proteinG);
    expect(r.target.on.carbsG).toBeGreaterThan(r.target.off.carbsG);
  });

  it("no guarda fila nueva si no cambia nada relevante; con force sí", async () => {
    const again = await recalcTargets(cal, { date: addDays(D, 1) }, db);
    expect(again).toMatchObject({ ok: true, saved: false });
    expect(await count(cal, "nutrition_targets")).toBe(1);
    const forced = await recalcTargets(cal, { date: addDays(D, 1), force: true }, db);
    expect(forced).toMatchObject({ ok: true, saved: true });
    expect(await count(cal, "nutrition_targets")).toBe(2);
  });

  it("con 14 días de comida y pesadas: gasto medido y déficit hacia el peso objetivo", async () => {
    const r = await recalcTargets(med, { date: D }, db);
    if (!r.ok) throw new Error("debería calcular");
    const trend = weightTrend(Array.from({ length: 15 }, (_, k) => ({ date: addDays(D, k - 14), kg: Math.round((92 - 0.1 * k) * 10) / 10 })));
    const expected = adaptiveTdee({ intakeAvgKcal: 2400, trendStartKg: trend[0].trend, trendEndKg: trend[14].trend, days: 14 });
    expect(expected).toBeGreaterThan(2400); // bajando de peso, gasta más de lo que come
    expect(r.target).toMatchObject({ phase: "deficit", tdeeMethod: "medido", tdee: expected, ratePctWeek: 0.7 });
    expect(r.target.avgKcal).toBeLessThan(r.target.tdee);
    expect(r.explain.join(" ")).toMatch(/TDEE medido/);
    expect(r.warnings.join(" ")).not.toMatch(/Altura sin confirmar/);
    expect(r.calibration).toMatchObject({ loggedDays: 14, weighIns: 14 });
    expect(Math.abs(r.weeklyKcal - r.target.avgKcal * 7)).toBeLessThanOrEqual(7);
  });

  it("devuelve la tasa real, la proteína escalada con el déficit y su reparto por comida", async () => {
    const r = await recalcTargets(med, { date: D }, db);
    if (!r.ok) throw new Error("debería calcular");
    expect(r).toMatchObject({ mode: "definicion", requestedRatePct: 0.7, mealsPerDay: 4, floorKcal: Math.round(24 * r.weightKg) });
    expect(r.effectiveRatePct).toBeGreaterThan(0);
    expect(r.effectiveRatePct).toBeLessThanOrEqual(0.7);
    expect(r.proteinPerLeanKg).toBeGreaterThan(2.3);
    expect(r.target.on.proteinG).toBe(Math.round(r.target.leanKg! * r.proteinPerLeanKg));
    expect(r.proteinPerMealG).toBe(Math.round(r.target.on.proteinG / 4));
    expect(r.target.off.kcal).toBeGreaterThanOrEqual(r.floorKcal);
    const text = r.explain.join(" ");
    expect(text).toMatch(/Ritmo real/);
    expect(text).toMatch(new RegExp(`${String(r.proteinPerLeanKg).replace(".", ",")} g por kg de masa magra`));
    expect(text).toMatch(/tampoco el Off/);
    // Lo guardado lleva el k usado, no el 2,3 fijo.
    const k = await withUser(med, (tx) => tx.query<{ k: number }>("select protein_per_lean_kg as k from fit.nutrition_targets where valid_from = $1::date", [D]), db);
    expect(Number(k[0].k)).toBe(r.proteinPerLeanKg);
  });

  it("modo recomposición: el déficit medio no pasa de 500 kcal", async () => {
    const r = await recalcTargets(med, { date: D, mode: "recomposicion", force: true }, db);
    if (!r.ok) throw new Error("debería calcular");
    expect(r.mode).toBe("recomposicion");
    expect(r.target.tdee - r.target.avgKcal).toBeLessThanOrEqual(500);
    expect(r.target.reason).toMatch(/recomposicion/);
    // Vuelta al modo por defecto para el resto de pruebas.
    expect(await recalcTargets(med, { date: D, force: true }, db)).toMatchObject({ ok: true, mode: "definicion" });
  });
});

describe("logFood", () => {
  const day = "2026-10-22";

  it("por gramos: calcula los macros con el alimento", async () => {
    const r = await logFood(cal, { date: day, meal: "comida", foodId: food["Pechuga de pollo"], grams: 200 }, db);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.log).toMatchObject({ date: day, meal: "comida", foodName: "Pechuga de pollo", grams: 200, kcal: 220, proteinG: 46, carbsG: 0, fatG: 4, estimated: false, source: "app" });
    expect(r.day.totals).toEqual({ kcal: 220, proteinG: 46, carbsG: 0, fatG: 4 });
    expect(r.day.target).not.toBeNull();
  });

  it("por código de barras: resuelve en local, sin red", async () => {
    const noNet = async () => { throw new Error("no debería llamar a la red"); };
    const r = await logFood(cal, { date: day, meal: "cena", barcode: "8480000000011", grams: 100 }, db, noNet);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.log).toMatchObject({ kcal: 110, proteinG: 23, source: "barcode", estimated: false });
  });

  it("por macros directos: los guarda tal cual, como estimados", async () => {
    const r = await logFood(cal, { date: day, meal: "desayuno", description: "tostadas con aguacate", kcal: 430, proteinG: 12, carbsG: 45, fatG: 22 }, db);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.log).toMatchObject({ description: "tostadas con aguacate", kcal: 430, proteinG: 12, carbsG: 45, fatG: 22, estimated: true, foodId: null, grams: null });
    expect(r.day.totals).toEqual({ kcal: 760, proteinG: 81, carbsG: 45, fatG: 28 });
  });

  it("sin gramos ni macros no escribe y lo pide: no inventa calorías", async () => {
    const before = await count(cal, "food_logs");
    const onlyText = await logFood(cal, { date: day, description: "un plato de pasta" }, db);
    expect(onlyText.ok).toBe(false);
    if (!onlyText.ok) expect(onlyText.problems[0]).toMatch(/No se inventan calorías/);
    const noGrams = await logFood(cal, { date: day, foodId: food["Huevos L"] }, db);
    expect(noGrams.ok).toBe(false);
    if (!noGrams.ok) expect(noGrams.problems[0]).toMatch(/Faltan los gramos.*60 g/);
    expect((await logFood(cal, { date: day }, db)).ok).toBe(false);
    expect(await count(cal, "food_logs")).toBe(before);
    await expect(logFood(cal, { date: day, grams: -5, foodId: food["Huevos L"] }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });

  it("getNutritionDay junta registro, objetivo, resto y reparto por comidas", async () => {
    const d = await getNutritionDay(cal, { date: day }, db);
    expect(d.logs).toHaveLength(3);
    expect(d.totals).toEqual({ kcal: 760, proteinG: 81, carbsG: 45, fatG: 28 });
    expect(d.dayType).toBe("off"); // día pasado sin sesión
    expect(d.target).not.toBeNull();
    expect(d.remaining).toEqual({ kcal: d.target!.kcal - 760, proteinG: d.target!.proteinG - 81, carbsG: d.target!.carbsG - 45, fatG: d.target!.fatG - 28 });
    expect(d.byMeal.comida).toMatchObject({ kcal: 220, items: 1 });
    expect(d.byMeal.desayuno).toMatchObject({ kcal: 430, items: 1 });
    expect(d.proteinPct).toBe(Math.round((81 / d.target!.proteinG) * 100));
    expect(d.steps).toEqual({ goal: 12000, done: null }); // día Off: 10.000 + 2.000
    // Medicación para el TDAH sin confirmar: no se da tope de cafeína.
    expect(d.caffeine.cutoff).toBe("14:30");
    expect(d.caffeine.maxMg).toBeNull();
    expect(d.caffeine.note).toMatch(/médico/);
  });

  it("editar, repetir y borrar recalculan el día", async () => {
    const d = await getNutritionDay(cal, { date: day }, db);
    const pollo = d.logs.find((l) => l.meal === "comida")!;
    const up = await updateFoodLog(cal, { logId: pollo.id, grams: 150 }, db);
    expect(up.log).toMatchObject({ grams: 150, kcal: 165, proteinG: 34.5 });
    expect(up.day.totals.kcal).toBe(705);

    const rep = await repeatMeal(cal, { fromDate: day, meal: "comida", toDate: "2026-10-23" }, db);
    expect(rep).toMatchObject({ ok: true, copied: 1 });
    if (rep.ok) expect(rep.day.totals).toEqual({ kcal: 165, proteinG: 34.5, carbsG: 0, fatG: 3 });
    expect(await repeatMeal(cal, { fromDate: day, meal: "intra", toDate: "2026-10-23" }, db)).toMatchObject({ ok: false });

    const del = await deleteFoodLog(cal, { logId: pollo.id }, db);
    expect(del.day.totals.kcal).toBe(540);
    await expect(deleteFoodLog(cal, { logId: pollo.id }, db)).rejects.toMatchObject({ code: "no_encontrado" });
  });
});

describe("getTargets", () => {
  it("sin objetivos devuelve null y no escribe nada", async () => {
    const before = await count(bare, "nutrition_targets");
    expect(await getTargets(bare, { date: D }, db)).toBeNull();
    expect(await count(bare, "nutrition_targets")).toBe(before);
  });

  it("devuelve el vigente con sus frases, sin recalcular ni guardar", async () => {
    const saved = await recalcTargets(med, { date: D, force: true }, db);
    if (!saved.ok) throw new Error("debería calcular");
    const before = await count(med, "nutrition_targets");
    const r = await getTargets(med, { date: D }, db);
    expect(r).not.toBeNull();
    expect(r!.target).toMatchObject({ validFrom: D, phase: "deficit", tdeeMethod: "medido", on: saved.target.on, off: saved.target.off });
    const text = r!.explain.join(" ");
    expect(text).toMatch(/medido/);
    expect(text).toMatch(/Déficit/);
    expect(text).toMatch(/g por kg de masa magra/);
    expect(text).toMatch(/0,8 g por kg de peso/);
    expect(text).toMatch(/Día On/);
    expect(await count(med, "nutrition_targets")).toBe(before);
    // Un día anterior al primer objetivo: no hay vigente.
    expect(await getTargets(med, { date: addDays(D, -400) }, db)).toBeNull();
  });
});

describe("cola sin conexión", () => {
  it("logFood con el mismo clientId no vuelve a anotar y guarda la hora real", async () => {
    const loggedAt = "2026-10-23T11:05:00.000Z";
    const input = { date: "2026-10-23", meal: "comida" as const, foodId: food["Arroz redondo"], grams: 100, clientId: "f-1", loggedAt };
    const first = await logFood(cal, input, db);
    if (!first.ok) throw new Error(first.problems.join(" "));
    expect(first.log.loggedAt).toBe(loggedAt);
    expect(first.duplicate).toBeUndefined();
    const before = await count(cal, "food_logs");
    const again = await logFood(cal, { ...input, grams: 250 }, db);
    if (!again.ok) throw new Error(again.problems.join(" "));
    expect(again.duplicate).toBe(true);
    expect(again.log.id).toBe(first.log.id);
    expect(again.log.grams).toBe(100);
    expect(await count(cal, "food_logs")).toBe(before);
  });
});

describe("tipo de día", () => {
  it("On si hay sesión de pesas ese día; se puede forzar y volver a automático", async () => {
    const day = "2026-10-14";
    expect(await getDayType(cal, { date: day }, db)).toMatchObject({ dayType: "off", forced: false });
    await withUser(cal, (tx) => tx.query("insert into fit.workouts (date, status) values ($1::date, 'hecha')", [day]), db);
    expect(await getDayType(cal, { date: day }, db)).toMatchObject({ dayType: "on", basis: "sesion", assumed: false });
    expect(await setDayType(cal, { date: day, dayType: "off" }, db)).toMatchObject({ dayType: "off", forced: true, basis: "forzado" });
    expect((await getNutritionDay(cal, { date: day }, db)).steps.goal).toBe(12000);
    expect(await setDayType(cal, { date: day, dayType: "auto" }, db)).toMatchObject({ dayType: "on", forced: false });
    expect((await getNutritionDay(cal, { date: day }, db)).steps.goal).toBe(10000);
  });

  it("una fecha futura sin plan activo es Off supuesto", async () => {
    expect(await getDayType(cal, { date: "2099-01-01" }, db)).toMatchObject({ dayType: "off", assumed: true, basis: "sin_plan" });
  });

  it("día libre: se registra pero no se juzga (sin objetivo, restante ni déficit)", async () => {
    const day = "2026-10-24";
    expect(await setDayType(cal, { date: day, dayType: "libre" }, db)).toMatchObject({ dayType: "libre", forced: true, basis: "forzado" });
    const r = await logFood(cal, { date: day, meal: "comida", foodId: food["Pechuga de pollo"], grams: 200 }, db);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.day).toMatchObject({ free: true, target: null, remaining: null });
    const d = await getNutritionDay(cal, { date: day }, db);
    expect(d).toMatchObject({ dayFree: true, target: null, remaining: null, proteinPct: null, note: "Día libre: se registra, no se juzga." });
    expect(d.totals.kcal).toBe(220);
    expect(await setDayType(cal, { date: day, dayType: "auto" }, db)).toMatchObject({ dayType: "off", forced: false });
    const back = await getNutritionDay(cal, { date: day }, db);
    expect(back).toMatchObject({ dayFree: false, note: null });
    expect(back.target).not.toBeNull();
  });
});

describe("comidas ancla", () => {
  it("guarda la plantilla con sus totales y la anota de un toque", async () => {
    const t = await saveMealTemplate(med, {
      name: "Pollo con arroz", meal: "comida", dayType: "on",
      items: [{ foodId: food["Pechuga de pollo"], grams: 200 }, { foodId: food["Arroz redondo"], grams: 100 }],
    }, db);
    expect(t).toMatchObject({ kcal: 570, proteinG: 53, carbsG: 78, fatG: 4.9, costEur: 1.43 }); // 0,2 kg × 6,50 + 0,1 kg × 1,30
    expect(t.items.map((x) => x.name)).toEqual(["Pechuga de pollo", "Arroz redondo"]);
    expect(await listMealTemplates(med, { dayType: "off" }, db)).toEqual([]);
    expect(await listMealTemplates(med, { dayType: "on" }, db)).toHaveLength(1);

    const r = await logMealTemplate(med, { templateId: t.id, date: "2026-10-01" }, db);
    expect(r.logs.map((l) => [l.foodName, l.grams, l.source, l.meal])).toEqual([["Pechuga de pollo", 200, "plantilla", "comida"], ["Arroz redondo", 100, "plantilla", "comida"]]);
    expect(r.day.totals).toEqual({ kcal: 570, proteinG: 53, carbsG: 78, fatG: 4.9 });
  });
});

describe("cafeína", () => {
  it("marca la toma tras el corte (9 h antes de acostarse) y avisa", async () => {
    // Acostarse 23:30 → corte 14:30. En octubre Madrid va a +02:00.
    const early = await logCaffeine(med, { mg: 100, at: "2026-10-20T09:00:00+02:00", source: "café" }, db);
    expect(early.log.afterCutoff).toBe(false);
    expect(early.warnings).toEqual([]);

    const late = await logCaffeine(med, { mg: 150, at: "2026-10-20T16:00:00+02:00" }, db);
    expect(late.log.afterCutoff).toBe(true);
    expect(late.warnings[0]).toMatch(/corte de cafeína \(14:30\)/);
    expect(late.caffeine).toMatchObject({ cutoff: "14:30", todayMg: 250, lateDoses: 1, maxMg: caffeineMaxMg(90.6) });
    expect(late.caffeine.note).toBeUndefined(); // este atleta confirmó que no toma medicación

    // De madrugada (antes de levantarse a las 07:30) sigue contando como tarde.
    const night = await logCaffeine(med, { mg: 50, at: "2026-10-21T01:00:00+02:00" }, db);
    expect(night.log.afterCutoff).toBe(true);

    const day = await getNutritionDay(med, { date: D }, db);
    expect(day.caffeine).toMatchObject({ todayMg: 250, lateDoses: 1 });
  });

  it("con medicación sin confirmar solo registra: sin tope y con la nota", async () => {
    const r = await logCaffeine(cal, { mg: 900, at: "2026-10-20T09:00:00+02:00" }, db);
    expect(r.caffeine.maxMg).toBeNull();
    expect(r.caffeine.note).toMatch(/TDAH/);
    expect(r.warnings).toEqual([]);
  });
});

describe("lista de la compra", () => {
  const week = "2026-10-19";

  it("sin objetivos lo dice y no guarda", async () => {
    expect(await buildShoppingList(bare, { weekStart: week }, db)).toMatchObject({ ok: false });
    expect(await count(bare, "shopping_lists")).toBe(0);
  });

  it("con precios vigentes: cesta base por categorías, envases redondeados, total y presupuesto", async () => {
    const r = await buildShoppingList(cal, { weekStart: week, store: "mercadona", budgetEur: 500 }, db);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r).toMatchObject({ mode: "cesta_base", weekStart: week, store: "mercadona", days: { on: 5, off: 2, fromPlan: false }, missingPrices: [], overBudget: false });
    expect(new Set(r.lines.map((l) => l.category))).toEqual(new Set(["proteina", "hidrato", "grasa", "verdura", "fruta"]));
    for (const l of r.lines) {
      expect(l.packs).toBeGreaterThanOrEqual(1);
      expect(l.costEur).toBeGreaterThan(0);
    }
    const pollo = r.lines.find((l) => l.name === "Pechuga de pollo")!;
    expect(pollo.packs).toBe(Math.ceil(pollo.grams / 1000));
    expect(pollo.costEur).toBe(pollo.packs! * 6.5);
    expect(r.totalEur).toBeCloseTo(r.lines.reduce((s, l) => s + l.costEur!, 0), 2);
    // Cubre la proteína y se queda cerca de las kcal del objetivo.
    expect(r.perDay.proteinG).toBeGreaterThanOrEqual(r.perDay.targetProteinG * 0.75);
    expect(r.perDay.kcal).toBeGreaterThan(r.perDay.targetKcal * 0.8);
    expect(r.perDay.kcal).toBeLessThan(r.perDay.targetKcal * 1.2);

    const tight = await buildShoppingList(cal, { weekStart: week, store: "mercadona", budgetEur: 5 }, db);
    expect(tight).toMatchObject({ ok: true, overBudget: true });
    // Rehacer la lista de la misma semana y tienda sustituye la anterior.
    const saved = await withUser(cal, (tx) => tx.query<{ budget_eur: number; n: number }>("select budget_eur, jsonb_array_length(items)::int as n from fit.shopping_lists"), db);
    expect(saved).toEqual([{ budget_eur: 5, n: r.lines.length }]);
  });

  it("sin precios fechados: propone la cesta, lo dice y no inventa importes", async () => {
    const r = await buildShoppingList(cal, { weekStart: week, store: "lidl" }, db);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.lines.map((l) => l.name).sort()).toEqual(["Pasta", "Pavo en lonchas"]);
    expect(r.lines.every((l) => l.costEur === null)).toBe(true);
    expect(r.totalEur).toBeNull();
    expect(r.overBudget).toBe(false);
    expect(r.missingPrices.sort()).toEqual(["Pasta", "Pavo en lonchas"]); // sin precio y con precio de hace 200 días
    expect(r.notes.join(" ")).toMatch(/no hay importes/);
  });

  it("con comidas ancla, la lista sale de ellas", async () => {
    const r = await buildShoppingList(med, { weekStart: week }, db);
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.mode).toBe("comidas_ancla");
    // Plantilla de día On × 5: 1.000 g de pollo y 500 g de arroz.
    expect(r.lines.map((l) => [l.name, l.grams, l.packs, l.costEur])).toEqual([["Arroz redondo", 500, 1, 1.3], ["Pechuga de pollo", 1000, 1, 6.5]]);
    expect(r.totalEur).toBe(7.8);
  });
});

describe("revisión semanal", () => {
  it("sin pesadas suficientes mantiene, no propone nada y guarda la revisión", async () => {
    const r = await weeklyNutritionReview(cal, { weekStart: "2026-10-12" }, db);
    expect(r).toMatchObject({ weekStart: "2026-10-12", weekEnd: "2026-10-18", action: "mantener", proposal: null });
    expect(r.why).toMatch(/Faltan pesadas/);
    expect(r.data.daysCounted).toBe(0); // los objetivos de este atleta empiezan el 20
    const saved = await withUser(cal, (tx) => tx.query<{ action: string; week_start: string }>("select action, week_start from fit.weekly_reviews"), db);
    expect(saved).toEqual([{ action: "mantener", week_start: "2026-10-12" }]);
  });

  it("en calibración, aunque se cumpla todo, no se tocan las calorías", async () => {
    const off = (await getNutritionDay(cal, { date: "2026-11-02" }, db)).target!;
    await withUser(cal, async (tx) => {
      for (let k = 0; k < 7; k++)
        await tx.query("insert into fit.food_logs (date, meal, description, kcal, protein_g, carbs_g, fat_g) values ($1::date, 'comida', 'día clavado', $2, $3, $4, $5)", [addDays("2026-11-02", k), off.kcal, off.proteinG, off.carbsG, off.fatG]);
    }, db);
    const r = await weeklyNutritionReview(cal, { weekStart: "2026-11-02" }, db);
    expect(r.data).toMatchObject({ phase: "calibracion", adherencePct: 100, adherentDays: 7, daysCounted: 7 });
    expect(r.action).toBe("mantener");
    expect(r.why).toMatch(/calibración/);
    expect(r.proposal).toBeNull();
  });

  it("un día libre no cuenta para la adherencia pero sí para la media de kcal", async () => {
    await setDayType(cal, { date: "2026-11-04", dayType: "libre" }, db);
    await withUser(cal, (tx) => tx.query("update fit.food_logs set kcal = 3000 where date = '2026-11-04'"), db);
    const r = await weeklyNutritionReview(cal, { weekStart: "2026-11-02" }, db);
    expect(r.data).toMatchObject({ daysCounted: 6, freeDays: 1, adherentDays: 6, adherencePct: 100 });
    const avg = await withUser(cal, (tx) => tx.query<{ a: number }>(
      "select avg(k)::float as a from (select sum(kcal) as k from fit.food_logs where date between '2026-11-02' and '2026-11-08' group by date) x"), db);
    expect(r.data.avgKcal).toBe(Math.round(avg[0].a)); // los 3.000 kcal del día libre entran en la media
    await setDayType(cal, { date: "2026-11-04", dayType: "auto" }, db);
  });

  it("con dos semanas anotadas mide ritmo y adherencia y llama a la decisión del motor", async () => {
    await withUser(med, (tx) => tx.query(
      "insert into fit.daily_activity (date, steps) values ('2026-10-19', 6000), ('2026-10-20', 8000)"), db);
    const r = await weeklyNutritionReview(med, { weekStart: "2026-10-19" }, db);
    expect(r.data.phase).toBe("deficit");
    expect(r.data.targetPct).toBe(0.7);
    expect(r.data.ratePct).toBeLessThan(0);
    expect(r.data.stepsAvg).toBe(7000);
    expect(r.data.weighIns).toBe(2);
    expect(r.data.performance).toBe("igual");
    expect(r.data.adherencePct).not.toBeNull();
    expect(r.action).toBe(r.data.engineDecision.action);
    expect(["mantener", "arreglar_adherencia", "subir_pasos", "bajar_kcal", "subir_kcal", "semana_mantenimiento"]).toContain(r.action);
    expect(r.why.length).toBeGreaterThan(10);
    // Proponer no es aplicar: los objetivos siguen igual.
    expect(await count(med, "nutrition_targets")).toBe(1);
    // La semana se juzga contra el ritmo real del plan vigente (gasto − media), no solo contra el pedido.
    const t = (await getTargets(med, { date: D }, db))!.target;
    expect(r.data.effectivePct).toBe(ratePctFromDeficit(t.tdee - t.avgKcal, 90.6));
    expect(r.data).toMatchObject({ atFloor: false, weeksInDeficit: 0 });
  });

  it("tras 8 semanas seguidas en déficit propone una semana de mantenimiento, y el contador vuelve a empezar", async () => {
    const t = (await getTargets(med, { date: D }, db))!.target;
    // Un objetivo en déficit desde el 3 de agosto: del 3-ago al 4-oct van 9 semanas seguidas (fechas pasadas, para que cuente la adherencia).
    await withUser(med, (tx) => tx.query(
      `insert into fit.nutrition_targets (valid_from, phase, tdee, tdee_method, avg_kcal, rate_pct_week, on_kcal, on_protein_g, on_carbs_g, on_fat_g, off_kcal, off_protein_g, off_carbs_g, off_fat_g)
       values ('2026-08-03', 'deficit', $1, 'medido', $2, 0.7, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [t.tdee, t.avgKcal, t.on.kcal, t.on.proteinG, t.on.carbsG, t.on.fatG, t.off.kcal, t.off.proteinG, t.off.carbsG, t.off.fatG]), db);
    await withUser(med, async (tx) => {
      for (let k = 0; k < 7; k++)
        await tx.query("insert into fit.food_logs (date, meal, description, kcal, protein_g, carbs_g, fat_g) values ($1::date, 'comida', 'día clavado', $2, $3, $4, $5)",
          [addDays("2026-09-28", k), t.off.kcal, t.off.proteinG, t.off.carbsG, t.off.fatG]);
    }, db);
    const r = await weeklyNutritionReview(med, { weekStart: "2026-09-28" }, db);
    expect(r.data).toMatchObject({ phase: "deficit", weeksInDeficit: 9 });
    expect(r.data.adherencePct!).toBeGreaterThanOrEqual(80);
    expect(r.action).toBe("semana_mantenimiento");
    expect(r.why).toMatch(/9 semanas seguidas/);
    expect(r.proposal).not.toBeNull();
    // La semana siguiente cuenta desde la pausa propuesta.
    const next = await weeklyNutritionReview(med, { weekStart: "2026-10-05" }, db);
    expect(next.data.weeksInDeficit).toBe(1);
    expect(next.action).not.toBe("semana_mantenimiento");
    await withUser(med, (tx) => tx.query("delete from fit.nutrition_targets where valid_from = '2026-08-03'"), db);
  });
});
