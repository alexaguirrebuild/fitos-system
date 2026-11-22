import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { adjustExercises, parseAliasList } from "@/server/exercise-adjust";
import { seedCatalog } from "@/server/seed";
import { linkRawName, loadLibraryTx } from "@/server/services/library";

// Todo inventado: ni nombres ni notas reales.
describe("parseAliasList", () => {
  it("lee solo las filas «quitar» y compara sin espacios de sobra", () => {
    const md = `# Lista\n\n| Nombre crudo | Ejercicio | Acción |\n|---|---|---|\n| Nota  larga del lunes | \`press-banca\` | quitar |\n| Pres banca plano | \`press-banca\` | mantener |\n| Otra nota | \`dominadas\` | quitar |\n\nTexto | con | barras | quitar? no.`;
    expect(parseAliasList(md)).toEqual(["Nota larga del lunes", "Otra nota"]);
  });
});

describe("adjustExercises", () => {
  let db: Db;
  let u: string;
  let o: string;
  const PLAN = {
    merges: [{ from: "remo-falso", to: "remo-ancho-apoyado-en-mp" }],
    equipment: [{ slug: "elevacion-frontal-banco-inclinado", equipment: "mancuernas" as const }],
    removeAliases: ["Remo falso y una nota", "Elevacion  con nota larga", "Nota de sentadilla del lunes", "No existe en ningún sitio"],
  };
  const commonId = async (slug: string) =>
    (await asSystem((tx) => tx.query<{ id: string }>("select id from fit.exercises where slug = $1 and user_id is null", [slug]), db))[0]?.id;
  const state = (who: string) => withUser(who, async (tx) => ({
    ex: await tx.query("select slug, user_id, equipment, equipment_type, aliases from fit.exercises where user_id is not null order by slug"),
    sets: await tx.query("select exercise_name_raw, exercise_id from fit.workout_sets order by exercise_name_raw, set_index"),
  }), db);
  const addSets = (who: string, rows: [string, string | null][]) => withUser(who, async (tx) => {
    const [w] = await tx.query<{ id: string }>("insert into fit.workouts (date, name, status) values ('2026-06-01', 'Vieja', 'hecha') returning id");
    for (const [i, [raw, ex]] of rows.entries())
      await tx.query("insert into fit.workout_sets (workout_id, exercise_name_raw, exercise_id, exercise_position, set_index, kg, reps) values ($1, $2, $3, $4, 1, 40, 10)",
        [w.id, raw, ex, i + 1]);
  }, db);

  beforeAll(async () => {
    db = await openMemoryDb();
    await seedCatalog(db);
    // Un ejercicio común que ya no está en el seed (como el remo duplicado en producción) y otro que usa también otro atleta.
    for (const slug of ["remo-falso", "remo-falso-compartido"])
      await asSystem((tx) => tx.query("insert into fit.exercises (slug, name, primary_muscle, kind, equipment) values ($1, $2, 'espalda', 'compuesto', 'multipower')",
        [slug, `Remo ${slug}`]), db);
    [{ id: u }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('ajuste@test.local') returning id"), db);
    [{ id: o }] = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('otro@test.local') returning id"), db);

    await addSets(u, [["Remo falso y una nota", null], ["Remo falso y una nota", null], ["Elevacion  con nota larga", null],
      ["Nota de sentadilla del lunes", null], ["Pres banca plano", null]]);
    const ids = new Map((await withUser(u, loadLibraryTx, db)).map((e) => [e.slug, e.id]));
    // Como en producción: linkRawName crea la copia propia y guarda el nombre crudo como alias.
    await linkRawName(u, { rawName: "Remo falso y una nota", exerciseId: ids.get("remo-falso")! }, db);
    await linkRawName(u, { rawName: "Elevacion  con nota larga", exerciseId: ids.get("elevacion-frontal-banco-inclinado")! }, db);
    await linkRawName(u, { rawName: "Nota de sentadilla del lunes", exerciseId: ids.get("sentadilla-high-bar")! }, db);
    await linkRawName(u, { rawName: "Pres banca plano", exerciseId: ids.get("press-banca")! }, db);
    // La copia de la elevación se hizo cuando el catálogo aún no tenía equipo.
    await withUser(u, (tx) => tx.query("update fit.exercises set equipment = null, equipment_type = 'libre' where slug = 'elevacion-frontal-banco-inclinado'"), db);

    // El otro atleta: una serie en la fila común compartida y un alias propio con el mismo texto que la lista.
    await addSets(o, [["Remo compartido", await commonId("remo-falso-compartido")], ["Nota de sentadilla del lunes", null]]);
    const oIds = new Map((await withUser(o, loadLibraryTx, db)).map((e) => [e.slug, e.id]));
    await linkRawName(o, { rawName: "Nota de sentadilla del lunes", exerciseId: oIds.get("sentadilla-high-bar")! }, db);
  });
  afterAll(async () => db.close());

  it("el simulacro cuenta lo que haría y no escribe", async () => {
    const before = await state(u);
    const r = await adjustExercises(u, PLAN, { dryRun: true }, db);
    expect(r.merges).toEqual([expect.objectContaining({ found: true, moved: 2, sets: 2, ownDeleted: 1 })]);
    expect(r.commonDeletes).toEqual([{ slug: "remo-falso", exists: true, refsLeft: 0, deleted: false }]);
    expect(r.equipment).toEqual([{ slug: "elevacion-frontal-banco-inclinado", ownCopy: true, from: null, to: "mancuernas", changed: true }]);
    expect(r.aliases.flatMap((a) => a.removed).sort()).toEqual(["Elevacion  con nota larga", "Nota de sentadilla del lunes", "Remo falso y una nota"]);
    expect(r.aliasesNotFound).toEqual(["No existe en ningún sitio"]);
    expect(await state(u)).toEqual(before);
    expect(await commonId("remo-falso")).toBeTruthy();
  });

  it("fusiona, cambia el equipo y quita solo los alias de la lista; repetirlo no hace nada", async () => {
    const other = await state(o);
    const r = await adjustExercises(u, PLAN, { dryRun: false }, db);
    expect(r.merges[0]).toMatchObject({ moved: 2, ownDeleted: 1 });
    expect(r.commonDeletes[0]).toMatchObject({ deleted: true });

    const lib = await withUser(u, loadLibraryTx, db);
    const target = lib.find((e) => e.slug === "remo-ancho-apoyado-en-mp")!;
    const s = await state(u);
    expect(s.sets.filter((x) => (x as { exercise_name_raw: string }).exercise_name_raw.startsWith("Remo falso")).map((x) => (x as { exercise_id: string }).exercise_id))
      .toEqual([target.id, target.id]);
    expect(lib.some((e) => e.slug === "remo-falso")).toBe(false);
    expect(await commonId("remo-falso")).toBeUndefined();
    expect(lib.find((e) => e.slug === "elevacion-frontal-banco-inclinado")).toMatchObject({ equipment: "mancuernas", equipmentType: "libre" });
    expect(lib.find((e) => e.slug === "press-banca")!.aliases).toContain("Pres banca plano");
    expect(lib.find((e) => e.slug === "sentadilla-high-bar")!.aliases).not.toContain("Nota de sentadilla del lunes");
    // Ninguna serie se queda sin ejercicio y el otro atleta no cambia (RLS).
    expect(s.sets.every((x) => (x as { exercise_id: string | null }).exercise_id)).toBe(true);
    expect(await state(o)).toEqual(other);
    // El catálogo común no se toca.
    const [common] = await asSystem((tx) => tx.query<{ aliases: string[] }>("select aliases from fit.exercises where slug = 'sentadilla-high-bar' and user_id is null"), db);
    expect(common.aliases).not.toContain("Nota de sentadilla del lunes");

    const again = await adjustExercises(u, PLAN, { dryRun: false }, db);
    expect(again.merges[0]).toMatchObject({ found: false, moved: 0 });
    expect(again.commonDeletes[0]).toMatchObject({ exists: false, deleted: false });
    expect(again.equipment[0]).toMatchObject({ changed: false });
    expect(again.aliases).toEqual([]);
    expect(await state(u)).toEqual(s);
  });

  it("no borra la fila común si otro atleta la usa", async () => {
    await addSets(u, [["Remo compartido mío", await commonId("remo-falso-compartido")]]);
    const plan = { merges: [{ from: "remo-falso-compartido", to: "remo-ancho-apoyado-en-mp" }] };
    expect((await adjustExercises(u, plan, { dryRun: true }, db)).commonDeletes[0]).toMatchObject({ refsLeft: 1, deleted: false });
    const r = await adjustExercises(u, plan, { dryRun: false }, db);
    expect(r.merges[0]).toMatchObject({ moved: 1, ownDeleted: 0 });
    expect(r.commonDeletes[0]).toMatchObject({ exists: true, refsLeft: 1, deleted: false });
    expect(await commonId("remo-falso-compartido")).toBeTruthy();
  });

  it("rechaza planes incoherentes", async () => {
    await expect(adjustExercises(u, { merges: [{ from: "press-banca", to: "press-banca" }] }, { dryRun: true }, db)).rejects.toThrow(/sí misma/);
    await expect(adjustExercises(u, { merges: [{ from: "press-banca", to: "no-existe" }] }, { dryRun: true }, db)).rejects.toThrow(/no-existe/);
    await expect(adjustExercises(u, { equipment: [{ slug: "press-banca", equipment: "nave" as never }] }, { dryRun: true }, db)).rejects.toThrow();
  });
});
