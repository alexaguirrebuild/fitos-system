/**
 * Herramientas de nutrición: día, alimentos, registro de comida, comidas ancla, cafeína, objetivos, compra y revisión semanal.
 * Regla de la casa: no se inventan calorías. Si faltan gramos o macros, la herramienta falla diciendo qué falta.
 */
import { z } from "zod";
import { AppError, invalid } from "@/server/errors";
import {
  BuildShoppingListInput, DeleteFoodLogInput, GetNutritionDayInput, ListMealTemplatesInput, LogCaffeineInput, LogFoodInput, LogMealTemplateInput,
  LookupBarcodeInput, RecalcTargetsInput, RepeatMealInput, SaveMealTemplateInput, SearchFoodsInput, SetDayTypeInput, UpdateFoodLogInput, UpdateFoodPriceInput,
  WeeklyNutritionReviewInput,
  buildShoppingList, deleteFoodLog, getNutritionDay, listMealTemplates, logCaffeine, logFood, logMealTemplate, lookupBarcode, recalcTargets, repeatMeal,
  saveMealTemplate, searchFoods, setDayType, updateFoodLog, updateFoodPrice, weeklyNutritionReview, normalizeFoodText,
  type DayTotals, type Food, type FoodLog, type MealTemplate,
} from "@/server/services";
import { defineTool, type AnyTool } from "./registry";
import { AMBIGUOUS_HINT, DEFAULT_LIMIT, cut, lean, macrosText, num, r0, r1, roundMacros } from "./tools-insight";

/* ───────────────────────── Formato ───────────────────────── */

const compactFood = (f: Food) => lean({
  id: f.id, name: f.name, brand: f.brand, store: f.store, category: f.category,
  per100: `${r0(f.kcal100)} kcal, P ${num(f.protein100)}, H ${num(f.carbs100)}, G ${num(f.fat100)}`,
  serving: f.servingG ? `${num(f.servingG)} g${f.servingLabel ? ` (${f.servingLabel})` : ""}` : null,
  price: f.priceEur != null ? `${num(f.priceEur)} €${f.packageG ? ` / ${num(f.packageG)} g` : ""}${f.priceCheckedOn ? ` (visto el ${f.priceCheckedOn})` : ""}` : null,
});
const compactLog = (l: FoodLog) => lean({
  id: l.id, meal: l.meal, what: l.foodName ?? l.description, grams: l.grams, kcal: r0(l.kcal), proteinG: r1(l.proteinG), carbsG: r1(l.carbsG), fatG: r1(l.fatG),
  estimated: l.estimated || null,
});
const compactDay = (d: DayTotals) => ({ date: d.date, dayType: d.dayType, target: roundMacros(d.target), totals: roundMacros(d.totals), remaining: roundMacros(d.remaining) });
/** «Llevas 1.200 de 2.300 kcal; te quedan 80 g de proteína.» */
const dayText = (d: DayTotals) =>
  d.target && d.remaining
    ? `Llevas ${r0(d.totals.kcal)} de ${r0(d.target.kcal)} kcal el ${d.date}; ${d.remaining.proteinG > 0 ? `te quedan ${r0(d.remaining.proteinG)} g de proteína` : "proteína cubierta"}.`
    : `Llevas ${r0(d.totals.kcal)} kcal y ${r0(d.totals.proteinG)} g de proteína el ${d.date} (aún no hay objetivos calculados).`;
const what = (l: FoodLog) => `${l.grams != null ? `${num(l.grams)} g de ` : ""}${l.foodName ?? l.description ?? "comida"}`;
const compactTemplate = (t: MealTemplate) => lean({
  id: t.id, name: t.name, meal: t.meal, dayType: t.dayType, items: t.items.map((i) => `${num(i.grams)} g de ${i.name ?? "alimento borrado"}`),
  kcal: t.kcal != null ? r0(t.kcal) : null, proteinG: t.proteinG != null ? r0(t.proteinG) : null, costEur: t.costEur,
});

/* ───────────────────────── Lectura ───────────────────────── */

const getNutritionDayTool = defineTool({
  name: "get_nutrition_day",
  title: "Comida del día",
  description: "Úsala para «qué llevo comido» o «cuánto me queda»: devuelve el tipo de día (On/Off), el objetivo, lo comido, lo que queda, el % de proteína, cada apunte con su id, la cafeína y los pasos.",
  scope: "mcp:read",
  readOnly: true,
  input: GetNutritionDayInput,
  handler: async (ctx, args) => {
    const d = await getNutritionDay(ctx.userId, args);
    const logs = cut(d.logs.map(compactLog), DEFAULT_LIMIT);
    return {
      date: d.date, dayType: d.dayType, dayTypeForced: d.dayTypeForced, dayTypeAssumed: d.dayTypeAssumed, phase: d.phase,
      target: roundMacros(d.target), totals: roundMacros(d.totals), remaining: roundMacros(d.remaining), proteinPct: d.proteinPct,
      byMeal: Object.fromEntries(Object.entries(d.byMeal).map(([meal, m]) => [meal, `${m!.items} apuntes, ${r0(m!.kcal)} kcal, ${r0(m!.proteinG)} g de proteína`])),
      logs: logs.items, logsTotal: logs.total, logsTruncated: logs.truncated,
      caffeine: d.caffeine, steps: d.steps,
      message: d.target ? null : "Aún no hay objetivos de calorías: hacen falta peso, altura confirmada y fecha de nacimiento, y luego recalc_nutrition_targets.",
    };
  },
});

const searchFoodsTool = defineTool({
  name: "search_foods",
  title: "Buscar alimentos",
  description: "Úsala para encontrar el id de un alimento del catálogo antes de anotarlo o cuando log_food devuelve candidatos: devuelve nombre, marca, tienda, macros por 100 g, ración y precio fechado.",
  scope: "mcp:read",
  readOnly: true,
  input: SearchFoodsInput.extend({ limit: z.number().int().min(1).max(30).default(10).describe("Máximo de resultados. Por defecto, 10") }),
  handler: async (ctx, args) => {
    const list = await searchFoods(ctx.userId, args);
    return { total: list.length, foods: list.map(compactFood) };
  },
});

const lookupBarcodeTool = defineTool({
  name: "lookup_barcode",
  title: "Buscar por código de barras",
  description: "Úsala cuando el atleta te dé el código de barras de un producto: lo busca en su catálogo y, si no está, en Open Food Facts (y lo guarda en el catálogo). Devuelve el alimento con su id o el motivo por el que no se puede usar.",
  scope: "mcp:read",
  readOnly: true,
  input: LookupBarcodeInput,
  handler: async (ctx, args) => {
    const r = await lookupBarcode(ctx.userId, args);
    return r.food ? { found: true, origin: r.origin, barcode: r.barcode, food: compactFood(r.food) } : { found: false, barcode: r.barcode, cause: r.cause, reason: r.reason };
  },
});

const listMealTemplatesTool = defineTool({
  name: "list_meal_templates",
  title: "Comidas ancla",
  description: "Úsala para ver las comidas que el atleta repite («el desayuno de siempre») y anotarlas de un toque con log_meal_template: devuelve cada una con su id, alimentos, calorías, proteína y coste.",
  scope: "mcp:read",
  readOnly: true,
  input: ListMealTemplatesInput,
  handler: async (ctx, args) => {
    const { items, total, truncated } = cut(await listMealTemplates(ctx.userId, args));
    return { total, truncated, templates: items.map(compactTemplate) };
  },
});

/* ───────────────────────── Registro ───────────────────────── */

const logFoodTool = defineTool({
  name: "log_food",
  title: "Anotar comida",
  description: "Úsala cuando el atleta diga lo que ha comido. Necesita un alimento del catálogo (food por nombre, foodId o barcode) con sus gramos, o bien las kcal y los macros a mano. Nunca inventa calorías: si faltan gramos o macros falla diciendo qué falta; si el nombre encaja con varios alimentos devuelve los candidatos. Devuelve lo anotado y cómo queda el día.",
  scope: "mcp:log",
  readOnly: false,
  input: LogFoodInput.extend({
    food: z.string().trim().min(1).max(120).optional().describe("Nombre del alimento tal como lo dice el atleta («pechuga de pollo»). Se busca en el catálogo; necesita `grams`"),
  }),
  handler: async (ctx, { food, ...args }) => {
    let foodId = args.foodId;
    const hasDirect = args.kcal != null || (args.proteinG != null && args.carbsG != null && args.fatG != null);
    if (food && !foodId && !args.barcode) {
      const found = await searchFoods(ctx.userId, { q: food, limit: 6 });
      const key = normalizeFoodText(food);
      const exact = found.filter((f) => normalizeFoodText(f.name) === key);
      const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
      if (pick) foodId = pick.id;
      else if (found.length)
        throw new AppError("ambiguo", `«${food}» puede ser más de un alimento. ${AMBIGUOUS_HINT}`, { candidates: found.map((f) => ({ id: f.id, name: f.name, brand: f.brand })) });
      else if (!hasDirect)
        throw new AppError("no_encontrado", `«${food}» no está en el catálogo. Pide el código de barras (lookup_barcode) o las kcal y los macros de la etiqueta. No se inventan calorías.`, { falta: ["alimento del catálogo o kcal y macros"] });
    }
    if (foodId && args.grams == null && !hasDirect)
      throw invalid(`Faltan los gramos${food ? ` de «${food}»` : ""}. Pregunta cuánto ha comido; no se estiman.`, { falta: ["grams"] });

    const description = args.description ?? (food && !foodId ? food : undefined);
    const r = await logFood(ctx.userId, { ...args, foodId, description, source: args.source ?? (args.barcode ? undefined : "muse") });
    if (!r.ok)
      throw invalid(r.problems.join(" "), { falta: foodId || args.barcode ? ["grams"] : ["foodId o barcode con grams, o kcal con proteinG, carbsG y fatG"] });
    return {
      summary: `Anotado en ${r.log.meal}: ${what(r.log)}, ${macrosText(r.log)}${r.log.estimated ? " (a mano, estimado)" : ""}. ${dayText(r.day)}`,
      log: compactLog(r.log), day: compactDay(r.day), warnings: r.warnings,
    };
  },
});

const updateFoodLogTool = defineTool({
  name: "update_food_log",
  title: "Corregir un apunte de comida",
  description: "Úsala cuando el atleta corrija algo ya anotado («eran 150 g, no 200»): cambia solo lo que envíes y recalcula los macros. El id del apunte lo dan log_food y get_nutrition_day.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: UpdateFoodLogInput,
  handler: async (ctx, args) => {
    const r = await updateFoodLog(ctx.userId, args);
    return { summary: `Corregido: ${what(r.log)}, ${macrosText(r.log)}. ${dayText(r.day)}`, log: compactLog(r.log), day: compactDay(r.day) };
  },
});

const deleteFoodLogTool = defineTool({
  name: "delete_food_log",
  title: "Borrar un apunte de comida",
  description: "Úsala solo cuando el atleta pida quitar algo anotado por error: borra el apunte sin posibilidad de recuperarlo y devuelve cómo queda el día. Confirma antes cuál es.",
  scope: "mcp:log",
  readOnly: false,
  destructive: true,
  input: DeleteFoodLogInput,
  handler: async (ctx, args) => {
    const r = await deleteFoodLog(ctx.userId, args);
    return { summary: `Apunte borrado. ${dayText(r.day)}`, deleted: true, day: compactDay(r.day) };
  },
});

const logMealTemplateTool = defineTool({
  name: "log_meal_template",
  title: "Anotar una comida ancla",
  description: "Úsala cuando el atleta diga «el desayuno de siempre» o nombre una comida ancla: anota de un toque todos sus alimentos con sus gramos. El id sale de list_meal_templates.",
  scope: "mcp:log",
  readOnly: false,
  input: LogMealTemplateInput,
  handler: async (ctx, args) => {
    const r = await logMealTemplate(ctx.userId, args);
    const kcal = r.logs.reduce((a, l) => a + l.kcal, 0), protein = r.logs.reduce((a, l) => a + l.proteinG, 0);
    return {
      summary: `Anotados ${r.logs.length} alimentos${r.logs[0] ? ` en ${r.logs[0].meal}` : ""}: ${r0(kcal)} kcal, ${r0(protein)} g de proteína. ${dayText(r.day)}`,
      logs: r.logs.slice(0, DEFAULT_LIMIT).map(compactLog), day: compactDay(r.day), warnings: r.warnings,
    };
  },
});

const repeatMealTool = defineTool({
  name: "repeat_meal",
  title: "Repetir una comida de otro día",
  description: "Úsala para «lo mismo que ayer en la cena»: copia todos los apuntes de esa comida de un día a otro (hoy por defecto). Si ese día no había nada en esa comida, falla y lo dice.",
  scope: "mcp:log",
  readOnly: false,
  input: RepeatMealInput,
  handler: async (ctx, args) => {
    const r = await repeatMeal(ctx.userId, args);
    if (!r.ok) throw new AppError("no_encontrado", r.problems.join(" "));
    return { summary: `Copiados ${r.copied} apuntes de ${args.meal} del ${args.fromDate}. ${dayText(r.day)}`, logs: r.logs.slice(0, DEFAULT_LIMIT).map(compactLog), day: compactDay(r.day) };
  },
});

const logCaffeineTool = defineTool({
  name: "log_caffeine",
  title: "Apuntar cafeína",
  description: "Úsala cuando el atleta tome café, pre-entreno o una bebida con cafeína (un café ≈ 80-100 mg; si no sabes los mg, pregunta): lo registra con su hora y avisa si pasa del corte de cafeína (9 h antes de acostarse) o de la referencia diaria.",
  scope: "mcp:log",
  readOnly: false,
  input: LogCaffeineInput,
  handler: async (ctx, args) => {
    const r = await logCaffeine(ctx.userId, args);
    return {
      summary: `Cafeína apuntada: ${r.log.mg} mg${r.log.source ? ` (${r.log.source})` : ""}. Hoy llevas ${r.caffeine.todayMg} mg${r.caffeine.maxMg != null ? ` de ${r.caffeine.maxMg}` : ""}${r.caffeine.cutoff ? `; corte a las ${r.caffeine.cutoff}` : ""}.`,
      id: r.log.id, afterCutoff: r.log.afterCutoff, caffeine: r.caffeine, warnings: [...r.warnings, ...(r.caffeine.note ? [r.caffeine.note] : [])],
    };
  },
});

/* ───────────────────────── Plan de nutrición ───────────────────────── */

const recalcTargetsTool = defineTool({
  name: "recalc_nutrition_targets",
  title: "Recalcular objetivos de calorías",
  description: "Cambia el plan: recalcula las calorías y los macros de los días On y Off con el peso, el gasto medido y el peso objetivo. Úsala tras confirmarlo con el atleta (cambio de peso objetivo, fin de la calibración). Devuelve los objetivos, si se han guardado y la explicación paso a paso.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: RecalcTargetsInput,
  handler: async (ctx, args) => {
    const r = await recalcTargets(ctx.userId, args);
    if (!r.ok) throw invalid(`No se pueden calcular los objetivos: falta ${r.missing.join(", ")}. ${r.warnings.join(" ")}`.trim(), { falta: r.missing });
    const t = r.target;
    return {
      summary: `${r.saved ? "Objetivos guardados" : "Objetivos sin cambio relevante (no se guarda nada nuevo)"} desde el ${t.validFrom}, fase ${t.phase}: día On ${macrosText(t.on)}; día Off ${macrosText(t.off)}. Gasto ${r0(t.tdee)} kcal (${t.tdeeMethod}).`,
      saved: r.saved, date: r.date, phase: t.phase, tdee: r0(t.tdee), tdeeMethod: t.tdeeMethod, on: roundMacros(t.on), off: roundMacros(t.off),
      expectedKgPerWeek: r1(r.expectedKgPerWeek), trainDaysPerWeek: r.trainDaysPerWeek, calibration: r.calibration, explain: r.explain.slice(0, 12), warnings: r.warnings,
    };
  },
});

const setDayTypeTool = defineTool({
  name: "set_day_type",
  title: "Forzar día On u Off",
  description: "Cambia el plan del día: fuerza que un día cuente como On (entreno, más hidratos) u Off, o lo devuelve a automático con «auto». Úsala cuando el atleta mueva un entreno de día y lo confirme. Devuelve el tipo de día resultante.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: SetDayTypeInput,
  handler: async (ctx, args) => {
    const d = await setDayType(ctx.userId, args);
    return { summary: `El ${d.date} cuenta como día ${d.dayType === "on" ? "On" : "Off"}${d.forced ? " (forzado)" : " (automático)"}.`, ...d };
  },
});

const buildShoppingListTool = defineTool({
  name: "build_shopping_list",
  title: "Lista de la compra",
  description: "Úsala para «hazme la compra de la semana»: genera y guarda la lista con gramos, envases y coste a partir de las comidas ancla (o una cesta base), ajustada al presupuesto. Los precios sin fecha reciente no se inventan: salen aparte.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: BuildShoppingListInput,
  handler: async (ctx, args) => {
    const r = await buildShoppingList(ctx.userId, args);
    if (!r.ok) throw invalid(r.problems.join(" "));
    const lines = cut(r.lines, 30);
    return {
      summary: `Lista de la semana del ${r.weekStart}${r.store ? ` en ${r.store}` : ""}: ${r.lines.length} productos${r.totalEur != null ? `, ${num(r.totalEur)} €` : ", sin importe (faltan precios)"}` +
        `${r.budgetEur != null ? ` de ${num(r.budgetEur)} € de presupuesto` : ""}.`,
      id: r.id, weekStart: r.weekStart, mode: r.mode, days: r.days, totalEur: r.totalEur, budgetEur: r.budgetEur, overBudget: r.overBudget,
      lines: lines.items.map((l) => lean({ name: l.name, category: l.category, grams: r0(l.grams), packs: l.packs, costEur: l.costEur })), linesTruncated: lines.truncated,
      perDay: { kcal: r0(r.perDay.kcal), proteinG: r0(r.perDay.proteinG), targetKcal: r0(r.perDay.targetKcal), targetProteinG: r0(r.perDay.targetProteinG) },
      notes: r.notes,
      warnings: [...(r.overBudget ? ["La lista se pasa del presupuesto."] : []), ...(r.missingPrices.length ? [`Sin precio reciente: ${r.missingPrices.slice(0, 10).join(", ")}.`] : [])],
    };
  },
});

const weeklyReviewTool = defineTool({
  name: "weekly_review",
  title: "Revisión semanal",
  description: "Úsala una vez por semana («¿cómo ha ido la semana?»): cruza peso, cintura, adherencia, pasos, readiness y rendimiento, guarda la revisión y propone qué hacer con las calorías. La propuesta nunca se aplica sola: coméntala con el atleta.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: WeeklyNutritionReviewInput,
  handler: async (ctx, args) => {
    const r = await weeklyNutritionReview(ctx.userId, args);
    return {
      summary: `Revisión de la semana del ${r.weekStart} al ${r.weekEnd} guardada. Decisión: ${r.action}. ${r.why}`,
      weekStart: r.weekStart, weekEnd: r.weekEnd, action: r.action, why: r.why, proposal: r.proposal,
      data: lean({ ...r.data, engineDecision: undefined }),
    };
  },
});

const saveMealTemplateTool = defineTool({
  name: "save_meal_template",
  title: "Guardar una comida ancla",
  description: "Úsala cuando el atleta quiera guardar una comida que repite («guárdame esto como desayuno de siempre»): crea o edita la comida ancla con sus alimentos (por id) y gramos, y devuelve sus calorías, proteína y coste.",
  scope: "mcp:plan",
  readOnly: false,
  input: SaveMealTemplateInput,
  handler: async (ctx, args) => {
    const t = await saveMealTemplate(ctx.userId, args);
    return { summary: `Comida ancla guardada: ${t.name} (${t.meal}), ${t.items.length} alimentos${t.kcal != null ? `, ${r0(t.kcal)} kcal y ${r0(t.proteinG ?? 0)} g de proteína` : ""}.`, template: compactTemplate(t) };
  },
});

const updateFoodPriceTool = defineTool({
  name: "update_food_price",
  title: "Actualizar el precio de un alimento",
  description: "Úsala cuando el atleta diga lo que cuesta un producto («el pollo está a 6,50 el kilo»): guarda el precio del envase con su fecha (necesita los gramos del envase). De ahí salen la lista de la compra y los gramos de proteína por euro.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: UpdateFoodPriceInput,
  handler: async (ctx, args) => {
    const r = await updateFoodPrice(ctx.userId, args);
    return {
      summary: `Precio guardado: ${r.food.name}, ${num(r.food.priceEur ?? args.priceEur)} € por ${num(r.food.packageG ?? args.packageG)} g (visto el ${r.food.priceCheckedOn ?? "hoy"}).`,
      food: compactFood(r.food), copied: r.copied,
    };
  },
});

export const nutritionTools: AnyTool[] = [
  getNutritionDayTool, searchFoodsTool, lookupBarcodeTool, listMealTemplatesTool,
  logFoodTool, updateFoodLogTool, deleteFoodLogTool, logMealTemplateTool, repeatMealTool, logCaffeineTool,
  recalcTargetsTool, setDayTypeTool, buildShoppingListTool, weeklyReviewTool, saveMealTemplateTool, updateFoodPriceTool,
];
