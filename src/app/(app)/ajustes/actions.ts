"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { number, text, toState } from "@/app/_server/form";
import type { FormState } from "@/components/form-action";
import { revokeGrant } from "@/server/oauth";
import { UpdateAthleteInput, getAthlete, updateAthlete } from "@/server/services/athlete";
import { SetVolumeTargetInput, setVolumeTarget } from "@/server/services/library";
import { ActivateProgramInput, SetDeloadInput, activateProgram, setDeload } from "@/server/services/plan";
import { todayIn } from "@/server/time";

const refresh = () => revalidatePath("/", "layout");

export async function profileAction(_prev: FormState, f: FormData): Promise<FormState> {
  const input = Object.fromEntries(
    Object.entries({
      name: text(f, "name"), birthDate: text(f, "birthDate"), heightCm: number(f, "heightCm"), bedtime: text(f, "bedtime"), wakeTime: text(f, "wakeTime"),
      hrRest: number(f, "hrRest"), goalWeightKg: number(f, "goalWeightKg"), goalWaistCm: number(f, "goalWaistCm"), stepsGoal: number(f, "stepsGoal"),
      weeklyFoodBudgetEur: number(f, "weeklyFoodBudgetEur"),
    }).filter(([, v]) => v !== undefined),
  ) as UpdateAthleteInput;
  const med = text(f, "adhdMedication");
  if (med) input.adhdMedication = med === "si" ? true : med === "no" ? false : null;
  if (input.heightCm != null) input.heightConfirmed = true;
  const r = await act(UpdateAthleteInput, input, async (userId, i) => {
    await updateAthlete(userId, i);
    refresh();
    return true;
  });
  return toState(r, () => "Ficha guardada.");
}

export async function programAction(slug: string): Promise<FormState> {
  const r = await act(null, slug, async (userId, s) => {
    const a = await getAthlete(userId);
    const plan = await activateProgram(userId, ActivateProgramInput.parse({ slug: s, startDate: todayIn(a.timezone) }));
    refresh();
    return plan.macrocycle.name;
  });
  return toState(r, (name) => `Activado: ${name}. Empieza hoy.`);
}

export async function deloadAction(microcycleId: string, isDeload: boolean): Promise<FormState> {
  const r = await act(SetDeloadInput, { microcycleId, isDeload }, async (userId, i) => {
    await setDeload(userId, i);
    refresh();
    return i.isDeload;
  });
  return toState(r, (d) => (d ? "Microciclo marcado como descarga." : "Descarga quitada."));
}

export async function volumeAction(muscleId: string, _prev: FormState, f: FormData): Promise<FormState> {
  const r = await act(SetVolumeTargetInput, { muscleId, mev: number(f, "mev") as number, mrv: number(f, "mrv") as number }, async (userId, i) => {
    const m = await setVolumeTarget(userId, i);
    revalidatePath("/ajustes");
    revalidatePath("/progreso");
    return m;
  });
  return toState(r, (m) => `${m.name}: ${m.mev}-${m.mrv} series por semana.`);
}

export async function revokeGrantAction(clientId: string): Promise<FormState> {
  const r = await act(null, clientId, async (userId, c) => {
    const n = await revokeGrant(userId, c);
    revalidatePath("/ajustes");
    return n;
  });
  return toState(r, () => "Desconectado.");
}
