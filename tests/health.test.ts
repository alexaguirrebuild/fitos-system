import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { asSystem, getDb, openMemoryDb, withUser, type Db } from "@/db/client";
import { resetDriveCache, uploadFile } from "@/server/drive";
import { createIngestToken, listIngestTokens, resolveIngestToken, revokeIngestToken } from "@/server/ingest-auth";
import type { FetchLike } from "@/server/off";
import { listAnnotations } from "@/server/services/annotations";
import { ANKLE_WARNING, getActivity, getCardioWeek, logCardio, logSteps, upsertDailyActivity } from "@/server/services/cardio";
import { cardioModeOf, ingestHealth, type HealthSample } from "@/server/services/health";
import { buildPhotoPath, buildVideoPath, gearPatterns, listVideos, registerVideo, uploadVideo } from "@/server/services/media";

let db: Db;
/** Atleta con ficha completa (fecha de nacimiento y FC en reposo). */
let a: string;
/** Atleta sin datos de FC y con el tobillo tocado. */
let b: string;

const SRC = "health_connect";
const activity = async (userId: string, date: string) =>
  (await withUser(userId, (tx) => tx.query<Record<string, unknown>>("select * from fit.daily_activity where date = $1::date", [date]), db))[0];
const n = async (userId: string, sql: string) => (await withUser(userId, (tx) => tx.query<{ n: number }>(sql), db))[0].n;

beforeAll(async () => {
  db = await openMemoryDb();
  const rows = await asSystem((tx) => tx.query<{ id: string }>(
    `insert into fit.athletes (email, birth_date, hr_rest, timezone) values
       ('a@test.local', '2004-05-10', 55, 'Europe/Madrid'), ('b@test.local', null, null, 'Europe/Madrid') returning id`), db);
  [a, b] = rows.map((r) => r.id);
});
afterAll(async () => db.close());
afterEach(() => vi.unstubAllEnvs());

describe("ingesta de salud", () => {
  // En octubre Madrid va a +02:00.
  const morning: HealthSample = { type: "steps", value: 5000, unit: "count", start: "2026-10-20T00:00:00+02:00", end: "2026-10-20T12:00:00+02:00" };
  const evening: HealthSample = { type: "steps", value: 3000, unit: "count", start: "2026-10-20T12:00:00+02:00", end: "2026-10-20T23:59:00+02:00" };

  it("guarda las muestras y proyecta los pasos al día local", async () => {
    const r = await ingestHealth(a, { source: SRC, samples: [morning, evening] }, db);
    expect(r).toEqual({ processed: 2, skipped: 0, errors: [], days: ["2026-10-20"], warnings: [] });
    expect(await activity(a, "2026-10-20")).toMatchObject({ steps: 8000, source: SRC });
  });

  it("es idempotente: reenviar el mismo lote no duplica pasos", async () => {
    const r = await ingestHealth(a, { source: SRC, samples: [morning, evening] }, db);
    expect(r).toMatchObject({ processed: 0, skipped: 2, errors: [], days: [] });
    expect((await activity(a, "2026-10-20")).steps).toBe(8000);
    expect(await n(a, "select count(*)::int as n from fit.health_samples where type = 'steps'")).toBe(2);
  });

  it("un acumulado reenviado con el mismo inicio y más valor cuenta una vez", async () => {
    // El móvil manda «pasos desde las 00:00» otra vez, ya con 6.000.
    const r = await ingestHealth(a, { source: SRC, samples: [{ ...morning, value: 6000, end: "2026-10-20T13:00:00+02:00" }] }, db);
    expect(r.processed).toBe(1);
    expect((await activity(a, "2026-10-20")).steps).toBe(9000); // 6.000 + 3.000, no 14.000
  });

  it("asigna cada muestra al día local del atleta, no al día UTC", async () => {
    const r = await ingestHealth(a, { source: SRC, samples: [{ type: "steps", value: 400, start: "2026-10-21T22:30:00Z", end: "2026-10-21T23:00:00Z" }] }, db);
    expect(r.days).toEqual(["2026-10-22"]); // 00:30 en Madrid
    expect((await activity(a, "2026-10-22")).steps).toBe(400);
  });

  it("el sueño va al día en que te despiertas, con sus fases", async () => {
    const r = await ingestHealth(a, {
      source: SRC,
      samples: [
        { type: "sleep", start: "2026-10-23T23:30:00+02:00", end: "2026-10-24T07:00:00+02:00", data: { stages: { deep: 90, rem: 100, light: 250 }, score: 84 } },
        { type: "sleep", start: "2026-10-24T16:00:00+02:00", end: "2026-10-24T16:25:00+02:00" }, // siesta: no pisa la noche
        { type: "resting_hr", value: 53.6, start: "2026-10-24T07:05:00+02:00" },
        { type: "hrv", value: 60, start: "2026-10-24T03:00:00+02:00" },
        { type: "hrv", value: 65, start: "2026-10-24T05:00:00+02:00" },
        { type: "active_kcal", value: 540, start: "2026-10-24T00:00:00+02:00", end: "2026-10-24T23:59:00+02:00" },
      ],
    }, db);
    expect(r).toMatchObject({ processed: 6, errors: [], days: ["2026-10-24"] });
    const day = await activity(a, "2026-10-24");
    expect(day).toMatchObject({ sleep_minutes: 450, sleep_deep_min: 90, sleep_rem_min: 100, sleep_score: 84, resting_hr: 54, hrv_ms: 62.5, active_kcal: 540 });
    expect(new Date(day.bed_at as string).toISOString()).toBe("2026-10-23T21:30:00.000Z");
    expect(new Date(day.woke_at as string).toISOString()).toBe("2026-10-24T05:00:00.000Z");
    expect(await activity(a, "2026-10-23")).toBeUndefined(); // nada en el día en que te acostaste
  });

  it("el peso del reloj no pisa una pesada manual del mismo día", async () => {
    await withUser(a, (tx) => tx.query("insert into fit.body_metrics (date, weight_kg, source) values ('2026-10-20', 91.0, 'app')"), db);
    const r = await ingestHealth(a, {
      source: SRC,
      samples: [
        { type: "weight", value: 90.2, unit: "kg", start: "2026-10-20T07:30:00+02:00" },
        { type: "weight", value: 90.5, unit: "kg", start: "2026-10-21T07:30:00+02:00" },
      ],
    }, db);
    expect(r.processed).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/2026-10-20.*pesada manual/);
    const rows = await withUser(a, (tx) => tx.query("select date, weight_kg, source from fit.body_metrics order by date"), db);
    expect(rows).toEqual([
      { date: "2026-10-20", weight_kg: 91, source: "app" },
      { date: "2026-10-21", weight_kg: 90.5, source: "reloj" },
    ]);
    // Una segunda pesada del reloj ese día sí actualiza la suya.
    await ingestHealth(a, { source: SRC, samples: [{ type: "weight", value: 90.3, unit: "kg", start: "2026-10-21T21:00:00+02:00" }] }, db);
    expect(await n(a, "select (weight_kg * 10)::int as n from fit.body_metrics where date = '2026-10-21'")).toBe(903);
  });

  it("el ejercicio de andar, bici, elíptica o correr pasa a cardio, sin duplicarse al reenviar", async () => {
    const walk: HealthSample = {
      type: "exercise", start: "2026-10-20T18:00:00+02:00", end: "2026-10-20T18:45:00+02:00", sourceId: "hc-walk-1",
      data: { activity: "Walking", avgHr: 112, kcal: 240, distanceKm: 4.1 },
    };
    const gym: HealthSample = { type: "exercise", value: 60, start: "2026-10-20T10:00:00+02:00", sourceId: "hc-gym-1", data: { activity: "strength_training" } };
    expect(await ingestHealth(a, { source: SRC, samples: [walk, gym] }, db)).toMatchObject({ processed: 2, errors: [] });
    expect(await ingestHealth(a, { source: SRC, samples: [walk, gym] }, db)).toMatchObject({ processed: 0, skipped: 2 });
    const rows = await withUser(a, (tx) => tx.query("select date, mode, minutes, avg_hr, kcal, distance_km, zone, ecos, impact, source, source_id from fit.cardio_sessions"), db);
    // 22 años, FC reposo 55 → 112 ppm cae en zona 1. ECOS: 45 min × 1 (zona) × 0,75 (andar) = 34.
    expect(rows).toEqual([{ date: "2026-10-20", mode: "caminar", minutes: 45, avg_hr: 112, kcal: 240, distance_km: 4.1, zone: 1, ecos: 34, impact: false, source: SRC, source_id: "hc-walk-1" }]);
    expect(cardioModeOf("Carrera en cinta")).toBe("carrera");
    expect(cardioModeOf("Elíptica")).toBe("eliptica");
    expect(cardioModeOf("biking")).toBe("bici");
    expect(cardioModeOf("yoga")).toBeNull();
  });

  it("una muestra mala no tumba el lote: errores por muestra", async () => {
    const r = await ingestHealth(a, {
      source: SRC,
      samples: [
        { type: "steps", value: 100, start: "2026-10-25T10:00:00+02:00" },
        { type: "glucosa", value: 90, start: "2026-10-25T10:00:00+02:00" },
        { type: "resting_hr", value: 400, start: "2026-10-25T10:00:00+02:00" },
        { type: "sleep", start: "2026-10-25T10:00:00+02:00" },
        { type: "steps", value: 100, start: "no es una fecha" },
        { type: "steps", value: 100, start: "2026-10-25T10:00:00+02:00" }, // repetida dentro del lote
      ] as HealthSample[],
    }, db);
    expect(r.processed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    expect(r.errors[1].message).toMatch(/fuera de rango/);
    expect(r.errors[2].message).toMatch(/duración/);
    expect((await activity(a, "2026-10-25")).steps).toBe(100);
  });

  it("más de 1.000 muestras o un sobre mal formado se rechazan enteros", async () => {
    const many = Array.from({ length: 1001 }, (_, k) => ({ type: "steps" as const, value: 1, start: new Date(Date.UTC(2026, 8, 1, 0, k)).toISOString() }));
    await expect(ingestHealth(a, { source: SRC, samples: many }, db)).rejects.toMatchObject({ code: "limite" });
    await expect(ingestHealth(a, { source: "", samples: [morning] }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
    await expect(ingestHealth(a, { source: SRC, samples: [] }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
    expect(await n(a, "select count(*)::int as n from fit.health_samples where started_at < '2026-10-01'")).toBe(0);
  });

  it("los datos de un atleta no aparecen en el otro", async () => {
    expect(await n(b, "select count(*)::int as n from fit.health_samples")).toBe(0);
    expect(await n(b, "select count(*)::int as n from fit.daily_activity")).toBe(0);
  });
});

describe("cardio y actividad", () => {
  it("cardio de impacto con el tobillo por encima de 3: no bloquea, avisa y deja una anotación", async () => {
    await withUser(b, (tx) => tx.query("insert into fit.checkins (date, ankle_pain) values ('2026-10-19', 2), ('2026-10-20', 5)"), db);
    const r = await logCardio(b, { date: "2026-10-20", mode: "carrera", minutes: 25, avgHr: 150 }, db);
    expect(r.session).toMatchObject({ mode: "carrera", impact: true, minutes: 25, zone: null, ecos: null });
    expect(r.warnings).toContain(ANKLE_WARNING);
    expect(r.warnings.join(" ")).toMatch(/Sin zona de FC/); // a este atleta le faltan fecha de nacimiento y FC en reposo
    const notes = await withUser(b, (tx) => tx.query("select scope, severity, origin, rule, ref_table, ref_id, date from fit.annotations"), db);
    expect(notes).toEqual([{ scope: "tobillo", severity: "aviso", origin: "motor", rule: "tobillo_impacto", ref_table: "cardio_sessions", ref_id: r.session.id, date: "2026-10-20" }]);
    expect(r.annotationId).not.toBeNull();
  });

  it("sin impacto, o con el tobillo en 3 o menos, no hay aviso", async () => {
    const bike = await logCardio(b, { date: "2026-10-20", mode: "bici", minutes: 40 }, db);
    expect(bike.session.impact).toBe(false);
    expect(bike.warnings).toEqual([]);
    const calm = await logCardio(b, { date: "2026-10-19", mode: "hiit", minutes: 12 }, db); // ese día el dolor era 2
    expect(calm.warnings).toEqual([]);
    expect(await n(b, "select count(*)::int as n from fit.annotations")).toBe(1);
  });

  it("el dolor de una lesión de tobillo abierta también cuenta, y el que se indica al registrar", async () => {
    await withUser(a, async (tx) => {
      const inj = await tx.query<{ id: string }>("insert into fit.injuries (zone, status) values ('tobillo', 'abierta') returning id");
      await tx.query("insert into fit.injury_logs (injury_id, date, pain) values ($1, '2026-10-26', 6)", [inj[0].id]);
    }, db);
    const run = await logCardio(a, { date: "2026-10-27", mode: "carrera", minutes: 20, source: "reloj", sourceId: "run-1" }, db);
    expect(run.warnings).toEqual([ANKLE_WARNING]);
    // Reenviar la misma sesión la actualiza y no repite la anotación.
    const again = await logCardio(a, { date: "2026-10-27", mode: "carrera", minutes: 22, source: "reloj", sourceId: "run-1" }, db);
    expect(again).toMatchObject({ created: false, annotationId: null, session: { id: run.session.id, minutes: 22 } });
    const list = await listAnnotations(a, { days: 365, scope: "tobillo" }, db);
    expect(list.filter((x) => x.refId === run.session.id)).toHaveLength(1);
  });

  it("semana de cardio: minutos por zona, Z2 contra objetivo y ratio con las pesas", async () => {
    await withUser(a, (tx) => tx.query("insert into fit.workouts (date, status) values ('2026-10-12', 'hecha'), ('2026-10-13', 'hecha'), ('2026-10-15', 'hecha'), ('2026-10-16', 'en_curso')"), db);
    // Zonas de este atleta (22 años, reposo 55): Z2 desde 131 ppm.
    await logCardio(a, { date: "2026-10-12", mode: "bici", minutes: 40, avgHr: 135 }, db);
    await logCardio(a, { date: "2026-10-14", mode: "eliptica", minutes: 35, avgHr: 138 }, db);
    await logCardio(a, { date: "2026-10-17", mode: "caminar", minutes: 60 }, db);
    const w = await getCardioWeek(a, { weekStart: "2026-10-14" }, db);
    expect(w).toMatchObject({ weekStart: "2026-10-12", weekEnd: "2026-10-18", sessionCount: 3, minutesTotal: 135 });
    expect(w.minutesByZone).toMatchObject({ "2": 75, sin_zona: 60 });
    expect(w.z2).toEqual({ minutes: 75, targetMin: 150, remainingMin: 75, pct: 50 });
    expect(w.ecosTotal).toBe(75); // (40 + 35) min × 2 (Z2) × 0,5 (bici y elíptica)
    expect(w.strength).toEqual({ sessions: 3, ratio: 1, ok: false });
    expect(w.hrZones).toHaveLength(5);
    expect((await getCardioWeek(b, { weekStart: "2026-10-12" }, db)).hrZones).toBeNull();
  });

  it("pasos y actividad diaria: mezcla sin pisar con null", async () => {
    await upsertDailyActivity(b, { date: "2026-10-12", steps: 7000, sleepMinutes: 420, restingHr: 58 }, db);
    const merged = await upsertDailyActivity(b, { date: "2026-10-12", hrvMs: 55.5, source: "reloj" }, db);
    expect(merged).toMatchObject({ steps: 7000, sleepMinutes: 420, restingHr: 58, hrvMs: 55.5, source: "reloj" });
    const steps = await logSteps(b, { date: "2026-10-12", steps: 9100 }, db);
    expect(steps).toMatchObject({ steps: 9100, sleepMinutes: 420 });
    const recent = await getActivity(b, { days: 3 }, db);
    expect(recent.days.length).toBeLessThanOrEqual(3);
  });
});

describe("tokens de ingesta", () => {
  it("el token se enseña una vez y en la base solo vive su hash", async () => {
    const t = await createIngestToken(a, "Reloj", db);
    expect(t.token).toMatch(/^fit_ing_[A-Za-z0-9_-]{43}$/);
    const stored = await db.query<{ token_hash: string }>("select token_hash from fit.ingest_tokens where id = $1", [t.id]);
    expect(stored[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await db.query("select * from fit.ingest_tokens"))).not.toContain(t.token);

    expect(await resolveIngestToken(t.token, db)).toEqual({ userId: a, tokenId: t.id });
    const [listed] = await listIngestTokens(a, db);
    expect(listed).toMatchObject({ id: t.id, name: "Reloj", revokedAt: null });
    expect(listed.lastUsedAt).not.toBeNull();
    expect(listed).not.toHaveProperty("token");
    expect(await listIngestTokens(b, db)).toEqual([]);
  });

  it("un token revocado, ajeno, mal formado o inventado no entra", async () => {
    const t = await createIngestToken(a, "Atajo del móvil", db);
    expect(await revokeIngestToken(b, t.id, db)).toBe(false); // no es suyo
    expect(await resolveIngestToken(t.token, db)).not.toBeNull();
    expect(await revokeIngestToken(a, t.id, db)).toBe(true);
    expect(await resolveIngestToken(t.token, db)).toBeNull();
    expect(await revokeIngestToken(a, t.id, db)).toBe(false);
    expect(await resolveIngestToken(`fit_ing_${"x".repeat(43)}`, db)).toBeNull();
    expect(await resolveIngestToken("Bearer nada", db)).toBeNull();
    await expect(createIngestToken(a, "  ", db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });
});

describe("POST /api/ingest/health", () => {
  let token: string;
  let owner: string;
  const call = async (init: RequestInit) => {
    const { POST } = await import("@/app/api/ingest/health/route");
    return POST(new Request("http://localhost/api/ingest/health", { method: "POST", ...init }));
  };

  beforeAll(async () => {
    // La ruta usa la base por defecto del proceso: aquí, otra PGlite en memoria. Nunca una base real.
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DIR", "memory");
    const global = await getDb();
    expect(global.driver).toBe("pglite");
    owner = (await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('ruta@test.local') returning id")))[0].id;
    token = (await createIngestToken(owner, "Test")).token;
  });

  it("GET devuelve un ejemplo de cuerpo sin datos reales", async () => {
    const { GET } = await import("@/app/api/ingest/health/route");
    const body = await (await GET()).json();
    expect(body.example.samples.length).toBeGreaterThan(3);
    expect(body.limits).toEqual({ maxBytes: 2 * 1024 * 1024, maxSamples: 1000 });
  });

  it("401 sin token válido, 400 con JSON roto o sobre inválido, 413 si pasa de 2 MB; nunca trazas", async () => {
    const bad = await call({ headers: { Authorization: `Bearer fit_ing_${"x".repeat(43)}` }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "no_autorizado" });

    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const broken = await call({ headers: auth, body: "{no es json" });
    expect(broken.status).toBe(400);
    const shape = await call({ headers: auth, body: JSON.stringify({ samples: "x" }) });
    expect(shape.status).toBe(400);
    const shapeBody = await shape.json();
    expect(shapeBody.error).toBe("entrada_invalida");
    expect(JSON.stringify(shapeBody)).not.toMatch(/\bat\b.*\.ts|node_modules/);

    const big = await call({ headers: auth, body: JSON.stringify({ source: "x", samples: [], pad: "a".repeat(2 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
    const many = await call({ headers: auth, body: JSON.stringify({ source: "x", samples: Array.from({ length: 1001 }, () => ({})) }) });
    expect(many.status).toBe(413);
  });

  it("200 con token de ingesta: guarda, proyecta y deja rastro en la auditoría", async () => {
    const res = await call({
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "atajo", samples: [{ type: "steps", value: 1234, start: "2026-10-20T08:00:00+02:00" }, { type: "raro", start: "x" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processed: 1, skipped: 0, days: ["2026-10-20"], errors: [{ index: 1 }] });
    const rows = await withUser(owner, (tx) => tx.query<{ steps: number }>("select steps from fit.daily_activity"));
    expect(rows).toEqual([{ steps: 1234 }]);
    const log = await withUser(owner, (tx) => tx.query<{ actor: string; action: string }>("select actor, action from fit.audit_log"));
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("ingest.health");
    expect(log[0].actor).toMatch(/^ingest:[0-9a-f-]{36}$/);
  });
});

describe("medios", () => {
  it("buildVideoPath: carpetas legibles y nombre de fichero saneado", () => {
    const p = buildVideoPath({ macrocycleName: "Definición 2026/27: fase 1", exerciseName: "Sentadilla hack (pies juntos)", date: "2026-11-20", kg: 92.5, reps: 8 });
    expect(p.folders).toEqual(["Definición 2026 27 fase 1", "Vídeos", "Sentadilla hack (pies juntos)"]);
    expect(p.fileName).toBe("2026-11-20_sentadilla-hack-pies-juntos_92.5kgx8.mp4");
    expect(p.path).toBe(`${p.folders.join("/")}/${p.fileName}`);

    expect(buildVideoPath({ macrocycleName: "  ", exerciseName: "../..\\etc", date: "2026-11-20", kg: 100, reps: 5, ext: ".MOV" })).toMatchObject({
      folders: ["Sin macrociclo", "Vídeos", "etc"], fileName: "2026-11-20_etc_100kgx5.mov",
    });
    expect(buildVideoPath({ macrocycleName: "M", exerciseName: "Curl", date: "2026-11-20" }).fileName).toBe("2026-11-20_curl.mp4");
    expect(buildPhotoPath({ macrocycleName: "M", date: "2026-11-20", pose: "frontal" })).toMatchObject({ folders: ["M", "Fotos"], fileName: "2026-11-20_frontal.jpg" });
  });

  it("registerVideo rellena kg, repeticiones, RIR y material desde la serie y la sesión", async () => {
    const ids = await asSystem(async (tx) => (await tx.query<{ id: string }>("insert into fit.exercises (slug, name) values ('sentadilla-hack', 'Sentadilla hack') returning id"))[0].id, db);
    const set = await withUser(a, async (tx) => {
      const w = await tx.query<{ id: string }>("insert into fit.workouts (date, status, knee_sleeves, belt, caffeine_mg) values ('2026-10-28', 'hecha', true, false, 200) returning id");
      const s = await tx.query<{ id: string }>("insert into fit.workout_sets (workout_id, exercise_id, set_index, kg, reps, rir, e1rm) values ($1, $2, 1, 120, 6, 1.5, 145) returning id", [w[0].id, ids]);
      return { workoutId: w[0].id, setId: s[0].id };
    }, db);
    const v = await registerVideo(a, { workoutSetId: set.setId, angle: "lateral", tags: ["profundidad"] }, db);
    expect(v).toMatchObject({
      workoutId: set.workoutId, exerciseId: ids, exerciseName: "Sentadilla hack", kg: 120, reps: 6, rir: 1.5, kneeSleeves: true, belt: false, straps: false,
      caffeineMg: 200, status: "pendiente", angle: "lateral", tags: ["profundidad"],
    });
    expect((await listVideos(a, { exerciseId: ids }, db)).map((x) => x.id)).toEqual([v.id]);
    expect(await listVideos(b, {}, db)).toEqual([]);
  });

  it("sin Drive configurado, uploadVideo deja la fila pendiente y dice qué variables faltan (solo nombres)", async () => {
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "DRIVE_ROOT_FOLDER_ID"]) vi.stubEnv(k, "");
    const noNet: FetchLike = async () => { throw new Error("no debería llamar a la red"); };
    const r = await uploadVideo(a, { kg: 100, reps: 5 }, { name: "clip.mp4", mimeType: "video/mp4", body: Buffer.from("vídeo") }, db, { fetchImpl: noNet });
    expect(r.status).toBe("pendiente");
    expect(r.missing).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "DRIVE_ROOT_FOLDER_ID"]);
    expect(r.message).toMatch(/NO se ha guardado/);
    expect(r.video).toMatchObject({ status: "pendiente", driveFileId: null, kg: 100, reps: 5 });
    expect(r.video.drivePath).toMatch(/^Sin macrociclo\/Vídeos\/Ejercicio\/\d{4}-\d{2}-\d{2}_ejercicio_100kgx5\.mp4$/);
  });

  /** Drive falso: token, búsqueda y alta de carpetas, y subida resumable. Apunta todo lo que recibe. */
  function fakeDrive() {
    const log: { method: string; url: string; range: string | null; bytes: number; auth: string | null }[] = [];
    const folders: string[] = [];
    let received = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = init?.body;
      const bytes = body instanceof Uint8Array ? body.length : 0;
      log.push({ method: init?.method ?? "GET", url, range: headers.get("content-range"), bytes, auth: headers.get("authorization") });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "acceso-falso", expires_in: 3600 });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files") && (init?.method ?? "GET") === "GET") return Response.json({ files: [] });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files")) {
        folders.push(JSON.parse(String(body)).name);
        return Response.json({ id: `carpeta-${folders.length}` });
      }
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) return new Response(null, { status: 200, headers: { Location: "https://upload.test/sesion-1" } });
      if (url === "https://upload.test/sesion-1") {
        received += bytes;
        const total = /\/(\d+|\*)$/.exec(headers.get("content-range") ?? "")?.[1];
        if (total === "*") return new Response(null, { status: 308 });
        return Response.json({ id: "fichero-1", name: "x", webViewLink: "https://drive.test/fichero-1", size: String(received) });
      }
      return new Response("no esperado", { status: 500 });
    };
    return { log, folders, fetchImpl, received: () => received };
  }

  it("con Drive (falso): crea las carpetas, sube en resumable y guarda el enlace", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id-falso");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secreto-falso");
    vi.stubEnv("GOOGLE_REFRESH_TOKEN", "refresh-falso");
    vi.stubEnv("DRIVE_ROOT_FOLDER_ID", "raiz");
    resetDriveCache();
    const drive = fakeDrive();
    const r = await uploadVideo(a, { kg: 80, reps: 10 }, { name: "IMG_0001.MOV", mimeType: "video/quicktime", body: Buffer.alloc(1000, 7) }, db, { fetchImpl: drive.fetchImpl });
    expect(r).toMatchObject({ status: "subido", missing: [], video: { status: "subido", driveFileId: "fichero-1", driveUrl: "https://drive.test/fichero-1" } });
    expect(r.video.drivePath).toMatch(/_ejercicio_80kgx10\.mov$/);
    expect(drive.folders).toEqual(["Sin macrociclo", "Vídeos", "Ejercicio"]);
    expect(drive.log.filter((c) => c.method === "PUT").map((c) => c.range)).toEqual(["bytes 0-999/1000"]);
    expect(drive.received()).toBe(1000);
    expect(drive.log.filter((c) => c.url.includes("oauth2")).length).toBe(1); // el token se reutiliza
    // Ningún mensaje ni fila guarda el token.
    expect(JSON.stringify(r)).not.toContain("acceso-falso");
    resetDriveCache();
  });

  it("subida resumable por trozos desde un stream, sin saber el tamaño de antemano", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id-falso");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secreto-falso");
    vi.stubEnv("GOOGLE_REFRESH_TOKEN", "refresh-falso");
    vi.stubEnv("DRIVE_ROOT_FOLDER_ID", "raiz");
    resetDriveCache();
    const drive = fakeDrive();
    const chunk = 256 * 1024;
    const total = chunk * 2 + 90_000;
    // El stream entrega en pedazos de tamaño raro: el cliente tiene que reagruparlos.
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let sent = 0; sent < total; sent += 100_003) ctrl.enqueue(new Uint8Array(Math.min(100_003, total - sent)));
        ctrl.close();
      },
    });
    const file = await uploadFile({ name: "v.mp4", mimeType: "video/mp4", body: stream, parentId: "carpeta" }, { fetchImpl: drive.fetchImpl, chunkBytes: chunk });
    expect(file.id).toBe("fichero-1");
    expect(drive.log.filter((c) => c.method === "PUT").map((c) => c.range)).toEqual([
      `bytes 0-${chunk - 1}/*`, `bytes ${chunk}-${chunk * 2 - 1}/*`, `bytes ${chunk * 2}-${total - 1}/${total}`,
    ]);
    expect(drive.received()).toBe(total);

    const rejected: FetchLike = async (input) => (String(input).includes("oauth2") ? new Response("{}", { status: 400 }) : new Response(null, { status: 500 }));
    resetDriveCache();
    await expect(uploadFile({ name: "v.mp4", mimeType: "video/mp4", body: Buffer.from("x"), parentId: "c" }, { fetchImpl: rejected })).rejects.toMatchObject({ code: "externo" });
    resetDriveCache();
  });

  it("gearPatterns compara con y sin material, y calla si hay menos de 3 sesiones por lado", async () => {
    const ex = await asSystem(async (tx) => (await tx.query<{ id: string }>("insert into fit.exercises (slug, name) values ('prensa', 'Prensa') returning id"))[0].id, db);
    await withUser(b, async (tx) => {
      const e1rms: [boolean, number][] = [[true, 150], [true, 152], [true, 154], [false, 140], [false, 142], [false, 144]];
      for (const [k, [sleeves, e1rm]] of e1rms.entries()) {
        const w = await tx.query<{ id: string }>("insert into fit.workouts (date, status, knee_sleeves, caffeine_mg) values ($1::date, 'hecha', $2, $3) returning id", [`2026-09-${String(k + 1).padStart(2, "0")}`, sleeves, k === 0 ? 200 : null]);
        await tx.query("insert into fit.workout_sets (workout_id, exercise_id, set_index, kg, reps, e1rm) values ($1, $2, 1, 100, 8, $3), ($1, $2, 2, 100, 6, $4)", [w[0].id, ex, e1rm, e1rm - 10]);
      }
    }, db);
    const r = await gearPatterns(b, { exerciseId: ex }, db);
    expect(r.sessions).toBe(6);
    const [sleeves, belt, caffeine] = r.comparisons;
    expect(sleeves).toMatchObject({ factor: "rodilleras", with: { n: 3, avgE1rm: 152 }, without: { n: 3, avgE1rm: 142 }, diffPct: 7, enoughData: true });
    expect(sleeves.conclusion).toMatch(/7 % más alto.*asociación/);
    expect(belt).toMatchObject({ factor: "cinturon", with: { n: 0, avgE1rm: null }, without: { n: 6 }, enoughData: false, diffPct: null, conclusion: null });
    expect(caffeine).toMatchObject({ factor: "cafeina", with: { n: 1 }, without: { n: 5 }, enoughData: false, conclusion: null });
  });
});
