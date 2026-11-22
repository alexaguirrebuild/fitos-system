import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { adjustExercises, parseAliasList } from "@/server/exercise-adjust";
import { seedCatalog } from "@/server/seed";
import { linkRawName, loadLibraryTx } from "@/server/services/library";

// Todo inventado: ni nombres ni notas reales.
describe("parseAliasList", () => {
  it("lee solo las filas «quitar», con su ejercicio, y compara sin espacios de sobra", () => {
    const md = [
      "# Lista", "", "| Nombre crudo | Ejercicio | Acción |", "|---|---|---|",
      "| Nota  larga del lunes | `press-banca` | quitar |",
      "| Pres banca plano | `press-banca` | mantener |",
      "| Otra nota a\\|b | `NUEVO dominadas` | quitar |",
      "", "Texto | con | barras | quitar",
    ].join("\n");
    expect(parseAliasList(md)).toEqual([
      { slug: "press-banca", alias: "Nota larga del lunes" },
      { slug: "dominadas", alias: "Otra nota a|b" },
    ]);
  });

  it("rechaza una fila «quitar» sin slug válido", () => {
    expect(() => parseAliasList("| Nota | `Press Banca` | quitar |")).toThrow(/no válida/);
  });
});

describe("adjustExercises", () => {
  let db: Db;
  let u: string;
  let o: string;
  const PLAN = {
    merges: [{ from: "remo-falso", to: "remo-ancho-apoyado-en-mp" }],
    equipment: [{ slug: "elevacion-frontal-banco-inclinado", equipment: "mancuernas" as const }],
    removeAliases: [
      { slug: "remo-falso", alias: "Remo falso y una nota" },
      { slug: "elevacion-frontal-banco-inclinado", alias: "Elevacion  con nota larga" },
      { slug: "sentadilla-high-bar", alias: "Nota de sentadilla del lunes" },
      { slug: "press-banca", alias: "Remo falso buen nombre" }, // mismo texto que un alias del remo, pero de otro ejercicio: no se toca
      { slug: "dominadas", alias: "No existe en ningún sitio" },
    ],
  };
  const commonId = async (slug: string) =>
    (await asSystem((tx) => tx.query<{ id: string }>("select id from fit.exercises where slug = $1 and user_id is null", [slug]), db))[0]?.id;
  const visible = async (who: string, slug: string) => (await withUser(who, loadLibraryTx, db)).find((e) => e.slug === slug);
  const state = (who: string) => withUser(who, async (tx) => ({
    ex: await tx.query("select slug, user_id, equipment, equipment_type, aliases from fit.exercises where user_id is not null order by slug"),
    sets: await tx.query<{ raw: string; ex: string | null }>("select exercise_name_raw as raw, exercise_id as ex from fit.workout_sets order by exercise_name_raw, set_index"),
    wex: await tx.query("select workout_id, exercise_id, replaces_exercise_id from fit.workout_exercises order by workout_id, position"),
  }), db);
  const workout = (who: string, date = "2026-06-01") => withUser(who, async (tx) =>
    (await tx.query<{ id: string }>("insert into fit.workouts (date, name, status) values ($1, 'Vieja', 'hecha') returning id", [date]))[0].id, db);
  const addSets = (who: string, w: string, rows: [string, string | null][]) => withUser(who, async (tx) => {
    for (const [i, [raw, ex]] of rows.entries())
      await tx.query("insert into fit.workout_sets (workout_id, exercise_name_raw, exercise_id, exercise_position, set_index, kg, reps) values ($1, $2, $3, $4, 1, 40, 10)",
        [w, raw, ex, i + 1]);
  }, db);

  beforeAll(async () => {
    db = await openMemoryDb();
    await seedCatalog(db);
    // Ejercicios comunes que ya no están en el seed (como el remo duplicado en producción).
    for (const [slug, aliases] of [["remo-falso", ["remo falso de catalogo"]], ["remo-falso-compartido", []], ["remo-falso-choque", []]] as const)
      await asSystem((tx) => tx.query("insert into fit.exercises (slug, name, aliases, primary_muscle, kind, equipment) values ($1, $2, $3, 'espalda', 'compuesto', 'multipower')",
        [slug, `Remo ${slug}`, aliases]), db);
    [{ id: u }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('ajuste@test.local') returning id"), db);
    [{ id: o }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('otro@test.local') returning id"), db);

    const w = await workout(u);
    await addSets(u, w, [["Remo falso y una nota", null], ["Remo falso y una nota", null], ["Remo falso buen nombre", null],
      ["Elevacion  con nota larga", null], ["Nota de sentadilla del lunes", null], ["Pres banca plano", null]]);
    const ids = new Map((await withUser(u, loadLibraryTx, db)).map((e) => [e.slug, e.id]));
    // Como en producción: linkRawName crea la copia propia y guarda el nombre crudo como alias.
    await linkRawName(u, { rawName: "Remo falso y una nota", exerciseId: ids.get("remo-falso")! }, db);
    await linkRawName(u, { rawName: "Remo falso buen nombre", exerciseId: ids.get("remo-falso")! }, db);
    await linkRawName(u, { rawName: "Elevacion  con nota larga", exerciseId: ids.get("elevacion-frontal-banco-inclinado")! }, db);
    await linkRawName(u, { rawName: "Nota de sentadilla del lunes", exerciseId: ids.get("sentadilla-high-bar")! }, db);
    await linkRawName(u, { rawName: "Pres banca plano", exerciseId: ids.get("press-banca")! }, db);
    const remo = (await visible(u, "remo-falso"))!.id;
    const ancho = (await visible(u, "remo-ancho-apoyado-en-mp"))!.id;
    // En otra sesión, el remo ancho sustituyó al remo falso: tras fusionar sería una sustitución de sí mismo.
    const w2 = await workout(u, "2026-06-02");
    await withUser(u, (tx) => tx.query("insert into fit.workout_exercises (workout_id, exercise_id, position, replaces_exercise_id, origin) values ($1, $2, 1, $3, 'cambio')",
      [w2, ancho, remo]), db);
    // La copia de la elevación se hizo cuando el catálogo aún no tenía equipo.
    await withUser(u, (tx) => tx.query("update fit.exercises set equipment = null, equipment_type = 'libre' where slug = 'elevacion-frontal-banco-inclinado'"), db);

    // El otro atleta: una serie en la fila común compartida y un alias propio con el mismo texto que la lista.
    const wo = await workout(o);
    await addSets(o, wo, [["Remo compartido", await commonId("remo-falso-compartido")], ["Nota de sentadilla del lunes", null]]);
    await linkRawName(o, { rawName: "Nota de sentadilla del lunes", exerciseId: (await visible(o, "sentadilla-high-bar"))!.id }, db);
  });
  afterAll(async () => db.close());

  it("el simulacro cuenta lo que haría y no escribe", async () => {
    const before = await state(u);
    const r = await adjustExercises(u, PLAN, { dryRun: true }, db);
    expect(r.merges).toEqual([expect.objectContaining({ found: true, moved: 4, sets: 3, ownDeleted: 1 })]);
    expect(r.merges[0].carried.sort()).toEqual(["Remo falso buen nombre", "Remo remo-falso", "remo falso de catalogo"]);
    expect(r.commonDeletes).toEqual([{ slug: "remo-falso", exists: true, inSeed: false, refsLeft: 0, deleted: false }]);
    expect(r.equipment).toEqual([{ slug: "elevacion-frontal-banco-inclinado", ownCopy: true, from: null, to: "mancuernas", changed: true }]);
    expect(r.aliases.flatMap((a) => a.removed).sort()).toEqual(["Elevacion  con nota larga", "Nota de sentadilla del lunes", "Remo falso y una nota"]);
    expect(r.aliasesNotFound).toEqual([{ slug: "press-banca", alias: "Remo falso buen nombre" }, { slug: "dominadas", alias: "No existe en ningún sitio" }]);
    expect(await state(u)).toEqual(before);
    expect(await commonId("remo-falso")).toBeTruthy();
  });

  it("fusiona, pasa los nombres, cambia el equipo y quita solo los alias de la lista; repetirlo no hace nada", async () => {
    const other = await state(o);
    const r = await adjustExercises(u, PLAN, { dryRun: false }, db);
    expect(r.merges[0]).toMatchObject({ moved: 4, ownDeleted: 1 });
    expect(r.commonDeletes[0]).toMatchObject({ deleted: true });

    const lib = await withUser(u, loadLibraryTx, db);
    const target = lib.find((e) => e.slug === "remo-ancho-apoyado-en-mp")!;
    expect(target.userId).toBe(u); // copia propia del destino, para poder guardar los nombres
    expect(target.aliases).toEqual(expect.arrayContaining(["Remo falso buen nombre", "Remo remo-falso", "remo falso de catalogo"]));
    expect(target.aliases).not.toContain("Remo falso y una nota");
    const s = await state(u);
    expect(s.sets.filter((x) => x.raw.startsWith("Remo falso")).every((x) => x.ex === target.id)).toBe(true);
    expect(s.wex).toEqual([expect.objectContaining({ exercise_id: target.id, replaces_exercise_id: null })]);
    expect(lib.some((e) => e.slug === "remo-falso")).toBe(false);
    expect(await commonId("remo-falso")).toBeUndefined();
    expect(lib.find((e) => e.slug === "elevacion-frontal-banco-inclinado")).toMatchObject({ equipment: "mancuernas", equipmentType: "libre" });
    expect(lib.find((e) => e.slug === "press-banca")!.aliases).toContain("Pres banca plano");
    expect(lib.find((e) => e.slug === "sentadilla-high-bar")!.aliases).not.toContain("Nota de sentadilla del lunes");
    // Ninguna serie se queda sin ejercicio, el otro atleta no cambia (RLS) y el catálogo común no se toca.
    expect(s.sets.every((x) => x.ex)).toBe(true);
    expect(await state(o)).toEqual(other);
    const [common] = await asSystem((tx) => tx.query<{ aliases: string[] }>("select aliases from fit.exercises where slug = 'remo-ancho-apoyado-en-mp' and user_id is null"), db);
    expect(common.aliases).not.toContain("Remo falso buen nombre");

    const again = await adjustExercises(u, PLAN, { dryRun: false }, db);
    expect(again.merges[0]).toMatchObject({ found: false, moved: 0, carried: [] });
    expect(again.commonDeletes[0]).toMatchObject({ exists: false, deleted: false });
    expect(again.equipment[0]).toMatchObject({ changed: false });
    expect(again.aliases).toEqual([]);
    expect(await state(u)).toEqual(s);
  });

  it("no borra la fila común si otro atleta la usa", async () => {
    await addSets(u, await workout(u, "2026-06-03"), [["Remo compartido mío", await commonId("remo-falso-compartido")]]);
    const plan = { merges: [{ from: "remo-falso-compartido", to: "remo-ancho-apoyado-en-mp" }] };
    expect((await adjustExercises(u, plan, { dryRun: true }, db)).commonDeletes[0]).toMatchObject({ refsLeft: 1, deleted: false });
    const r = await adjustExercises(u, plan, { dryRun: false }, db);
    expect(r.merges[0]).toMatchObject({ moved: 1, ownDeleted: 0 });
    expect(r.commonDeletes[0]).toMatchObject({ exists: true, refsLeft: 1, deleted: false });
    expect(await commonId("remo-falso-compartido")).toBeTruthy();
  });

  it("no borra una fila común que sigue en el seed", async () => {
    const [{ id: z }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('sin-datos@test.local') returning id"), db);
    const r = await adjustExercises(z, { merges: [{ from: "remo-con-barra", to: "remo-ancho-apoyado-en-mp" }] }, { dryRun: false }, db);
    expect(r.commonDeletes[0]).toMatchObject({ exists: true, inSeed: true, deleted: false });
    expect(await commonId("remo-con-barra")).toBeTruthy();
  });

  it("si una sesión tiene los dos ejercicios, falla también en el simulacro y no escribe", async () => {
    const w = await workout(u, "2026-06-04");
    const before = await state(u);
    // Los ids, fuera: una transacción dentro de otra bloquea la conexión única de PGlite.
    const choque = await commonId("remo-falso-choque");
    const ancho = (await visible(u, "remo-ancho-apoyado-en-mp"))!.id;
    await withUser(u, async (tx) => {
      await tx.query("insert into fit.workout_exercises (workout_id, exercise_id, position) values ($1, $2, 1)", [w, choque]);
      await tx.query("insert into fit.workout_exercises (workout_id, exercise_id, position) values ($1, $2, 2)", [w, ancho]);
    }, db);
    const plan = { merges: [{ from: "remo-falso-choque", to: "remo-ancho-apoyado-en-mp" }] };
    await expect(adjustExercises(u, plan, { dryRun: true }, db)).rejects.toThrow(/a la vez/);
    const mid = await state(u);
    await expect(adjustExercises(u, plan, { dryRun: false }, db)).rejects.toThrow(/a la vez/);
    expect(await state(u)).toEqual(mid);
    expect(mid.wex.length).toBe(before.wex.length + 2);
  });

  it("rechaza planes incoherentes", async () => {
    await expect(adjustExercises(u, { merges: [{ from: "press-banca", to: "press-banca" }] }, { dryRun: true }, db)).rejects.toThrow(/sí misma/);
    await expect(adjustExercises(u, { merges: [{ from: "press-banca", to: "no-existe" }] }, { dryRun: true }, db)).rejects.toThrow(/no-existe/);
    await expect(adjustExercises(u, { equipment: [{ slug: "press-banca", equipment: "nave" as never }] }, { dryRun: true }, db)).rejects.toThrow();
  });
});
