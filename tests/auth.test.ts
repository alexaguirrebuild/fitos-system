import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, type Db } from "@/db/client";
import {
  SESSION_COOKIE, ensureDevUser, hashPassword, isDevAuth, login, sessionCookieOptions, signSessionToken, verifyPassword, verifySessionToken,
} from "@/server/auth";
import { getAthlete, getOnboardingStatus, isExamPeriod, listInjuries, listSchedule, saveOnboarding, updateAthlete } from "@/server/services/athlete";
import { activateProgram } from "@/server/services/plan";

const EMAIL = "dueno@test.local";
const PASSWORD = "una clave larga de prueba";
const KEYS = ["OWNER_EMAIL", "OWNER_PASSWORD_HASH", "SESSION_SECRET", "AUTH_MODE", "DATABASE_URL", "APP_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let db: Db;

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}
let ownerEnv: Partial<Record<(typeof KEYS)[number], string>>;

beforeAll(async () => {
  db = await openMemoryDb();
  ownerEnv = { OWNER_EMAIL: EMAIL, OWNER_PASSWORD_HASH: await hashPassword(PASSWORD), SESSION_SECRET: "s".repeat(40) };
});
afterEach(() => setEnv(ownerEnv));
afterAll(async () => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await db.close();
});

describe("contraseña", () => {
  it("hash scrypt con sal propia y verificación", async () => {
    const h1 = await hashPassword(PASSWORD);
    const h2 = await hashPassword(PASSWORD);
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword(PASSWORD, h1)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", h1)).toBe(false);
    expect(await verifyPassword(PASSWORD, "no-es-un-hash")).toBe(false);
    expect(await verifyPassword(PASSWORD, "scrypt$3$8$1$AAAA$AAAA")).toBe(false);
    await expect(hashPassword("corta")).rejects.toMatchObject({ code: "entrada_invalida" });
  });
});

describe("login del dueño", () => {
  it("entra, crea el atleta una sola vez y devuelve un token válido", async () => {
    setEnv(ownerEnv);
    const first = await login(` ${EMAIL.toUpperCase()} `, PASSWORD, "10.0.0.1", db);
    expect(await verifySessionToken(first.token)).toBe(first.userId);
    const again = await login(EMAIL, PASSWORD, "10.0.0.1", db);
    expect(again.userId).toBe(first.userId);
    const rows = await asSystem((tx) => tx.query<{ email: string }>("select email from fit.athletes"), db);
    expect(rows).toEqual([{ email: EMAIL }]);
  });

  it("el mismo error si falla el email o la contraseña", async () => {
    setEnv(ownerEnv);
    const badPass = await login(EMAIL, "otra clave distinta", "10.0.0.2", db).catch((e) => e);
    const badMail = await login("otro@test.local", PASSWORD, "10.0.0.2", db).catch((e) => e);
    expect(badPass).toMatchObject({ code: "no_autorizado", message: "Email o contraseña incorrectos." });
    expect(badMail).toMatchObject({ code: "no_autorizado", message: badPass.message });
  });

  it("corta a los 5 fallos por IP y email durante 15 minutos", async () => {
    setEnv(ownerEnv);
    for (let k = 0; k < 5; k++) await expect(login(EMAIL, "mala", "10.0.0.3", db)).rejects.toMatchObject({ code: "no_autorizado" });
    await expect(login(EMAIL, PASSWORD, "10.0.0.3", db)).rejects.toMatchObject({ code: "limite" });
    // Otra IP no está bloqueada, y un acierto pone el contador a cero.
    await expect(login(EMAIL, PASSWORD, "10.0.0.4", db)).resolves.toHaveProperty("token");
    for (let k = 0; k < 4; k++) await expect(login(EMAIL, "mala", "10.0.0.5", db)).rejects.toMatchObject({ code: "no_autorizado" });
    await login(EMAIL, PASSWORD, "10.0.0.5", db);
    await expect(login(EMAIL, "mala", "10.0.0.5", db)).rejects.toMatchObject({ code: "no_autorizado" });
    // Pasados los 15 minutos el bloqueo caduca.
    await asSystem((tx) => tx.query("update fit.login_attempts set created_at = created_at - interval '16 minutes'"), db);
    await expect(login(EMAIL, PASSWORD, "10.0.0.3", db)).resolves.toHaveProperty("userId");
  });

  it("token manipulado, caducado o de otro secreto → null", async () => {
    setEnv(ownerEnv);
    const { token, userId } = await login(EMAIL, PASSWORD, "10.0.0.6", db);
    expect(await verifySessionToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifySessionToken("basura")).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
    setEnv({ ...ownerEnv, SESSION_SECRET: "z".repeat(40) });
    expect(await verifySessionToken(token)).toBeNull();
    expect(await verifySessionToken(await signSessionToken(userId))).toBe(userId);
  });

  it("exige SESSION_SECRET de 32 caracteres fuera del modo dev", async () => {
    setEnv({ ...ownerEnv, SESSION_SECRET: "corto" });
    await expect(login(EMAIL, PASSWORD, "10.0.0.7", db)).rejects.toMatchObject({ code: "externo", message: expect.stringContaining("SESSION_SECRET") });
    setEnv({ OWNER_EMAIL: EMAIL });
    await expect(login(EMAIL, PASSWORD, "10.0.0.7", db)).rejects.toMatchObject({ code: "externo" });
  });

  it("cookie de sesión: httpOnly, lax, 30 días y segura solo con https", () => {
    setEnv({ ...ownerEnv, APP_URL: "https://fit.example.test" });
    expect(SESSION_COOKIE).toBe("fit_session");
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 2_592_000 });
    setEnv({ ...ownerEnv, APP_URL: "http://localhost:3000" });
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it("modo dev: solo con AUTH_MODE=dev y sin DATABASE_URL", async () => {
    setEnv({ AUTH_MODE: "dev", DATABASE_URL: "postgres://x" });
    expect(isDevAuth()).toBe(false);
    await expect(ensureDevUser(db)).rejects.toMatchObject({ code: "no_autorizado" });
    setEnv({ AUTH_MODE: "dev" });
    expect(isDevAuth()).toBe(true);
    const id = await ensureDevUser(db);
    expect(await ensureDevUser(db)).toBe(id);
    expect((await getAthlete(id, undefined, db)).email).toBe("dev@local");
    const session = await login("quien@sea", "da igual", "127.0.0.1", db);
    expect(session.userId).toBe(id);
    expect(await verifySessionToken(session.token)).toBe(id);
  });
});

describe("onboarding", () => {
  let user: string;
  beforeAll(async () => {
    const [r] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('nuevo@test.local') returning id"), db);
    user = r.id;
    await asSystem(async (tx) => {
      await tx.query("insert into fit.muscle_groups (id, name, region, default_mev, default_mrv) values ('biceps', 'Bíceps', 'brazo', 8, 20)");
      await tx.query("insert into fit.exercises (slug, name, primary_muscle) values ('curl-biceps', 'Curl de bíceps', 'biceps')");
    }, db);
  });

  it("recién creado: detecta todo lo que falta y la contradicción de la altura", async () => {
    const s = await getOnboardingStatus(user, undefined, db);
    expect(s.complete).toBe(false);
    expect(s.missing.map((m) => m.field)).toEqual(["heightCm", "birthDate", "weightKg", "waistCm", "hrRest", "bedtime", "ankle", "program", "adhdMedication", "weeklyFoodBudgetEur"]);
    expect(s.missing.every((m) => m.question.length > 5 && m.why.length > 5)).toBe(true);
    expect(s.contradictions).toEqual(["Altura: 174 cm en la hoja de junio, 164 cm en otra ficha. Confirma cuál."]);
  });

  it("la altura sin confirmar sigue contando como pendiente", async () => {
    await updateAthlete(user, { heightCm: 174 }, db);
    const s = await getOnboardingStatus(user, undefined, db);
    expect(s.missing.map((m) => m.field)).toContain("heightCm");
    expect(s.contradictions).toHaveLength(1);
    await expect(updateAthlete(user, { hrRest: 300 }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });

  it("guarda ficha, medidas, tobillo, clases y exámenes en una transacción", async () => {
    const r = await saveOnboarding(user, {
      name: "Alex", birthDate: "2004-03-10", heightCm: 174, bedtime: "23:30", wakeTime: "07:30", hrRest: 58, adhd: true, adhdMedication: false,
      weeklyFoodBudgetEur: 60, stores: ["mercadona", "lidl"], goalWeightKg: 82,
      weightKg: 92.4, waistCm: 100, neckCm: 40, measuredOn: "2026-11-20",
      ankle: { status: "abierta", painToday: 2, side: "derecho", limits: "Molesta al correr" },
      classes: [{ title: "Contabilidad", weekday: 1, start: "09:00", end: "11:00" }, { title: "Marketing", weekday: 3, start: "11:00", end: "13:00" }],
      exams: [{ title: "Exámenes de enero", from: "2027-01-11", to: "2027-01-29" }],
      marks: { years: 2, technique: 2, progress: 2, education: 3, lifts: { bench: 100, squat: 140 } },
    }, db);
    expect(r.status.missing.map((m) => m.field)).toEqual(["program"]);
    expect(r.status.contradictions).toEqual([]);
    expect(r.athlete).toMatchObject({ name: "Alex", heightCm: 174, heightConfirmed: true, bedtime: "23:30", hrRest: 58, adhdMedication: false, onboardedAt: null });
    expect(r.trainingLevel).toEqual({ score: 2, label: "Intermedio" });
    expect(r.athlete.trainingLevel).toBe(2);

    const [ankle] = await listInjuries(user, undefined, db);
    expect(ankle).toMatchObject({ zone: "tobillo", status: "abierta", side: "derecho", lastPain: 2, lastPainDate: "2026-11-20", logs: 1 });
    expect((await listSchedule(user, { kind: "clase" }, db)).map((b) => [b.title, b.weekday, b.start, b.end])).toEqual([["Contabilidad", 1, "09:00", "11:00"], ["Marketing", 3, "11:00", "13:00"]]);
    expect(await isExamPeriod(user, "2027-01-15", db)).toBe(true);
    expect(await isExamPeriod(user, "2027-02-01", db)).toBe(false);
  });

  it("volver a guardar sustituye las clases y no duplica", async () => {
    await saveOnboarding(user, { classes: [{ title: "Finanzas", weekday: 2, start: "10:00", end: "12:00" }] }, db);
    expect((await listSchedule(user, undefined, db)).map((b) => [b.kind, b.title])).toEqual([["clase", "Finanzas"], ["examen", "Exámenes de enero"]]);
  });

  it("con el programa activo, el onboarding queda completo y fechado", async () => {
    const template = { slug: "mini", name: "Mini", goal: "definicion", mesocycles: [{ name: "B1", sessions: [{ name: "A", exercises: [{ exercise: "curl-biceps", sets: 3, rep_min: 8, rep_max: 12 }] }] }] };
    await activateProgram(user, { slug: "mini", startDate: "2026-11-23" }, db, { template });
    expect((await getOnboardingStatus(user, undefined, db)).complete).toBe(true);
    const r = await saveOnboarding(user, {}, db);
    expect(r.status).toEqual({ complete: true, missing: [], contradictions: [] });
    expect(r.athlete.onboardedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
