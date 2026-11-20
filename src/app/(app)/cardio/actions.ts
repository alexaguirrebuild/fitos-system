"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { number, text, toState } from "@/app/_server/form";
import type { FormState } from "@/components/form-action";
import { createIngestToken, revokeIngestToken } from "@/server/ingest-auth";
import { LogCardioInput, LogStepsInput, logCardio, logSteps } from "@/server/services/cardio";

export async function logCardioAction(_prev: FormState, f: FormData): Promise<FormState> {
  const input = { mode: text(f, "mode"), minutes: number(f, "minutes"), avgHr: number(f, "avgHr"), anklePainAfter: number(f, "anklePainAfter") } as LogCardioInput;
  const r = await act(LogCardioInput, input, async (userId, i) => {
    const c = await logCardio(userId, i);
    revalidatePath("/", "layout");
    return c;
  });
  return toState(r, (c) => `Guardado: ${Math.round(c.session.minutes)} min${c.session.zone != null ? ` en zona ${c.session.zone}` : ", sin zona (falta la FC media)"}.${c.warnings.length ? `\n${c.warnings.join("\n")}` : ""}`);
}

export async function logStepsAction(_prev: FormState, f: FormData): Promise<FormState> {
  const r = await act(LogStepsInput, { steps: number(f, "steps") } as LogStepsInput, async (userId, i) => {
    const a = await logSteps(userId, i);
    revalidatePath("/", "layout");
    return a;
  });
  return toState(r, (a) => `Pasos de hoy: ${a.steps ?? 0}.`);
}

export async function createTokenAction(_prev: FormState, f: FormData): Promise<FormState> {
  const r = await act(null, text(f, "name") ?? "", async (userId, name) => {
    const t = await createIngestToken(userId, name);
    revalidatePath("/cardio");
    revalidatePath("/ajustes");
    return t.token;
  });
  return toState(r, (token) => `Cópialo ahora: no se vuelve a mostrar.\n${token}`);
}

export async function revokeTokenAction(id: string): Promise<FormState> {
  const r = await act(null, id, async (userId, tokenId) => {
    const ok = await revokeIngestToken(userId, tokenId);
    revalidatePath("/cardio");
    revalidatePath("/ajustes");
    return ok;
  });
  return toState(r, (ok) => (ok ? "Revocado." : "Ya estaba revocado."));
}
