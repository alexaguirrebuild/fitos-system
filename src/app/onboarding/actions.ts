"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { SaveOnboardingInput, getAthlete, saveOnboarding, type OnboardingStatus } from "@/server/services/athlete";
import { ActivateProgramInput, activateProgram } from "@/server/services/plan";
import { todayIn } from "@/server/time";

export type StepSaved = { status: OnboardingStatus; warnings: string[]; level: { score: number; label: string } | null };

/** Guarda la respuesta de un paso. Cada paso manda solo lo suyo: lo que no viene no se toca. */
export async function saveStep(input: SaveOnboardingInput) {
  return act(SaveOnboardingInput, input, async (userId, i): Promise<StepSaved> => {
    const r = await saveOnboarding(userId, i);
    revalidatePath("/", "layout");
    return { status: r.status, warnings: r.warnings, level: r.trainingLevel };
  });
}

/** Activa el programa elegido con inicio hoy (en la zona horaria del atleta). */
export async function chooseProgram(slug: string) {
  return act(null, slug, async (userId, s) => {
    const athlete = await getAthlete(userId);
    const input = ActivateProgramInput.parse({ slug: s, startDate: todayIn(athlete.timezone) });
    const plan = await activateProgram(userId, input);
    revalidatePath("/", "layout");
    return { name: plan.macrocycle.name, startDate: plan.macrocycle.startDate, sessions: plan.sessions.filter((x) => !x.isRest).map((x) => x.name) };
  });
}
