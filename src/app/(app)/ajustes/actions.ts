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
import { invalid } from "@/server/errors";
import { importLegacy, type LegacyEntreno, type LegacyEstado } from "@/server/legacy-import";
import { audit } from "@/server/services/annotations";

const refresh = () => revalidatePath("/", "layout");

const MAX_IMPORT_BYTES = 3.5 * 1024 * 1024;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function readJsonFile(f: FormData, field: string): Promise<unknown> {
  const file = f.get(field);
  if (!(file instanceof File) || file.size === 0) return undefined;
  if (file.size > MAX_IMPORT_BYTES) throw invalid(`${file.name} pasa de 3,5 MB.`);
  try { return JSON.parse(await file.text()); } catch { throw invalid(`${file.name} no es JSON válido.`); }
}

/** Importa el export de la app antigua (entrenos.json y, si viene, estado.json). Idempotente: reimportar actualiza, no duplica. */
export async function importHistoryAction(_prev: FormState, f: FormData): Promise<FormState> {
  const r = await act(null, f, async (userId, form) => {
    const entrenos = await readJsonFile(form, "entrenos");
    if (!Array.isArray(entrenos) || !entrenos.length) throw invalid("Sube el entrenos.json del export (una lista de sesiones).");
    const bad = entrenos.findIndex((e) => !e || typeof e !== "object" || !ISO_DAY.test(String((e as LegacyEntreno).fecha)) || !(e as LegacyEntreno).dia || typeof (e as LegacyEntreno).data !== "object");
    if (bad >= 0) throw invalid(`La sesión ${bad + 1} no tiene fecha (AAAA-MM-DD), día y datos.`);
    const estadoRaw = await readJsonFile(form, "estado");
    const estado = (Array.isArray(estadoRaw) ? estadoRaw[0] : estadoRaw) as LegacyEstado | undefined;
    const rep = await importLegacy(userId, { entrenos: entrenos as LegacyEntreno[], estado: estado ?? null });
    await audit(userId, "app", "import.legacy", { workouts: rep.workouts, sets: rep.sets, skipped: rep.skippedSets, checkins: rep.checkins }).catch(() => {});
    refresh();
    return rep;
  });
  return toState(r, (rep) =>
    `Importado: ${rep.workouts} sesiones, ${rep.sets} series (${rep.skippedSets} descartadas por dato inválido), ${rep.checkins} check-ins.\nEjercicios enlazados a la librería: ${rep.linked} de ${rep.exercises}; el resto conserva tu texto.`);
}

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
