import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { ingestHcWebhook, translateHcPayload } from "@/server/services/hc-webhook";

/** Cuerpo con la forma de docs/webhook.md de HC Webhook. Sin datos reales. */
const PAYLOAD = {
  timestamp: "2026-11-21T09:00:00.000+01:00",
  app_version: "1.9.32",
  timezone: "Europe/Madrid",
  steps: [
    { count: 3000, start_time: "2026-11-20T09:00:00+01:00", end_time: "2026-11-20T10:00:00+01:00" },
    { count: 2500, start_time: "2026-11-20T18:00:00+01:00", end_time: "2026-11-20T19:00:00+01:00" },
  ],
  resting_heart_rate: [{ bpm: 58, time: "2026-11-21T07:00:00+01:00", metadata: { id: "rhr-1" } }],
  heart_rate_variability: [{ rmssd_millis: 41.5, time: "2026-11-21T07:00:00+01:00" }],
  sleep: [{
    session_end_time: "2026-11-21T07:30:00+01:00", duration_seconds: 27000, metadata: { id: "sleep-1" },
    stages: [
      { stage: "LIGHT", start_time: "2026-11-21T00:00:00+01:00", end_time: "2026-11-21T03:00:00+01:00" },
      { stage: "5", start_time: "2026-11-21T03:00:00+01:00", end_time: "2026-11-21T04:30:00+01:00" },
      { stage: "REM", start_time: "2026-11-21T04:30:00+01:00", end_time: "2026-11-21T06:00:00+01:00" },
    ],
  }],
  exercise: [{ type: "EXERCISE_TYPE_WALKING", start_time: "2026-11-20T19:00:00+01:00", end_time: "2026-11-20T19:40:00+01:00", duration_seconds: 2400, distance_meters: 3200, metadata: { id: "ex-1" } }],
  nutrition: [
    { start_time: "2026-11-20T14:00:00+01:00", end_time: "2026-11-20T14:00:00+01:00", calories: 650, protein_grams: 40, carbs_grams: 70, fat_grams: 20, name: "Pizza", meal_type: "lunch", metadata: { id: "food-1", data_origin: "com.google.android.apps.fitness" } },
    { start_time: "2026-11-20T21:00:00+01:00", end_time: "2026-11-20T21:00:00+01:00", name: "Sin datos" },
  ],
  blood_pressure: [{ systolic: 120 }],
};

describe("traducción de HC Webhook", () => {
  it("mapea cada tipo a muestras y comidas", () => {
    const t = translateHcPayload(PAYLOAD);
    expect(t.samples.map((s) => s.type)).toEqual(["steps", "steps", "resting_hr", "hrv", "sleep", "exercise"]);
    const sleep = t.samples.find((s) => s.type === "sleep")!;
    expect(sleep.start).toBe("2026-11-21T00:00:00+01:00");
    expect(sleep.data).toEqual({ stages: { deep: 90, rem: 90, light: 180 } });
    expect(sleep.sourceId).toBe("hc:sleep-1");
    expect(t.samples.find((s) => s.type === "exercise")!.data).toEqual({ activity: "EXERCISE_TYPE_WALKING", distanceKm: 3.2 });
    expect(t.foods).toHaveLength(1);
    expect(t.foods[0]).toMatchObject({ description: "Pizza", kcal: 650, meal: "comida", source: "import", clientId: "hc:food-1" });
    expect(t.skipped).toEqual(expect.arrayContaining(["nutrition sin kcal ni macros", "tipo no importado: blood_pressure"]));
  });

  it("rechaza un cuerpo que no es objeto", () => {
    expect(() => translateHcPayload([])).toThrow();
  });
});

describe("ingesta de HC Webhook", () => {
  let db: Db;
  let a: string;
  beforeAll(async () => {
    db = await openMemoryDb();
    a = (await asSystem((tx) => tx.query<{ id: string }>(
      "insert into fit.athletes (email, birth_date, hr_rest, timezone) values ('hc@test.local', '2004-05-10', 55, 'Europe/Madrid') returning id"), db))[0].id;
  });
  afterAll(async () => db.close());

  it("guarda salud y comida, y reenviar el mismo lote no duplica", async () => {
    const r1 = await ingestHcWebhook(a, PAYLOAD, db);
    expect(r1.health).toMatchObject({ processed: 6, errors: 0 });
    expect(r1.foods).toMatchObject({ logged: 1, duplicates: 0 });
    const day = (await withUser(a, (tx) => tx.query<{ steps: number; resting_hr: number | null }>("select steps, resting_hr from fit.daily_activity where date = '2026-11-20'"), db))[0];
    expect(day.steps).toBe(5500);

    const r2 = await ingestHcWebhook(a, PAYLOAD, db);
    expect(r2.health.processed).toBe(0);
    expect(r2.foods).toMatchObject({ logged: 0, duplicates: 1 });
  });
});
