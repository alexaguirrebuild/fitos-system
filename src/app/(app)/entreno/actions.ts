"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { act } from "@/app/_server/safe";
import { requireUser } from "@/server/auth";
import { FindAlternativesInput, SearchExercisesInput, findAlternatives, searchExercises } from "@/server/services/library";
import {
  AddExerciseToWorkoutInput, DeleteSetInput, FinishWorkoutInput, LogSetInput, StartWorkoutInput, SwapExerciseInput,
  addExerciseToWorkout, deleteSet, finishWorkout, getWorkoutView, logSet, openWorkout, swapExercise,
  type LogSetResult, type WorkoutView,
} from "@/server/services/training";

type Logged = Extract<LogSetResult, { ok: true }>;

const touch = () => {
  revalidatePath("/entreno", "layout");
  revalidatePath("/");
};

/** Abre la sesión (la del plan o una libre) y va a ella. Se usa como `action` de un formulario. La vista la calcula la página de destino. */
export async function startAndGo(sessionTemplateId: string | null, formData: FormData): Promise<void> {
  const userId = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const input = StartWorkoutInput.parse(sessionTemplateId ? { sessionTemplateId } : name ? { name } : {});
  const { workoutId } = await openWorkout(userId, input);
  touch();
  redirect(`/entreno/${workoutId}`);
}

/** Registra una serie y devuelve la sesión ya recalculada (siguiente serie, totales, sugerencias). */
export async function logSetAction(input: LogSetInput) {
  return act(LogSetInput, input, async (userId, i): Promise<{ logged: Logged | null; problems: string[]; view: WorkoutView | null }> => {
    const r = await logSet(userId, i);
    if (!r.ok) return { logged: null, problems: r.problems.map((p) => p.message), view: null };
    touch();
    return { logged: r, problems: [], view: await getWorkoutView(userId, r.workoutId) };
  });
}

export async function deleteSetAction(setId: string) {
  return act(DeleteSetInput, { setId }, async (userId, i) => {
    const r = await deleteSet(userId, i);
    touch();
    return getWorkoutView(userId, r.workoutId);
  });
}

export async function addExerciseAction(input: { workoutId: string; exercise: string }) {
  return act(AddExerciseToWorkoutInput, input, async (userId, i) => {
    const v = await addExerciseToWorkout(userId, i);
    touch();
    return v;
  });
}

export async function swapExerciseAction(input: { workoutId: string; fromExerciseId: string; toExerciseId: string }) {
  return act(SwapExerciseInput, input, async (userId, i) => {
    const v = await swapExercise(userId, i);
    touch();
    return v;
  });
}

export async function finishWorkoutAction(input: FinishWorkoutInput) {
  return act(FinishWorkoutInput, input, async (userId, i) => {
    // Sin revalidar aquí: refrescaría esta misma ruta y taparía el resumen (PR y anotaciones). Las demás pantallas leen siempre del servidor.
    return finishWorkout(userId, i);
  });
}

export async function searchExercisesAction(input: { q: string; ankleSafe?: boolean; muscle?: string }) {
  return act(SearchExercisesInput, { ...input, limit: 25 }, async (userId, i) => {
    const list = await searchExercises(userId, i);
    return list.map((e) => ({ id: e.id, name: e.name, primaryMuscle: e.primaryMuscle, equipment: e.equipment, ankleLoad: e.ankleLoad, impact: e.impact }));
  });
}

export async function alternativesAction(input: { exerciseId: string; ankleSafe: boolean }) {
  return act(FindAlternativesInput, input, async (userId, i) => {
    const list = await findAlternatives(userId, i);
    return list.map((e) => ({ id: e.id, name: e.name, primaryMuscle: e.primaryMuscle, equipment: e.equipment, ankleLoad: e.ankleLoad, impact: e.impact }));
  });
}
