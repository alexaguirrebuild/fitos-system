import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asSystem, getDb, withUser } from "@/db/client";
import { allTools } from "@/server/mcp/server";
import { createAuthorizationCode, exchangeCode, mcpResource, registerClient, type Scope } from "@/server/oauth";
import { seedCatalog } from "@/server/seed";
import { activateProgram, createFood, saveOnboarding } from "@/server/services";
import { addDays, todayIn } from "@/server/time";
import { POST as mcpPost } from "@/app/api/mcp/route";

// Las rutas usan la conexión del proceso: PGlite en memoria, nunca la base real.
delete process.env.DATABASE_URL;
process.env.PGLITE_DIR = "memory";
process.env.APP_URL = "https://fit.test/";

const APP = "https://fit.test";
const REDIRECT = "https://agente.example/callback";
const D = todayIn("Europe/Madrid");
const ALL: Scope[] = ["mcp:read", "mcp:log", "mcp:plan"];

const READ = [
  "get_today", "get_plan", "get_next_session", "get_workout", "list_workouts", "get_exercise_history", "search_exercises", "find_exercise_alternatives",
  "get_nutrition_day", "search_foods", "lookup_barcode", "get_progress", "get_load_status", "get_volume_status", "get_cardio_week", "get_activity",
  "get_checkins", "list_annotations", "get_glossary", "get_onboarding_status", "list_videos", "get_gear_patterns", "list_meal_templates", "list_program_templates",
];
const LOG = [
  "start_workout", "log_set", "update_set", "delete_set", "add_exercise_to_workout", "swap_exercise", "finish_workout", "log_food", "update_food_log",
  "delete_food_log", "log_meal_template", "repeat_meal", "log_body_metrics", "log_checkin", "save_poms", "log_steps", "log_cardio", "log_caffeine", "log_pain",
  "log_soreness", "add_note", "dismiss_annotation", "register_video", "register_photo",
];
const PLAN = [
  "activate_program", "set_deload", "set_volume_target", "recalc_nutrition_targets", "set_day_type", "build_shopping_list", "weekly_review", "update_profile",
  "save_meal_template", "update_food_price", "create_exercise", "add_exercise_alias",
];

let user: string;
let nextId = 1;
let chicken: string;
/** Escrituras que salieron bien, en orden: deben coincidir con fit.audit_log. */
const written: { tool: string; clientId: string }[] = [];

async function tokenFor(scope: Scope[]) {
  const client = await registerClient({ client_name: "Muse", redirect_uris: [REDIRECT] });
  const verifier = randomBytes(32).toString("base64url");
  const code = await createAuthorizationCode({
    clientId: client.client_id, userId: user, redirectUri: REDIRECT, scope,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"), resource: mcpResource(),
  });
  const tokens = await exchangeCode({ code, clientId: client.client_id, redirectUri: REDIRECT, codeVerifier: verifier });
  return { clientId: client.client_id, access: tokens.access_token };
}
type Token = Awaited<ReturnType<typeof tokenFor>>;
type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- resultados heterogéneos de las herramientas

async function rpc(token: string, method: string, params?: unknown): Promise<Rpc> {
  const res = await mcpPost(new Request(`${APP}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) }),
  }));
  expect(res.status).toBe(200);
  return (await res.json()) as Rpc;
}

/** Llama a una herramienta por el handler MCP real. `data` es su structuredContent. */
async function call(t: Token, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: Data; text: string }> {
  const r = await rpc(t.access, "tools/call", { name, arguments: args });
  if (r.error) return { isError: true, data: { message: r.error.message }, text: r.error.message };
  const isError = r.result!.isError === true;
  const def = allTools.find((x) => x.name === name);
  if (!isError && def && !def.readOnly) written.push({ tool: name, clientId: t.clientId });
  const text = (r.result!.content as Array<{ text: string }>)[0]?.text ?? "";
  return { isError, data: (r.result!.structuredContent ?? {}) as Data, text };
}
/** Igual, pero exige que salga bien. */
async function ok(t: Token, name: string, args: Record<string, unknown> = {}): Promise<Data> {
  const r = await call(t, name, args);
  if (r.isError) throw new Error(`${name} falló: ${r.text}`);
  return r.data;
}
const count = async (table: string, where = "true") =>
  (await withUser(user, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from fit.${table} where ${where}`)))[0].n;
const auditLog = () => withUser(user, (tx) => tx.query<{ actor: string; action: string }>("select actor, action from fit.audit_log order by id"));

beforeAll(async () => {
  await seedCatalog();
  const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email, name) values ('tools@test.local', 'Alex') returning id"));
  user = rows[0].id;
  await saveOnboarding(user, {
    heightCm: 174, birthDate: "2004-03-10", sex: "H", hrRest: 58, bedtime: "23:30", adhdMedication: false, weeklyFoodBudgetEur: 60, stores: ["mercadona"],
    goalWeightKg: 74, weightKg: 80, waistCm: 86, measuredOn: addDays(D, -1), ankle: { status: "abierta", painToday: 1 },
  });
  await activateProgram(user, { slug: "torso-pierna-6d", startDate: D });
  chicken = (await createFood(user, { name: "Pechuga de pollo", store: "mercadona", category: "proteina", barcode: "8480000123459", kcal100: 110, protein100: 23, carbs100: 0, fat100: 2 })).id;
  await createFood(user, { name: "Arroz basmati", category: "hidrato", kcal100: 350, protein100: 8, carbs100: 77, fat100: 1 });
  await createFood(user, { name: "Arroz redondo", category: "hidrato", kcal100: 348, protein100: 7, carbs100: 78, fat100: 1 });
});
// El tope de altas de cliente por hora es global: se envejecen para que no lo alcance el fichero entero.
afterEach(async () => {
  await asSystem((tx) => tx.query("update fit.oauth_clients set created_at = created_at - interval '2 hours'"));
});
afterAll(async () => (await getDb()).close());

describe("catálogo de herramientas", () => {
  it("nombres únicos, en snake_case, con título y descripción", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of allTools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z0-9]+)*$/);
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(40);
    }
    const by = (scope: Scope) => allTools.filter((t) => t.scope === scope).map((t) => t.name).sort();
    expect(by("mcp:read")).toEqual([...READ, "whoami", "server_guide"].sort());
    expect(by("mcp:log")).toEqual([...LOG].sort());
    expect(by("mcp:plan")).toEqual([...PLAN].sort());
    expect(allTools.filter((t) => t.scope === "mcp:read").every((t) => t.readOnly)).toBe(true);
    expect(allTools.filter((t) => t.scope !== "mcp:read").every((t) => !t.readOnly)).toBe(true);
    expect(allTools.filter((t) => t.destructive).map((t) => t.name).sort()).toEqual(["activate_program", "delete_food_log", "delete_set"]);
  });

  it("tools/list filtra por scope", async () => {
    const list = async (scope: Scope[]) => ((await rpc((await tokenFor(scope)).access, "tools/list")).result!.tools as Array<{ name: string; annotations: Record<string, boolean> }>);
    const read = await list(["mcp:read"]);
    expect(read).toHaveLength(26);
    expect(read.map((t) => t.name)).toEqual(expect.arrayContaining(READ));
    expect(read.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(read.map((t) => t.name)).not.toContain("log_set");

    const log = await list(["mcp:read", "mcp:log"]);
    expect(log).toHaveLength(50);
    expect(log.map((t) => t.name)).not.toContain("activate_program");
    expect(log.find((t) => t.name === "delete_set")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(log.find((t) => t.name === "log_set")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });

    const all = await list(ALL);
    expect(all).toHaveLength(62);
    expect(all.map((t) => t.name)).toEqual(expect.arrayContaining([...READ, ...LOG, ...PLAN]));
  });

  it("server_guide lleva el flujo y las reglas", async () => {
    const r = await call(await tokenFor(["mcp:read"]), "server_guide");
    for (const s of ["get_today", "summary", "Nunca inventes calorías", "El tobillo manda", "Las cifras llevan fecha", "mcp:plan cambian el plan", "pregunta cuál"])
      expect(r.text).toContain(s);
  });
});

describe("flujo de una sesión", () => {
  let t: Token;
  let workoutId: string;

  it("get_today → start_workout → log_set ×2 → finish_workout", async () => {
    t = await tokenFor(["mcp:read", "mcp:log"]);
    const today = await ok(t, "get_today");
    expect(today.date).toBe(D);
    expect(today.nextAction).toMatchObject({ kind: "checkin", href: "/bienestar" });
    expect(today.training.next).toMatchObject({ name: "Torso A", reason: "primera" });
    expect(today.training.next.exercises[0]).toMatchObject({ name: "Press banca", rx: "4×4-6 RIR 2", rule: "primera" });
    expect(await count("workouts")).toBe(0); // mirar no abre sesión

    const start = await ok(t, "start_workout");
    workoutId = start.workout.id;
    expect(start.summary).toContain("Torso A");
    expect(start.summary).toContain("7 ejercicios");
    expect(start.exercises).toHaveLength(7);
    expect(start.workout).toMatchObject({ date: D, status: "en_curso" });

    const s1 = await ok(t, "log_set", { exercise: "press banca", kg: 80, reps: 5, rir: 2 });
    expect(s1.summary).toContain("Guardado: Press banca, serie 1: 80 kg × 5, RIR 2.");
    expect(s1.summary).toContain("Siguiente: Press banca, serie 2");
    expect(s1.summary).toContain("Descanso:");
    expect(s1).toMatchObject({ workoutId, isPr: false, duplicate: false, exercise: { name: "Press banca" }, set: { kg: 80, reps: 5, rir: 2 } });
    expect(s1.next).toMatchObject({ exerciseName: "Press banca", setNumber: 2 });
    expect(s1.next.restSeconds).toBeGreaterThan(0);
    expect(s1.set.id).toMatch(/^[0-9a-f-]{36}$/);

    const s2 = await ok(t, "log_set", { exercise: "press banca", kg: 80, reps: 4, rir: 1 });
    expect(s2.summary).toContain("serie 2: 80 kg × 4, RIR 1");
    expect(s2.totals).toMatchObject({ sets: 2, hardSets: 2, tonnage: 720 });

    const view = await ok(t, "get_workout");
    expect(view.workout.id).toBe(workoutId);
    expect(view.exercises[0]).toMatchObject({ name: "Press banca", setsDone: 2, done: false });
    expect(view.exercises[0].sets.map((s: Data) => s.id)).toEqual([s1.set.id, s2.set.id]);

    const fin = await ok(t, "finish_workout", { srpe: 7, durationMin: 60 });
    expect(fin.summary).toContain("Sesión cerrada: Torso A");
    expect(fin.summary).toContain("60 min");
    expect(fin).toMatchObject({ workoutId, load: 420, hardSets: 2, tonnage: 720 });
    expect(await count("workouts", "status = 'hecha'")).toBe(1);
    expect(await count("workout_sets")).toBe(2);

    const after = await ok(t, "get_today");
    expect(after.training).toMatchObject({ todayKind: "hecho", trainedToday: true });
    expect((await auditLog()).map((a) => a.action)).toEqual(["start_workout", "log_set", "log_set", "finish_workout"]);
  });

  it("log_set ambiguo devuelve candidatos y no escribe", async () => {
    const before = { workouts: await count("workouts"), sets: await count("workout_sets"), entries: await count("workout_exercises"), audit: (await auditLog()).length };
    const r = await call(t, "log_set", { exercise: "press inclinado", kg: 30, reps: 10, rir: 2 });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("ambiguo");
    expect(r.data.message).toContain("Pregunta cuál y repite con su id");
    const candidates = r.data.details.candidates as { id: string; name: string }[];
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of candidates) {
      expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.name.toLowerCase()).toContain("press");
    }
    expect(candidates.filter((c) => c.name.startsWith("Press inclinado")).length).toBeGreaterThanOrEqual(2);
    expect({ workouts: await count("workouts"), sets: await count("workout_sets"), entries: await count("workout_exercises"), audit: (await auditLog()).length }).toEqual(before);

    // Con el id del candidato elegido sí guarda (y abre una sesión libre, porque la anterior está cerrada).
    const s = await ok(t, "log_set", { exercise: candidates[0].id, kg: 30, reps: 10, rir: 2 });
    expect(s.exercise).toEqual({ id: candidates[0].id, name: candidates[0].name });
    expect(s.warnings.join(" ")).toContain("sesión libre");
    expect(await count("workout_sets")).toBe(before.sets + 1);

    const fixed = await ok(t, "update_set", { setId: s.set.id, reps: 11 });
    expect(fixed.summary).toBe("Serie corregida: 30 kg × 11, RIR 2.");
    const gone = await ok(t, "delete_set", { setId: s.set.id });
    expect(gone).toMatchObject({ summary: "Serie borrada.", deleted: true });
    expect(await count("workout_sets")).toBe(before.sets);
    await ok(t, "finish_workout", { workoutId: s.workoutId, srpe: 3, durationMin: 5 });
  });

  it("añadir y cambiar ejercicios en la sesión de mañana, con el tobillo avisando", async () => {
    const tomorrow = addDays(D, 1);
    const pain = await ok(t, "log_pain", { zone: "tobillo", pain: 5, date: tomorrow });
    expect(pain.summary).toContain("Dolor de tobillo 5/10");
    expect(pain.ankle).toMatchObject({ restricted: true, squatCapPct: 75 });
    expect(pain.warnings.length).toBeGreaterThan(0);

    const start = await ok(t, "start_workout", { date: tomorrow });
    expect(start.summary).toContain("Pierna A");
    expect(start.warnings.join(" ")).toContain("Tobillo con dolor 5/10");
    const squat = start.exercises.find((e: Data) => e.name === "Sentadilla en multipower");
    expect(squat.ankleWarning).toContain("75 %");

    const alts = await ok(t, "find_exercise_alternatives", { exercise: "sentadilla multipower", ankleSafe: true });
    expect(alts.alternatives.length).toBeGreaterThan(0);
    const inSession = new Set(start.exercises.map((e: Data) => e.id));
    const alt = alts.alternatives.find((a: Data) => !inSession.has(a.id));
    const swap = await ok(t, "swap_exercise", { workoutId: start.workout.id, fromExerciseId: squat.id, toExerciseId: alt.id });
    expect(swap.summary).toContain(`Sentadilla en multipower por ${alt.name}`);
    expect(swap.exercise).toMatchObject({ id: alt.id, origin: "cambio", replaces: "Sentadilla en multipower" });

    const add = await ok(t, "add_exercise_to_workout", { workoutId: start.workout.id, exercise: "curl martillo" });
    expect(add.summary).toContain("Añadido a la sesión");
    expect(add.exercises).toHaveLength(8);
    const sore = await ok(t, "log_soreness", { scores: { pectoral: 3 } });
    expect(sore.summary).toContain("pectoral 3/5");
  });
});

describe("nutrición", () => {
  let t: Token;

  it("log_food por alimento + gramos (nombre, id y a mano)", async () => {
    t = await tokenFor(ALL);
    const byName = await ok(t, "log_food", { food: "pechuga de pollo", grams: 200 });
    expect(byName.summary).toContain("200 g de Pechuga de pollo, 220 kcal, 46 g de proteína");
    expect(byName.log).toMatchObject({ what: "Pechuga de pollo", grams: 200, kcal: 220, proteinG: 46 });
    expect(byName.day.totals).toMatchObject({ kcal: 220, proteinG: 46 });

    const byId = await ok(t, "log_food", { foodId: chicken, grams: 100, meal: "cena" });
    expect(byId.log).toMatchObject({ meal: "cena", kcal: 110 });
    expect(byId.day.totals.kcal).toBe(330);

    const manual = await ok(t, "log_food", { description: "Menú del bar", kcal: 700, proteinG: 35, carbsG: 80, fatG: 25, meal: "comida" });
    expect(manual.summary).toContain("(a mano, estimado)");
    expect(manual.log.estimated).toBe(true);
    expect(await count("food_logs", "source = 'muse'")).toBe(3);

    const fixed = await ok(t, "update_food_log", { logId: byId.log.id, grams: 150 });
    expect(fixed.log).toMatchObject({ grams: 150, kcal: 165 });
    const del = await ok(t, "delete_food_log", { logId: manual.log.id });
    expect(del.deleted).toBe(true);
    const day = await ok(t, "get_nutrition_day");
    expect(day.totals).toMatchObject({ kcal: 385 });
    expect(day.logs).toHaveLength(2);
  });

  it("log_food sin datos no inventa calorías: error con qué falta y nada escrito", async () => {
    const before = { logs: await count("food_logs"), audit: (await auditLog()).length };
    const noGrams = await call(t, "log_food", { food: "pechuga de pollo" });
    expect(noGrams.isError).toBe(true);
    expect(noGrams.data).toMatchObject({ error: "entrada_invalida", details: { falta: ["grams"] } });

    const onlyText = await call(t, "log_food", { description: "un plato de pasta con tomate" });
    expect(onlyText.isError).toBe(true);
    expect(onlyText.data.message).toContain("No se inventan calorías");
    expect(onlyText.data.details.falta[0]).toContain("kcal");

    const unknown = await call(t, "log_food", { food: "tortilla de mi abuela", grams: 150 });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error).toBe("no_encontrado");

    const ambiguous = await call(t, "log_food", { food: "arroz", grams: 80 });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.data.error).toBe("ambiguo");
    // El catálogo semilla también trae arroces: basta con que estén los dos del test.
    expect(ambiguous.data.details.candidates.map((c: Data) => c.name)).toEqual(expect.arrayContaining(["Arroz basmati", "Arroz redondo"]));
    expect({ logs: await count("food_logs"), audit: (await auditLog()).length }).toEqual(before);
  });

  it("alimentos, comidas ancla, cafeína y plan de nutrición", async () => {
    const found = await ok(t, "search_foods", { q: "pollo" });
    expect(found.foods[0]).toMatchObject({ id: chicken, name: "Pechuga de pollo", per100: "110 kcal, P 23, H 0, G 2" });
    expect(await ok(t, "lookup_barcode", { barcode: "8480000123459" })).toMatchObject({ found: true, origin: "local", food: { id: chicken } });

    const price = await ok(t, "update_food_price", { foodId: chicken, priceEur: 6.5, packageG: 1000 });
    expect(price.summary).toContain("6,5 € por 1000 g");
    const tpl = await ok(t, "save_meal_template", { name: "Cena de siempre", meal: "cena", items: [{ foodId: chicken, grams: 200 }] });
    expect(tpl.template).toMatchObject({ name: "Cena de siempre", kcal: 220, proteinG: 46 });
    expect((await ok(t, "list_meal_templates")).templates).toHaveLength(1);
    const logged = await ok(t, "log_meal_template", { templateId: tpl.template.id, date: addDays(D, -1) });
    expect(logged.summary).toContain("Anotados 1 alimentos en cena: 220 kcal");
    const rep = await ok(t, "repeat_meal", { fromDate: addDays(D, -1), meal: "cena", toDate: addDays(D, -2) });
    expect(rep.summary).toContain("Copiados 1 apuntes de cena");
    expect((await call(t, "repeat_meal", { fromDate: addDays(D, -9), meal: "pre" })).isError).toBe(true);

    const coffee = await ok(t, "log_caffeine", { mg: 100, source: "café", at: `${D}T07:00:00Z` });
    expect(coffee.summary).toContain("Cafeína apuntada: 100 mg (café)");
    const late = await ok(t, "log_caffeine", { mg: 150, at: `${D}T19:30:00Z` });
    expect(late.afterCutoff).toBe(true);
    expect(late.warnings.join(" ")).toContain("corte de cafeína");

    const targets = await ok(t, "recalc_nutrition_targets");
    expect(targets.summary).toContain("día On");
    expect(targets.on.proteinG).toBeGreaterThan(100);
    const forced = await ok(t, "set_day_type", { date: addDays(D, 3), dayType: "off" });
    expect(forced).toMatchObject({ dayType: "off", forced: true });
    const review = await ok(t, "weekly_review");
    expect(review.summary).toContain("Decisión:");
    const list = await call(t, "build_shopping_list");
    expect(typeof (list.data.summary ?? list.data.message)).toBe("string");
  });
});

describe("cuerpo, bienestar, cardio y notas", () => {
  let t: Token;

  it("log_body_metrics + get_progress", async () => {
    t = await tokenFor(["mcp:read", "mcp:log"]);
    const m = await ok(t, "log_body_metrics", { weightKg: 79.4, waistCm: 85.5 });
    expect(m.summary).toContain(`Guardado el ${D}: 79,4 kg, cintura 85,5 cm.`);
    expect(m).toMatchObject({ date: D, weightKg: 79.4, waistCm: 85.5 });
    expect(m.bfPct).toBeGreaterThan(5);

    const p = await ok(t, "get_progress", { days: 30 });
    expect(p.weight).toMatchObject({ weighIns: 2, lastKg: 79.4, lastDate: D, firstDate: addDays(D, -1) });
    expect(p.weight.recent).toEqual([`${addDays(D, -1)}: 80 kg`, `${D}: 79,4 kg`]);
    expect(p.waist).toMatchObject({ lastCm: 85.5, changeCm: -0.5 });
    expect(p.lifts.find((l: Data) => l.name === "Press banca")).toMatchObject({ sessions: 1, lastSet: "80×5 (RIR 2)" });
    expect(p.adherence.done).toBeGreaterThanOrEqual(1);

    expect((await call(t, "log_body_metrics", {})).isError).toBe(true);
  });

  it("check-in, POMS, pasos, cardio, notas, vídeos y fotos", async () => {
    const c = await ok(t, "log_checkin", { sleepQuality: 8, sleepHours: 7.5, stress: 3, motivation: 8, pain: 2, fatigue: 3, anklePain: 2 });
    expect(c.summary).toContain(`Check-in del ${D} guardado: readiness`);
    expect(c).toMatchObject({ band: "completa", ankle: { pain: 2, restricted: false } });
    expect((await ok(t, "get_checkins")).checkins[0]).toMatchObject({ date: D, readiness: c.readiness, sleepHours: 7.5 });
    expect((await call(t, "log_checkin", { sleepQuality: 8 })).isError).toBe(true); // faltan valores: no se inventan

    const poms = await ok(t, "save_poms", { answers: Array(52).fill(1) });
    expect(poms.summary).toContain("POMS");

    const steps = await ok(t, "log_steps", { steps: 8400 });
    expect(steps.summary).toBe(`Pasos del ${D}: 8400. Objetivo: 10.000 en día de entreno, 12.000 en descanso.`);
    expect(steps).toMatchObject({ date: D, steps: 8400 });
    expect((await ok(t, "get_activity")).days[0]).toMatchObject({ date: D, steps: 8400 });

    const bike = await ok(t, "log_cardio", { mode: "bici", minutes: 40, avgHr: 128 });
    expect(bike.summary).toContain("40 min de bici a 128 ppm");
    expect(bike.zone).toBeGreaterThanOrEqual(1);
    const run = await ok(t, "log_cardio", { mode: "carrera", minutes: 20, date: addDays(D, 1) });
    expect(run.warnings.join(" ")).toContain("El tobillo manda");
    const week = await ok(t, "get_cardio_week", { weekStart: D });
    expect(week.sessionCount).toBeGreaterThanOrEqual(1);

    const note = await ok(t, "add_note", { scope: "sesion", title: "Hombro raro en press", body: "Molestia al bajar la barra." });
    expect(note.summary).toContain("Hombro raro en press");
    const notes = await ok(t, "list_annotations");
    expect(notes.annotations.find((a: Data) => a.id === note.id)).toMatchObject({ origin: "muse", title: "Hombro raro en press" });
    expect((await ok(t, "dismiss_annotation", { annotationId: note.id })).summary).toContain("Descartada");
    expect((await ok(t, "list_annotations")).annotations.find((a: Data) => a.id === note.id)).toBeUndefined();

    const bench = (await ok(t, "search_exercises", { q: "press banca" })).exercises[0];
    expect(bench.name).toBe("Press banca");
    expect((await call(t, "register_video", { exerciseId: bench.id, kg: 80, reps: 5 })).isError).toBe(true); // sin enlace no hay nada que registrar
    const video = await ok(t, "register_video", { exerciseId: bench.id, kg: 80, reps: 5, driveUrl: "https://drive.google.com/file/d/abc/view", angle: "lateral" });
    expect(video.summary).toContain("Vídeo registrado de Press banca (80×5)");
    expect((await ok(t, "list_videos")).videos[0]).toMatchObject({ exercise: "Press banca", url: "https://drive.google.com/file/d/abc/view" });
    const photo = await ok(t, "register_photo", { pose: "frontal", driveUrl: "https://drive.google.com/file/d/def/view" });
    expect(photo.summary).toBe(`Foto frontal del ${D} registrada.`);
  });

  it("el resto de lecturas responde compacto", async () => {
    const plan = await ok(t, "get_plan");
    expect(plan).toMatchObject({ active: true, microcycle: { position: 1, of: 6, isDeload: false } });
    expect(plan.sessions[0].exercises[0]).toBe("Press banca 4×4-6 RIR 2");
    const next = await ok(t, "get_next_session", { date: addDays(D, 2) });
    expect(next.session.exercises.length).toBeGreaterThan(0);
    expect((await ok(t, "list_program_templates")).templates.map((x: Data) => x.slug)).toContain("torso-pierna-6d");
    expect((await ok(t, "list_workouts")).workouts.length).toBeGreaterThanOrEqual(2);
    const hist = await ok(t, "get_exercise_history", { exercise: "press banca" });
    expect(hist.sessions[0]).toMatchObject({ date: D, sets: "80×5 (RIR 2), 80×4 (RIR 1)" });
    expect((await call(t, "get_exercise_history", { exercise: "press inclinado" })).data.error).toBe("ambiguo");
    expect((await ok(t, "get_load_status")).acwr.reliable).toBe(false);
    expect((await ok(t, "get_volume_status")).muscles.find((m: Data) => m.muscleId === "pectoral").sets).toBeGreaterThan(0);
    expect((await ok(t, "get_glossary", { q: "rir" })).terms.length).toBeGreaterThan(0);
    expect((await ok(t, "get_onboarding_status")).complete).toBe(true);
    expect(await ok(t, "get_gear_patterns", { exercise: "press banca" })).toMatchObject({ exercise: "Press banca", enoughData: false });
    // Nada de volcar filas enteras: las respuestas de lectura caben de sobra en el contexto de un agente.
    for (const name of ["get_today", "get_plan", "get_progress", "get_volume_status", "get_nutrition_day", "get_workout"])
      expect((await call(t, name)).text.length).toBeLessThan(12_000);
  });
});

describe("permisos y auditoría", () => {
  it("activate_program con solo mcp:log no está disponible", async () => {
    const t = await tokenFor(["mcp:read", "mcp:log"]);
    const macros = await count("macrocycles");
    const names = ((await rpc(t.access, "tools/list")).result!.tools as Array<{ name: string }>).map((x) => x.name);
    expect(names).not.toContain("activate_program");
    const r = await call(t, "activate_program", { slug: "torso-pierna-6d", startDate: D });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("Programa activado");
    expect(await count("macrocycles")).toBe(macros);
    expect((await auditLog()).some((a) => a.action === "activate_program")).toBe(false);
  });

  it("las herramientas de plan funcionan con mcp:plan", async () => {
    const t = await tokenFor(ALL);
    const deload = await ok(t, "set_deload");
    expect(deload.summary).toContain("marcado como descarga");
    expect((await ok(t, "get_today")).training.plan.isDeload).toBe(true);
    expect((await ok(t, "set_deload", { microcycleId: deload.microcycleId, isDeload: false })).isDeload).toBe(false);

    const vol = await ok(t, "set_volume_target", { muscleId: "pectoral", mev: 10, mrv: 18 });
    expect(vol.summary).toContain("de 10 a 18 series efectivas por semana");
    const profile = await ok(t, "update_profile", { stepsGoal: 9000, goalWeightKg: 73 });
    expect(profile.summary).toBe("Ficha actualizada: peso objetivo = 73; pasos objetivo = 9000.");
    const ex = await ok(t, "create_exercise", { name: "Curl araña en banco", primaryMuscle: "biceps", kind: "aislamiento", equipment: "mancuernas" });
    expect(ex.summary).toContain("Ejercicio creado: Curl araña en banco (biceps)");
    const alias = await ok(t, "add_exercise_alias", { exerciseId: ex.exercise.id, alias: "la araña" });
    expect(alias.summary).toBe("«la araña» ya vale como nombre de Curl araña en banco.");
    expect((await ok(t, "search_exercises", { q: "la araña" })).exercises[0].id).toBe(ex.exercise.id);

    const program = await ok(t, "activate_program", { slug: "torso-pierna-6d", startDate: addDays(D, 30) });
    expect(program.summary).toContain("Programa activado");
    expect(program.summary).toContain("Primera sesión: Torso A");
    expect(await count("macrocycles", "status = 'activo'")).toBe(1);
  });

  it("cada escritura deja su línea en fit.audit_log, y las lecturas ninguna", async () => {
    const audit = await auditLog();
    expect(audit.map((a) => ({ tool: a.action, clientId: a.actor.replace(/^mcp:/, "") }))).toEqual(written);
    expect(audit.every((a) => a.actor.startsWith("mcp:"))).toBe(true);
    const readNames = new Set(allTools.filter((x) => x.readOnly).map((x) => x.name));
    expect(audit.some((a) => readNames.has(a.action))).toBe(false);
    // Todas las herramientas de registro y de plan se han ejercitado al menos una vez con éxito.
    const done = new Set(written.map((w) => w.tool));
    expect([...LOG, ...PLAN].filter((n) => !done.has(n) && n !== "build_shopping_list")).toEqual([]);
  });
});
