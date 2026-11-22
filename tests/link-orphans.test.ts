import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, pendingMigrations, withUser, type Db } from "@/db/client";
import { linkOrphans, parseOrphanMap } from "@/server/link-orphans";
import { seedCatalog } from "@/server/seed";

// Mapa inventado: mismo formato que el real (que vive en VIDA y no entra en git).
const MAP = `---
titulo: Mapa de prueba
---

# Mapa

| Series | Nombre crudo | Última | Ejercicio |
|---|---|---|---|
| 2 | Pres banca plano | 2026-06-01 | \`press-banca\` |
| 1 | Banca con  pausa | 2026-06-01 | \`press-banca\` |
| 1 | Sentadillita rara | 2026-06-01 | \`sentadilla-high-bar\` |

Texto suelto entre tablas | con barras | que no es una fila.

| Series | Nombre crudo | Última | Ejercicio |
|---|---|---|---|
| 2 | Remo con la barrita a\\|b | 2026-06-02 | \`NUEVO remo-con-barra\` |
`;

describe("parseOrphanMap", () => {
  it("lee las filas con slug, quita NUEVO y respeta las barras escapadas", () => {
    expect(parseOrphanMap(MAP)).toEqual([
      { rawName: "Pres banca plano", slug: "press-banca" },
      { rawName: "Banca con pausa", slug: "press-banca" },
      { rawName: "Sentadillita rara", slug: "sentadilla-high-bar" },
      { rawName: "Remo con la barrita a|b", slug: "remo-con-barra" },
    ]);
  });

  it("rechaza un nombre enlazado a dos ejercicios y un slug mal formado", () => {
    expect(() => parseOrphanMap("| 1 | A | x | `press-banca` |\n| 1 | A | x | `dominadas` |")).toThrow(/dos ejercicios/);
    expect(() => parseOrphanMap("| 1 | A | x | `Press Banca` |")).toThrow(/no válida/);
    expect(parseOrphanMap("| 1 | A | x | `press-banca` |\n| 1 | A | x | `press-banca` |")).toHaveLength(1);
  });
});

describe("linkOrphans", () => {
  let db: Db;
  let u: string;
  const sets = () => withUser(u, (tx) => tx.query<{ raw: string; ex: string | null }>(
    "select exercise_name_raw as raw, exercise_id as ex from fit.workout_sets order by exercise_name_raw, set_index"), db);

  beforeAll(async () => {
    db = await openMemoryDb();
    await seedCatalog(db);
    [{ id: u }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('huerfanos@test.local') returning id"), db);
    await withUser(u, async (tx) => {
      const [w] = await tx.query<{ id: string }>("insert into fit.workouts (date, name, status) values ('2026-06-01', 'Vieja', 'hecha') returning id");
      // «Banca con  pausa » lleva doble espacio y uno al final: la tabla Markdown los pierde y aun así tiene que casar.
      await tx.query(
        `insert into fit.workout_sets (workout_id, exercise_name_raw, exercise_position, set_index, kg, reps) values
           ($1, 'Pres banca plano', 1, 1, 60, 8), ($1, 'Pres banca plano', 1, 2, 60, 7),
           ($1, 'Banca con  pausa ', 2, 1, 50, 5), ($1, 'Sentadillita rara', 3, 1, 80, 5),
           ($1, 'Remo con la barrita a|b', 4, 1, 40, 10), ($1, 'Remo con la barrita a|b', 4, 2, 40, 10),
           ($1, 'Cosa que no está en el mapa', 5, 1, 10, 10)`, [w.id]);
    }, db);
  });
  afterAll(async () => db.close());

  it("en simulacro dice lo que haría y no escribe", async () => {
    const before = await sets();
    const r = await linkOrphans(u, parseOrphanMap(MAP), { dryRun: true }, db);
    expect(r).toMatchObject({ dryRun: true, linkedSets: 6, linkedNames: 4, remainingSets: 1, unknownSlugs: [] });
    expect(r.remaining).toEqual([{ rawName: "Cosa que no está en el mapa", sets: 1 }]);
    expect(await sets()).toEqual(before);
  });

  it("enlaza todo lo del mapa, al mismo ejercicio visible, y repetirlo no hace nada", async () => {
    const r = await linkOrphans(u, parseOrphanMap(MAP), { dryRun: false }, db);
    expect(r).toMatchObject({ linkedSets: 6, linkedNames: 4, remainingSets: 1 });
    expect(r.actions.every((a) => !a.error)).toBe(true);
    const after = await sets();
    expect(after.filter((s) => !s.ex).map((s) => s.raw)).toEqual(["Cosa que no está en el mapa"]);

    // Los dos nombres de press banca acaban en el mismo ejercicio (la copia propia que crea el primer alias), no partidos.
    const banca = new Set(after.filter((s) => /banca/i.test(s.raw)).map((s) => s.ex));
    expect(banca.size).toBe(1);
    const [own] = await withUser(u, (tx) => tx.query<{ slug: string; user_id: string | null; aliases: string[] }>(
      "select slug, user_id, aliases from fit.exercises where id = $1", [[...banca][0]]), db);
    expect(own).toMatchObject({ slug: "press-banca", user_id: u });
    expect(own.aliases).toEqual(expect.arrayContaining(["Pres banca plano", "Banca con  pausa"]));

    const again = await linkOrphans(u, parseOrphanMap(MAP), { dryRun: false }, db);
    expect(again).toMatchObject({ linkedSets: 0, linkedNames: 0, remainingSets: 1 });
    expect(again.actions.every((a) => !a.error && a.matches.length === 0 && a.alreadyLinked)).toBe(true);
    expect(await sets()).toEqual(after);
  });

  it("distingue «ya enlazado» de «no aparece en la base»", async () => {
    const r = await linkOrphans(u, parseOrphanMap("| 1 | Pres banca plano | x | `press-banca` |\n| 1 | Nombre que nunca existió | x | `press-banca` |"), { dryRun: true }, db);
    expect(r.actions.map((a) => a.alreadyLinked)).toEqual([true, false]);
  });

  it("el simulacro ve el mismo conflicto de alias que la ejecución real", async () => {
    // «remo barra» ya es alias de remo-con-barra: enlazarlo a dominadas lo rechazaría addAliasTx.
    const [{ id: v }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('conflicto@test.local') returning id"), db);
    await withUser(v, async (tx) => {
      const [w] = await tx.query<{ id: string }>("insert into fit.workouts (date, name, status) values ('2026-06-03', 'Vieja', 'hecha') returning id");
      await tx.query(
        `insert into fit.workout_sets (workout_id, exercise_name_raw, exercise_position, set_index, kg, reps) values
           ($1, 'Remo barra', 1, 1, 40, 10), ($1, 'Jalón raro', 2, 1, 40, 10)`, [w.id]);
    }, db);
    const map = parseOrphanMap("| 1 | Remo barra | x | `dominadas` |\n| 1 | Jalón raro | x | `dominadas` |");
    const dry = await linkOrphans(v, map, { dryRun: true }, db);
    expect(dry.actions[0].error).toMatch(/ya es el nombre de Remo con barra/);
    expect(dry).toMatchObject({ linkedSets: 1, remainingSets: 1 });
    const real = await linkOrphans(v, map, { dryRun: false }, db);
    expect(real.actions[0].error).toMatch(/ya es el nombre de Remo con barra/);
    expect(real).toMatchObject({ linkedSets: 1, remainingSets: 1 });
  });

  it("no hay migraciones pendientes en una base recién migrada", async () => {
    expect(await pendingMigrations(db)).toEqual([]);
  });

  it("con un slug que no existe no escribe nada (salvo en simulacro, que lo avisa)", async () => {
    const map = "| 1 | Cosa que no está en el mapa | x | `no-existe` |";
    const dry = await linkOrphans(u, parseOrphanMap(map), { dryRun: true }, db);
    expect(dry).toMatchObject({ unknownSlugs: ["no-existe"], linkedSets: 0, remainingSets: 1 });
    const before = await sets();
    await expect(linkOrphans(u, parseOrphanMap(map), { dryRun: false }, db)).rejects.toThrow(/no-existe/);
    expect(await sets()).toEqual(before);
  });
});
