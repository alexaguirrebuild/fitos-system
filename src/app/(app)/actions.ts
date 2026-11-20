"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/_server/safe";
import { DismissAnnotationInput, dismissAnnotation } from "@/server/services/annotations";
import { LogBodyMetricsInput, logBodyMetrics } from "@/server/services/wellness";

/** Peso y medidas del día. Si ya había medidas hoy, solo cambia lo que llega. */
export async function logBodyAction(input: LogBodyMetricsInput) {
  return act(LogBodyMetricsInput, input, async (userId, i) => {
    const r = await logBodyMetrics(userId, i);
    revalidatePath("/");
    revalidatePath("/progreso");
    return { date: r.date, weightKg: r.weightKg, bfPct: r.bfPct, bfMarginPts: r.bfMarginPts, warnings: r.warnings };
  });
}

export async function dismissAnnotationAction(annotationId: string) {
  return act(DismissAnnotationInput, { annotationId }, async (userId, i) => {
    await dismissAnnotation(userId, i);
    revalidatePath("/");
    return { id: annotationId };
  });
}
