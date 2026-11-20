"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { LogFoodInput, logFood } from "@/server/services/nutrition";
import { LogSetInput, logSet } from "@/server/services/training";

/** Reenvío de un elemento de la cola sin conexión. `ok: false` = el servidor lo rechaza y no tiene sentido reintentar. */
export async function replayQueued(kind: "set" | "food", payload: unknown): Promise<{ ok: boolean; message?: string }> {
  if (kind === "set") {
    const r = await act(LogSetInput, payload as LogSetInput, (userId, i) => logSet(userId, i));
    if (r.ok && r.data.ok) revalidatePath("/entreno", "layout");
    return r.ok ? { ok: r.data.ok, message: r.data.ok ? undefined : r.data.problems.map((p) => p.message).join(" ") } : { ok: false, message: r.error.message };
  }
  if (kind === "food") {
    const r = await act(LogFoodInput, payload as LogFoodInput, (userId, i) => logFood(userId, i));
    if (r.ok && r.data.ok) revalidatePath("/nutricion");
    return r.ok ? { ok: r.data.ok, message: r.data.ok ? undefined : r.data.problems.join(" ") } : { ok: false, message: r.error.message };
  }
  return { ok: false, message: "Tipo de registro desconocido." };
}
