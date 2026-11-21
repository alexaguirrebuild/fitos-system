/**
 * Adaptador de HC Webhook (github.com/mcnaveen/health-connect-webhook) a la ingesta de la app.
 * Traduce su JSON (un array por tipo de Health Connect) a muestras de `ingestHealth` y a apuntes de `logFood`.
 * Formato de origen: docs/webhook.md del repo de HC Webhook (leído el 21-nov-2026).
 */
import { createHash } from "node:crypto";
import type { Db } from "@/db/client";
import { invalid } from "@/server/errors";
import { MAX_HEALTH_SAMPLES, ingestHealth, type HealthSample, type IngestHealthResult } from "./health";
import { logFood, type LogFoodInput } from "./nutrition";

export const HC_WEBHOOK_SOURCE = "health_connect";

type Rec = Record<string, unknown>;
type Meta = { id?: unknown; data_origin?: unknown };

const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === "object") : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const metaId = (r: Rec): string | undefined => str((r.metadata as Meta | undefined)?.id);
/** sourceId estable: el id de Health Connect si viene; si no, el de ingestHealth (tipo + inicio + fin + valor). */
const sid = (r: Rec): string | undefined => { const id = metaId(r); return id ? `hc:${id}` : undefined; };
const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

/** Fases de sueño: AndroidX usa constantes (4 ligero, 5 profundo, 6 REM) o su nombre. */
function stageKind(stage: unknown): "light" | "deep" | "rem" | null {
  const s = String(stage ?? "").toLowerCase();
  if (s === "4" || s.includes("light")) return "light";
  if (s === "5" || s.includes("deep")) return "deep";
  if (s === "6" || s.includes("rem")) return "rem";
  return null;
}

const MEAL_MAP: Record<string, LogFoodInput["meal"]> = { breakfast: "desayuno", lunch: "comida", dinner: "cena", snack: "snack" };

/**
 * Origen de la muestra para ingestHealth. Cada app que escribe en Health Connect (reloj, móvil…) va con su propio
 * `source`, porque el total diario de pasos y kcal toma el mayor entre orígenes en vez de sumarlos: si el móvil y el
 * reloj cuentan los mismos pasos, sumarlos los duplicaría.
 */
export const hcSourceOf = (r: Rec): string => {
  const origin = str((r.metadata as Meta | undefined)?.data_origin)?.replace(/[^A-Za-z0-9._-]/g, "");
  return origin ? `${HC_WEBHOOK_SOURCE}:${origin}`.slice(0, 60) : HC_WEBHOOK_SOURCE;
};

/** `sources[i]` es el origen de `samples[i]`. */
export type HcTranslation = { samples: HealthSample[]; sources: string[]; foods: LogFoodInput[]; skipped: string[] };

/** Traduce el cuerpo de HC Webhook. No toca la base de datos. */
export function translateHcPayload(body: unknown): HcTranslation {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("El cuerpo de HC Webhook tiene que ser un objeto JSON.");
  const p = body as Rec;
  const samples: HealthSample[] = [];
  const sources: string[] = [];
  const foods: LogFoodInput[] = [];
  const skipped: string[] = [];
  const push = (s: HealthSample, r: Rec) => { samples.push({ ...s, ...(sid(r) && { sourceId: sid(r) }) }); sources.push(hcSourceOf(r)); };

  for (const r of arr(p.steps)) {
    const v = num(r.count), start = str(r.start_time), end = str(r.end_time);
    if (v != null && start) push({ type: "steps", value: v, unit: "count", start, ...(end && { end }) }, r);
  }
  for (const r of arr(p.heart_rate)) {
    const v = num(r.bpm) ?? num(r.avg), t = str(r.time);
    if (v != null && t) push({ type: "heart_rate", value: v, unit: "bpm", start: t }, r);
  }
  for (const r of arr(p.resting_heart_rate)) {
    const v = num(r.bpm), t = str(r.time);
    if (v != null && t) push({ type: "resting_hr", value: v, unit: "bpm", start: t }, r);
  }
  for (const r of arr(p.heart_rate_variability)) {
    const v = num(r.rmssd_millis) ?? num(r.avg), t = str(r.time);
    if (v != null && t) push({ type: "hrv", value: v, unit: "ms", start: t }, r);
  }
  for (const r of arr(p.active_calories)) {
    const v = num(r.calories), start = str(r.start_time), end = str(r.end_time);
    if (v != null && start) push({ type: "active_kcal", value: v, unit: "kcal", start, ...(end && { end }) }, r);
  }
  for (const r of arr(p.weight)) {
    const v = num(r.kilograms), t = str(r.time);
    if (v != null && t) push({ type: "weight", value: v, unit: "kg", start: t }, r);
  }
  for (const r of arr(p.sleep)) {
    const end = str(r.session_end_time), secs = num(r.duration_seconds);
    const stagesIn = arr(r.stages);
    const start = str(r.session_start_time) ?? str(stagesIn[0]?.start_time) ?? (end && secs ? new Date(Date.parse(end) - secs * 1000).toISOString() : undefined);
    if (!end || !start) { skipped.push("sleep sin inicio o fin"); continue; }
    const stages = { deep: 0, rem: 0, light: 0 };
    let any = false;
    for (const st of stagesIn) {
      const k = stageKind(st.stage), a = str(st.start_time), b = str(st.end_time);
      if (k && a && b) { stages[k] += minutes(a, b); any = true; }
    }
    const round = (x: number) => Math.round(x);
    push({ type: "sleep", start, end, ...(any && { data: { stages: { deep: round(stages.deep), rem: round(stages.rem), light: round(stages.light) } } }) }, r);
  }
  for (const r of arr(p.exercise)) {
    const start = str(r.start_time), end = str(r.end_time), type = str(r.type);
    if (!start || !end || !type) { skipped.push("exercise incompleto"); continue; }
    const dist = num(r.distance_meters);
    push({ type: "exercise", start, end, data: { activity: type, ...(dist != null && { distanceKm: Math.round(dist) / 1000 }) } }, r);
  }
  for (const r of arr(p.nutrition)) {
    const start = str(r.start_time);
    const kcal = num(r.calories), prot = num(r.protein_grams), carbs = num(r.carbs_grams), fat = num(r.fat_grams);
    const hasMacros = prot != null && carbs != null && fat != null;
    if (!start || (kcal == null && !hasMacros)) { skipped.push("nutrition sin kcal ni macros"); continue; }
    const id = metaId(r) ?? createHash("sha256").update(`${start}|${str(r.name) ?? ""}|${kcal ?? ""}|${str(r.meal_type) ?? ""}`).digest("hex").slice(0, 32);
    const meal = MEAL_MAP[str(r.meal_type)?.toLowerCase() ?? ""];
    const origin = str((r.metadata as Meta | undefined)?.data_origin);
    foods.push({
      description: (str(r.name) ?? `Comida de Health Connect${origin ? ` (${origin})` : ""}`).slice(0, 300),
      ...(kcal != null && { kcal }), ...(prot != null && { proteinG: prot }), ...(carbs != null && { carbsG: carbs }), ...(fat != null && { fatG: fat }),
      ...(meal && { meal }), loggedAt: start, source: "import", clientId: `hc:${id}`.slice(0, 64),
    });
  }
  for (const key of Object.keys(p)) {
    if (!["timestamp", "app_version", "timezone", "steps", "heart_rate", "resting_heart_rate", "heart_rate_variability", "active_calories", "weight", "sleep", "exercise", "nutrition"].includes(key))
      skipped.push(`tipo no importado: ${key}`);
  }
  return { samples, sources, foods, skipped: [...new Set(skipped)] };
}

export type HcIngestResult = {
  health: Pick<IngestHealthResult, "processed" | "skipped" | "days" | "warnings"> & { errors: number };
  foods: { logged: number; duplicates: number; errors: string[] };
  skipped: string[];
};

/** Guarda lo traducido: muestras por ingestHealth (un lote por origen, de 1.000 en 1.000) y comidas por logFood (idempotente por clientId). */
export async function ingestHcWebhook(userId: string, body: unknown, db?: Db): Promise<HcIngestResult> {
  const t = translateHcPayload(body);
  const health = { processed: 0, skipped: 0, errors: 0, days: [] as string[], warnings: [] as string[] };
  const bySource = new Map<string, HealthSample[]>();
  t.samples.forEach((s, i) => { const k = t.sources[i]; if (!bySource.has(k)) bySource.set(k, []); bySource.get(k)!.push(s); });
  const batches = [...bySource].flatMap(([source, list]) =>
    Array.from({ length: Math.ceil(list.length / MAX_HEALTH_SAMPLES) }, (_, j) => ({ source, samples: list.slice(j * MAX_HEALTH_SAMPLES, (j + 1) * MAX_HEALTH_SAMPLES) })));
  for (const batch of batches) {
    const r = await ingestHealth(userId, batch, db);
    health.processed += r.processed;
    health.skipped += r.skipped;
    health.errors += r.errors.length;
    health.days = [...new Set([...health.days, ...r.days])].sort();
    for (const w of r.warnings) if (!health.warnings.includes(w)) health.warnings.push(w);
  }
  const foods = { logged: 0, duplicates: 0, errors: [] as string[] };
  for (const f of t.foods) {
    const r = await logFood(userId, f, db);
    if (!r.ok) foods.errors.push(r.problems.join(" "));
    else if (r.duplicate) foods.duplicates++;
    else foods.logged++;
  }
  return { health, foods, skipped: t.skipped };
}
