"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { CreateFoodInput, SearchFoodsInput, createFood, searchFoods } from "@/server/services/foods";
import {
  BuildShoppingListInput, DeleteFoodLogInput, LogCaffeineInput, LogFoodInput, LogMealTemplateInput, RecalcTargetsInput, RepeatMealInput,
  SetDayTypeInput, UpdateFoodLogInput, buildShoppingList, deleteFoodLog, logCaffeine, logFood, logMealTemplate, recalcTargets, repeatMeal,
  setDayType, updateFoodLog,
} from "@/server/services/nutrition";

const touch = () => {
  revalidatePath("/nutricion");
  revalidatePath("/");
};

export async function logFoodAction(input: LogFoodInput) {
  return act(LogFoodInput, input, async (userId, i) => {
    const r = await logFood(userId, i);
    if (r.ok) touch();
    return r.ok ? { saved: true as const, warnings: r.warnings } : { saved: false as const, warnings: r.problems };
  });
}

export async function updateFoodLogAction(input: UpdateFoodLogInput) {
  return act(UpdateFoodLogInput, input, async (userId, i) => {
    await updateFoodLog(userId, i);
    touch();
    return true;
  });
}

export async function deleteFoodLogAction(logId: string) {
  return act(DeleteFoodLogInput, { logId }, async (userId, i) => {
    await deleteFoodLog(userId, i);
    touch();
    return true;
  });
}

export async function repeatMealAction(input: RepeatMealInput) {
  return act(RepeatMealInput, input, async (userId, i) => {
    const r = await repeatMeal(userId, i);
    if (r.ok) touch();
    return r.ok ? { copied: r.copied, problems: [] as string[] } : { copied: 0, problems: r.problems };
  });
}

export async function logMealTemplateAction(input: LogMealTemplateInput) {
  return act(LogMealTemplateInput, input, async (userId, i) => {
    const r = await logMealTemplate(userId, i);
    touch();
    return { copied: r.logs.length, warnings: r.warnings };
  });
}

export async function setDayTypeAction(input: SetDayTypeInput) {
  return act(SetDayTypeInput, input, async (userId, i) => {
    const r = await setDayType(userId, i);
    touch();
    return r;
  });
}

export async function searchFoodsAction(input: SearchFoodsInput) {
  return act(SearchFoodsInput, input, (userId, i) => searchFoods(userId, i));
}

export async function createFoodAction(input: CreateFoodInput) {
  return act(CreateFoodInput, input, (userId, i) => createFood(userId, i));
}

export async function logCaffeineAction(input: LogCaffeineInput) {
  return act(LogCaffeineInput, input, async (userId, i) => {
    const r = await logCaffeine(userId, i);
    touch();
    return { warnings: r.warnings, todayMg: r.caffeine.todayMg };
  });
}

export async function recalcTargetsAction(input: RecalcTargetsInput) {
  return act(RecalcTargetsInput, input, async (userId, i) => {
    const r = await recalcTargets(userId, i);
    if (r.ok) touch();
    return r;
  });
}

export async function buildShoppingListAction(input: BuildShoppingListInput) {
  return act(BuildShoppingListInput, input, (userId, i) => buildShoppingList(userId, i));
}
