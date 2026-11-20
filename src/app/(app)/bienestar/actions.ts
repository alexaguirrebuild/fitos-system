"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { number, text, toState } from "@/app/_server/form";
import type { FormState } from "@/components/form-action";
import { LogSorenessInput, logSoreness } from "@/server/services/training";
import { SaveCheckinInput, SavePomsInput, saveCheckin, savePoms } from "@/server/services/wellness";

export async function checkinAction(_prev: FormState, f: FormData): Promise<FormState> {
  const input = {
    sleepQuality: number(f, "sleepQuality"), sleepHours: number(f, "sleepHours"), stress: number(f, "stress"), motivation: number(f, "motivation"),
    pain: number(f, "pain"), fatigue: number(f, "fatigue"), anklePain: number(f, "anklePain"), note: text(f, "note"),
  } as SaveCheckinInput;
  const r = await act(SaveCheckinInput, input, async (userId, i) => {
    const c = await saveCheckin(userId, i);
    revalidatePath("/", "layout");
    return c;
  });
  return toState(r, (c) => {
    const base = c.baseline ? `Tu media de 28 días es ${Math.round(c.baseline.mean)}: hoy estás ${c.baseline.z >= 0 ? "por encima" : "por debajo"} (${c.baseline.z >= 0 ? "+" : "−"}${Math.abs(c.baseline.z).toFixed(1).replace(".", ",")} desviaciones).` : "Aún no hay 7 check-ins para comparar con tu media.";
    return `Readiness ${Math.round(c.readiness)}. ${c.label}\n${base}${c.ankle.rule.restricted ? `\n${c.ankle.rule.notes[0]}` : ""}`;
  });
}

export async function sorenessAction(_prev: FormState, f: FormData): Promise<FormState> {
  const scores: Record<string, number> = {};
  for (const [k, v] of f.entries()) if (k.startsWith("m:") && String(v)) scores[k.slice(2)] = Number(v);
  const r = await act(LogSorenessInput, { scores }, async (userId, i) => {
    const s = await logSoreness(userId, i);
    revalidatePath("/bienestar");
    return s;
  });
  return toState(r, (s) => `Guardadas las agujetas de ${Object.keys(s.scores).length} grupos.`);
}

export async function pomsAction(answers: number[]) {
  return act(SavePomsInput, { answers }, async (userId, i) => {
    const p = await savePoms(userId, i);
    revalidatePath("/bienestar");
    return p;
  });
}
