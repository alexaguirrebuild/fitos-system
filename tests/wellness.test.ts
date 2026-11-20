import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { POMS_MAP, scorePoms } from "@/engine";
import { getAnkleStatus, listInjuries, updateAthlete } from "@/server/services/athlete";
import {
  getCheckin, getPomsItems, listBodyMetrics, listCheckins, listPoms, logBodyMetrics, saveCheckin, savePoms,
} from "@/server/services/wellness";

let db: Db;
let a: string;
let b: string;

const good = { sleepQuality: 8, stress: 3, motivation: 8, pain: 2, fatigue: 3 };

beforeAll(async () => {
  db = await openMemoryDb();
  const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('a@test.local'), ('b@test.local') returning id"), db);
  [a, b] = rows.map((r) => r.id);
});
afterAll(async () => db.close());

describe("check-in", () => {
  it("calcula el readiness y su banda; sin historial no hay línea base", async () => {
    const r = await saveCheckin(a, { date: "2026-11-01", ...good, sleepHours: 7.5, note: "Bien" }, db);
    // 8·3 + (10−3)·2,5 + 8·2 + (10−2)·1,5 + (10−3)·1 = 76,5 → 77
    expect(r).toMatchObject({ date: "2026-11-01", readiness: 77, band: "completa", baseline: null });
    expect(r.label).toContain("Sesión completa");
    expect(r.checkin).toMatchObject({ sleepQuality: 8, sleepHours: 7.5, stress: 3, readiness: 77, note: "Bien", anklePain: null });
    expect(r.ankle.rule.restricted).toBe(false);
  });

  it("es un upsert por día", async () => {
    const r = await saveCheckin(a, { date: "2026-11-01", sleepQuality: 4, stress: 7, motivation: 4, pain: 5, fatigue: 7 }, db);
    // 12 + 7,5 + 8 + 7,5 + 3 = 38
    expect(r).toMatchObject({ readiness: 38, band: "solo_efectivas" });
    expect(r.checkin).toMatchObject({ sleepHours: 7.5, note: "Bien" }); // lo que no llega se conserva
    expect(await listCheckins(a, { days: 30, to: "2026-11-01" }, db)).toHaveLength(1);
    expect(await getCheckin(a, "2026-11-01", db)).toMatchObject({ readiness: 38, band: "solo_efectivas" });
    expect(await getCheckin(a, "2026-10-31", db)).toBeNull();
  });

  it("con 7 días o más compara contra la media propia de 28 días", async () => {
    for (let d = 2; d <= 8; d++) await saveCheckin(a, { date: `2026-11-0${d}`, ...good }, db); // siete días de 77
    const r = await saveCheckin(a, { date: "2026-11-09", sleepQuality: 3, stress: 8, motivation: 3, pain: 4, fatigue: 8 }, db);
    // Historial: 38 y siete veces 77 → media 72,1. Hoy 9 + 5 + 6 + 9 + 2 = 31.
    expect(r.readiness).toBe(31);
    expect(r.band).toBe("solo_efectivas");
    expect(r.baseline?.mean).toBeCloseTo(72.1, 1);
    expect(r.baseline!.z).toBeLessThan(-2);
    const list = await listCheckins(a, { days: 7, to: "2026-11-09" }, db);
    expect(list.map((c) => c.date)).toEqual(["2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03"]);
  });

  it("el dolor de tobillo del check-in se apunta en la lesión y aplica la regla", async () => {
    const r = await saveCheckin(a, { date: "2026-11-10", ...good, anklePain: 5 }, db);
    expect(r.ankle).toMatchObject({ pain: 5, painDate: "2026-11-10", painSource: "lesion" });
    expect(r.ankle.rule).toMatchObject({ restricted: true, squatCapPct: 75 });
    const [inj] = await listInjuries(a, undefined, db);
    expect(inj).toMatchObject({ zone: "tobillo", status: "abierta", lastPain: 5, logs: 1 });
    // Sin registro nuevo, el último dolor se arrastra tres días y luego deja de contar.
    expect((await getAnkleStatus(a, "2026-11-13", db)).pain).toBe(5);
    expect((await getAnkleStatus(a, "2026-11-14", db))).toMatchObject({ pain: null, rule: { restricted: false } });
  });

  it("valida la entrada y no mezcla atletas", async () => {
    await expect(saveCheckin(a, { ...good, pain: 0 }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
    await expect(saveCheckin(a, { ...good, date: "10/11/2026" }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
    expect(await listCheckins(b, { days: 60, to: "2026-11-30" }, db)).toEqual([]);
  });
});

describe("POMS", () => {
  it("devuelve el cuestionario de 52 ítems", () => {
    const q = getPomsItems();
    expect(q.items).toHaveLength(52);
    expect(q.items[0]).toEqual({ n: 1, text: "Tenso" });
    expect(q.scale.map((s) => s.value)).toEqual([0, 1, 2, 3, 4]);
  });

  it("puntúa con el motor, guarda y reconoce el perfil iceberg", async () => {
    const answers = Array(52).fill(0) as number[];
    for (const n of POMS_MAP.vigor) answers[n - 1] = 4;
    answers[19 - 1] = 4; // «Relajado» puntúa al revés: 4 = nada de tensión
    const expected = scorePoms(answers);
    const r = await savePoms(a, { answers, date: "2026-11-09" }, db);
    expect(r).toMatchObject({ date: "2026-11-09", tension: 0, depression: 0, anger: 0, fatigue: 0, vigor: 36, tmd: -36, shape: "iceberg" });
    expect([r.tension, r.vigor, r.tmd, r.shape]).toEqual([expected.tension, expected.vigor, expected.tmd, expected.shape]);
    expect(r.normalized.vigor).toBe(1);
    expect(r.reading).toContain("iceberg");
    const stored = await withUser(a, (tx) => tx.query<{ answers: number[] }>("select answers from fit.poms_tests"), db);
    expect(stored[0].answers).toEqual(answers);
  });

  it("repetir el test el mismo día lo sustituye; el invertido se detecta", async () => {
    const tired = Array(52).fill(0) as number[];
    for (const n of [...POMS_MAP.fatiga, ...POMS_MAP.tension]) tired[n - 1] = 4;
    const r = await savePoms(a, { answers: tired, date: "2026-11-09" }, db);
    expect(r.shape).toBe("invertido");
    expect(r.fatigue).toBe(20);
    expect(await listPoms(a, undefined, db)).toHaveLength(1);
    await expect(savePoms(a, { answers: [1, 2, 3] }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
    await expect(savePoms(a, { answers: Array(52).fill(5) }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });
});

describe("medidas corporales", () => {
  it("mezcla lo que llega con lo que ya había ese día", async () => {
    const first = await logBodyMetrics(a, { date: "2026-11-09", weightKg: 92.4, skinfolds: { abdominal: 28 } }, db);
    expect(first).toMatchObject({ weightKg: 92.4, waistCm: null, bfPct: null });
    expect(first.warnings.join(" ")).toContain("Altura sin confirmar");
    const second = await logBodyMetrics(a, { date: "2026-11-09", waistCm: 100, skinfolds: { tricipital: 14 }, note: "En ayunas" }, db);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ weightKg: 92.4, waistCm: 100, note: "En ayunas", skinfolds: { abdominal: 28, tricipital: 14 }, bfPct: null });
    expect(await listBodyMetrics(a, { days: 30, to: "2026-11-09" }, db)).toHaveLength(1);
  });

  it("con la altura confirmada recalcula el % graso (Navy si hay cuello, RFM si no)", async () => {
    await updateAthlete(a, { heightCm: 174, heightConfirmed: true }, db);
    const rfm = await logBodyMetrics(a, { date: "2026-11-09", waistCm: 100 }, db);
    // RFM hombre: 64 − 20·(174/100) = 29,2
    expect(rfm).toMatchObject({ bfPct: 29.2, bfMethod: "rfm", bfMarginPts: 5, waistToHeight: 0.57, warnings: [] });
    expect(rfm.leanKg).toBeCloseTo(92.4 * (1 - 0.292), 1);
    const navy = await logBodyMetrics(a, { date: "2026-11-09", neckCm: 40 }, db);
    expect(navy.bfMethod).toBe("navy");
    expect(navy.bfPct).toBeGreaterThan(20);
    expect(navy.bfPct).toBeLessThan(32);
    expect(navy).toMatchObject({ weightKg: 92.4, waistCm: 100, neckCm: 40 });
  });

  it("un día solo con cintura usa el último peso para la masa magra", async () => {
    const r = await logBodyMetrics(a, { date: "2026-11-16", waistCm: 98 }, db);
    expect(r).toMatchObject({ weightKg: null, waistCm: 98, bfMethod: "rfm", bfPct: 28.5 });
    expect(r.leanKg).toBeCloseTo(92.4 * (1 - 0.285), 1);
    expect((await listBodyMetrics(a, { days: 30, to: "2026-11-16" }, db)).map((m) => m.date)).toEqual(["2026-11-16", "2026-11-09"]);
    await expect(logBodyMetrics(a, { date: "2026-11-17" }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
    await expect(logBodyMetrics(a, { weightKg: 5 }, db)).rejects.toMatchObject({ code: "entrada_invalida" });
  });
});
