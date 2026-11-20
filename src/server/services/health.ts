/**
 * Ingesta de salud (reloj / Health Connect / atajo del móvil).
 * 1) Cada muestra válida se guarda cruda en health_samples (deduplicada por source + source_id).
 * 2) Lo nuevo se proyecta: pasos, FC en reposo, HRV, kcal y sueño → daily_activity; peso → body_metrics; ejercicio → cardio.
 * La proyección se recalcula desde health_samples, así que reenviar el mismo lote no cambia nada.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { AppError } from "@/server/errors";
import { todayIn } from "@/server/time";
import { IsoDateTime, athleteTz, parseInput } from "./annotations";
import { logCardioTx, upsertDailyActivityTx, type CardioMode } from "./cardio";

export const HEALTH_SAMPLE_TYPES = ["steps", "heart_rate", "resting_hr", "hrv", "sleep", "weight", "exercise", "active_kcal"] as const;
export type HealthSampleType = (typeof HEALTH_SAMPLE_TYPES)[number];
export const MAX_HEALTH_SAMPLES = 1000;

export const HealthSample = z.object({
  type: z.enum(HEALTH_SAMPLE_TYPES).describe("Tipo: steps, heart_rate, resting_hr, hrv, sleep, weight, exercise o active_kcal."),
  value: z.number().optional().describe("Valor: pasos, ppm, ms (hrv), minutos (sleep y exercise), kg (weight) o kcal."),
  unit: z.string().trim().max(20).optional().describe("Unidad tal como la da el origen (count, bpm, ms, min, kg, kcal)."),
  start: IsoDateTime.describe("Inicio de la muestra (ISO 8601, con zona u offset)."),
  end: IsoDateTime.optional().describe("Fin de la muestra (ISO 8601). En sleep marca la hora de despertar."),
  tzOffsetMin: z.number().int().min(-840).max(840).optional().describe("Desfase horario del dispositivo en minutos (informativo)."),
  sourceId: z.string().trim().min(1).max(200).optional().describe("Identificador de la muestra en el origen. Sin él se deriva de tipo, inicio, fin y valor."),
  data: z.record(z.string(), z.unknown()).optional().describe("Extra. sleep: {stages: {deep, rem, light}, score}. exercise: {activity, avgHr, maxHr, kcal, distanceKm}."),
});
export type HealthSample = z.input<typeof HealthSample>;

export const IngestHealthInput = z.object({
  source: z.string().trim().min(1).max(60).describe("Origen de los datos: health_connect, watch, atajo_ios…"),
  samples: z.array(HealthSample).min(1).max(MAX_HEALTH_SAMPLES).describe("Muestras del lote (máximo 1.000)."),
});
export type IngestHealthInput = z.input<typeof IngestHealthInput>;

/** Lo que se valida del sobre antes de mirar muestra a muestra (una muestra mala no tumba el lote). */
const Envelope = z.object({ source: z.string().trim().min(1).max(60), samples: z.array(z.unknown()).min(1) });

export type IngestHealthResult = {
  /** Muestras nuevas guardadas. */
  processed: number;
  /** Muestras ya recibidas antes (mismo source + source_id). */
  skipped: number;
  errors: { index: number; message: string }[];
  /** Fechas locales del atleta tocadas por lo nuevo. */
  days: string[];
  warnings: string[];
};

/** Ejemplo de cuerpo para configurar el atajo del móvil. Sin datos reales. */
export const HEALTH_INGEST_EXAMPLE: IngestHealthInput = {
  source: "health_connect",
  samples: [
    { type: "steps", value: 8450, unit: "count", start: "2026-01-15T00:00:00+01:00", end: "2026-01-15T23:59:59+01:00" },
    { type: "resting_hr", value: 54, unit: "bpm", start: "2026-01-15T07:10:00+01:00" },
    { type: "hrv", value: 62, unit: "ms", start: "2026-01-15T07:10:00+01:00" },
    { type: "sleep", start: "2026-01-14T23:40:00+01:00", end: "2026-01-15T07:05:00+01:00", data: { stages: { deep: 85, rem: 100, light: 240 }, score: 82 } },
    { type: "weight", value: 80.4, unit: "kg", start: "2026-01-15T07:15:00+01:00" },
    { type: "exercise", value: 45, unit: "min", start: "2026-01-15T18:00:00+01:00", end: "2026-01-15T18:45:00+01:00", sourceId: "ejemplo-123", data: { activity: "walking", avgHr: 112, kcal: 240, distanceKm: 4.1 } },
    { type: "active_kcal", value: 610, unit: "kcal", start: "2026-01-15T00:00:00+01:00", end: "2026-01-15T23:59:59+01:00" },
  ],
};

type Norm = {
  index: number; type: HealthSampleType; value: number | null; unit: string | null; start: Date; end: Date | null;
  tzOffsetMin: number | null; sourceId: string; data: Record<string, unknown>; raw: unknown;
};

const RANGES: Partial<Record<HealthSampleType, [number, number, string]>> = {
  steps: [0, 200_000, "pasos"], heart_rate: [20, 250, "ppm"], resting_hr: [25, 150, "ppm"], hrv: [1, 500, "ms"], active_kcal: [0, 20_000, "kcal"], weight: [20, 400, "kg"],
};

const numIn = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

function checkSample(raw: unknown, index: number): { ok: true; s: Norm } | { ok: false; message: string } {
  const p = HealthSample.safeParse(raw, { error: z.locales.es().localeError });
  if (!p.success) return { ok: false, message: p.error.issues.map((x) => `${x.path.join(".") || "muestra"}: ${x.message}`).join("; ") };
  const d = p.data;
  const start = new Date(d.start);
  let end = d.end ? new Date(d.end) : null;
  if (end && end.getTime() < start.getTime()) return { ok: false, message: "end es anterior a start." };
  let value = d.value ?? null;

  const range = RANGES[d.type];
  if (range) {
    if (value == null) return { ok: false, message: `Falta value (${range[2]}).` };
    if (value < range[0] || value > range[1]) return { ok: false, message: `value fuera de rango para ${d.type}: ${range[0]}-${range[1]} ${range[2]}.` };
    if (d.type === "weight" && d.unit && !/^kg$/i.test(d.unit)) return { ok: false, message: "El peso tiene que venir en kg." };
  } else {
    // sleep y exercise: minutos, de value o de la duración.
    const minutes = value ?? (end ? (end.getTime() - start.getTime()) / 60_000 : null);
    const max = d.type === "sleep" ? 1440 : 900;
    if (minutes == null) return { ok: false, message: "Falta la duración: manda end o value en minutos." };
    if (minutes <= 0 || minutes > max) return { ok: false, message: `Duración fuera de rango para ${d.type}: hasta ${max} minutos.` };
    value = Math.round(minutes * 10) / 10;
    end = end ?? new Date(start.getTime() + minutes * 60_000);
    if (d.type === "exercise" && (typeof d.data?.activity !== "string" || !d.data.activity.trim())) return { ok: false, message: "exercise necesita data.activity." };
  }
  const sourceId = d.sourceId
    ?? `auto:${createHash("sha256").update(`${d.type}|${start.toISOString()}|${end?.toISOString() ?? ""}|${d.value ?? ""}`).digest("hex").slice(0, 32)}`;
  return { ok: true, s: { index, type: d.type, value, unit: d.unit || null, start, end, tzOffsetMin: d.tzOffsetMin ?? null, sourceId, data: d.data ?? {}, raw: d } };
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Solo andar, bici, elíptica y correr pasan a cardio. El resto (fuerza, yoga…) se queda en crudo. */
export function cardioModeOf(activity: string): CardioMode | null {
  const a = fold(activity);
  const walk = /(walk|andar|camin|hik|sender|paseo)/.test(a);
  if (walk && /(treadmill|cinta)/.test(a)) return "cinta_andando";
  if (walk) return "caminar";
  if (/(ellip|elipt)/.test(a)) return "eliptica";
  if (/(bik|cycl|bici|cicl|spinning)/.test(a)) return "bici";
  if (/(run|correr|carrera|jog|trote)/.test(a)) return "carrera";
  return null;
}

/** Filtro de día local sobre una columna timestamptz, con un prefiltro por rango para que use el índice. */
const onLocalDay = (col: string) => `${col} >= $1::date - 1 and ${col} < $1::date + 2 and (${col} at time zone $2)::date = $1::date`;

/** Suma del día para muestras acumulables. Un mismo inicio reenviado con más valor cuenta una vez (el mayor); entre orígenes, el mayor total. */
async function dayTotalTx(tx: Tx, type: "steps" | "active_kcal", day: string, tz: string): Promise<number> {
  const r = await tx.query<{ total: number }>(
    `select coalesce(max(total), 0)::int as total from (
       select source, sum(v) as total from (
         select source, started_at, max(value) as v from fit.health_samples
          where type = $3 and ${onLocalDay("started_at")} group by source, started_at
       ) a group by source
     ) b`,
    [day, tz, type],
  );
  return r[0].total;
}

/** Guarda un lote de muestras y proyecta lo nuevo. Los errores van por muestra y no tumban el lote. */
export async function ingestHealth(userId: string, input: IngestHealthInput, db?: Db): Promise<IngestHealthResult> {
  const env = parseInput(Envelope, input);
  if (env.samples.length > MAX_HEALTH_SAMPLES)
    throw new AppError("limite", `Máximo ${MAX_HEALTH_SAMPLES} muestras por llamada: han llegado ${env.samples.length}. Parte el lote.`);

  const errors: IngestHealthResult["errors"] = [];
  const byId = new Map<string, Norm>();
  let repeatedInBatch = 0;
  env.samples.forEach((raw, index) => {
    const c = checkSample(raw, index);
    if (!c.ok) errors.push({ index, message: c.message });
    else if (byId.has(c.s.sourceId)) repeatedInBatch++;
    else byId.set(c.s.sourceId, c.s);
  });
  const valid = [...byId.values()];
  if (!valid.length) return { processed: 0, skipped: repeatedInBatch, errors, days: [], warnings: [] };

  return withUser(userId, async (tx) => {
    const tz = await athleteTz(tx);
    const inserted = await tx.query<{ source_id: string }>(
      `insert into fit.health_samples (user_id, type, value, unit, started_at, ended_at, tz_offset_min, source, source_id, raw)
       select $1::uuid, x.type, x.value, x.unit, x.started_at, x.ended_at, x.tz_offset_min, $2, x.source_id, x.raw
         from jsonb_to_recordset($3::jsonb) as x(type text, value numeric, unit text, started_at timestamptz, ended_at timestamptz, tz_offset_min smallint, source_id text, raw jsonb)
       on conflict (user_id, source, source_id) do nothing
       returning source_id`,
      [userId, env.source, JSON.stringify(valid.map((s) => ({
        type: s.type, value: s.value, unit: s.unit, started_at: s.start.toISOString(), ended_at: s.end?.toISOString() ?? null,
        tz_offset_min: s.tzOffsetMin, source_id: s.sourceId, raw: s.raw,
      })))],
    );
    const fresh = inserted.map((r) => byId.get(r.source_id)!).sort((x, y) => x.index - y.index);
    const warnings: string[] = [];
    const localDay = (d: Date) => todayIn(tz, d);

    // Qué recalcular en cada día tocado.
    const touched = new Map<string, Set<HealthSampleType>>();
    for (const s of fresh) {
      const day = localDay(s.type === "sleep" ? s.end! : s.start); // el sueño es del día en que te despiertas
      touched.set(day, (touched.get(day) ?? new Set()).add(s.type));
    }

    for (const [day, types] of touched) {
      const patch: Parameters<typeof upsertDailyActivityTx>[2] = { date: day, source: env.source };
      let any = false;
      if (types.has("steps")) { patch.steps = await dayTotalTx(tx, "steps", day, tz); any = true; }
      if (types.has("active_kcal")) { patch.activeKcal = await dayTotalTx(tx, "active_kcal", day, tz); any = true; }
      if (types.has("resting_hr")) {
        const r = await tx.query<{ value: number }>(`select value from fit.health_samples where type = 'resting_hr' and ${onLocalDay("started_at")} order by started_at desc limit 1`, [day, tz]);
        if (r[0]) { patch.restingHr = Math.round(r[0].value); any = true; }
      }
      if (types.has("hrv")) {
        const r = await tx.query<{ value: number | null }>(`select avg(value)::float as value from fit.health_samples where type = 'hrv' and ${onLocalDay("started_at")}`, [day, tz]);
        if (r[0]?.value != null) { patch.hrvMs = Math.round(r[0].value * 10) / 10; any = true; }
      }
      if (types.has("sleep")) {
        // Si hay varias (siesta, sueño partido), manda la más larga de las que terminan ese día.
        const r = await tx.query<{ value: number; started_at: Date | string; ended_at: Date | string; raw: { data?: { stages?: Record<string, unknown>; score?: unknown } } | null }>(
          `select value, started_at, ended_at, raw from fit.health_samples where type = 'sleep' and ended_at is not null and ${onLocalDay("ended_at")} order by value desc nulls last limit 1`,
          [day, tz],
        );
        if (r[0]) {
          const st = r[0].raw?.data?.stages ?? {};
          const deep = numIn(st.deep, 0, 1440), rem = numIn(st.rem, 0, 1440), score = numIn(r[0].raw?.data?.score, 0, 100);
          patch.sleepMinutes = Math.round(r[0].value);
          if (deep != null) patch.sleepDeepMin = Math.round(deep);
          if (rem != null) patch.sleepRemMin = Math.round(rem);
          if (score != null) patch.sleepScore = Math.round(score);
          patch.bedAt = new Date(r[0].started_at).toISOString();
          patch.wokeAt = new Date(r[0].ended_at).toISOString();
          any = true;
        }
      }
      if (any) await upsertDailyActivityTx(tx, userId, patch);

      if (types.has("weight")) {
        const r = await tx.query<{ value: number }>(`select value from fit.health_samples where type = 'weight' and ${onLocalDay("started_at")} order by started_at desc limit 1`, [day, tz]);
        if (r[0]) {
          // Una pesada manual del mismo día manda: el reloj solo escribe si no hay peso o si el que hay ya era del reloj.
          const w = await tx.query(
            `insert into fit.body_metrics as b (user_id, date, weight_kg, source) values ($1::uuid, $2::date, $3, 'reloj')
             on conflict (user_id, date) do update set weight_kg = excluded.weight_kg where b.source = 'reloj' or b.weight_kg is null
             returning id`,
            [userId, day, Math.round(r[0].value * 100) / 100],
          );
          if (!w.length) warnings.push(`Peso del reloj del ${day} sin guardar: ya hay una pesada manual ese día.`);
        }
      }
    }

    for (const s of fresh) {
      if (s.type !== "exercise") continue;
      const mode = cardioModeOf(String(s.data.activity));
      if (!mode) continue;
      const avgHr = numIn(s.data.avgHr, 30, 240), maxHr = numIn(s.data.maxHr, 30, 250), kcal = numIn(s.data.kcal, 0, 20_000), km = numIn(s.data.distanceKm, 0, 1000);
      const res = await logCardioTx(tx, userId, {
        date: localDay(s.start), mode, minutes: s.value!, source: env.source, sourceId: s.sourceId, startedAt: s.start.toISOString(),
        ...(avgHr != null && { avgHr: Math.round(avgHr) }), ...(maxHr != null && { maxHr: Math.round(maxHr) }),
        ...(kcal != null && { kcal: Math.round(kcal) }), ...(km != null && { distanceKm: km }),
      });
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(w);
    }

    return { processed: fresh.length, skipped: valid.length - fresh.length + repeatedInBatch, errors, days: [...touched.keys()].sort(), warnings };
  }, db);
}
