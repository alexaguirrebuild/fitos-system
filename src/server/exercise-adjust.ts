/**
 * Ajustes del catálogo de un atleta después de enlazar el histórico:
 *  - fusionar dos ejercicios que son el mismo (sus series, plan, vídeos y nombres pasan al destino);
 *  - cambiar el equipo de su copia propia (el seed solo actualiza la fila común, que la copia tapa);
 *  - quitar alias que en realidad eran notas.
 * Todo lo del atleta va en una sola transacción con `withUser`: o se aplica entero o nada.
 * El simulacro usa la misma transacción en `read only` y cuenta lo mismo que hará la ejecución real.
 */
import { z } from "zod";
import { asSystem, withUser, type Db, type Tx } from "@/db/client";
import { invalid, notFound } from "@/server/errors";
import { seedExerciseSlugs } from "@/server/seed";
import { aliasOwnerIn, equipmentTypeFrom, EXERCISE_COLS, hasLabel, loadLibraryTx, normalizeText, ownCopyTx, type Exercise } from "@/server/services/library";

const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(70);
export const EQUIPMENT = ["barra", "mancuernas", "maquina", "polea", "multipower", "peso_corporal", "discos", "bici", "eliptica", "cinta", "ninguno"] as const;

const AliasRef = z.object({ slug: Slug, alias: z.string().min(1).max(500) });
export type AliasRef = z.infer<typeof AliasRef>;

export const AdjustPlan = z.object({
  merges: z.array(z.object({ from: Slug, to: Slug })).max(20).default([]),
  equipment: z.array(z.object({ slug: Slug, equipment: z.enum(EQUIPMENT) })).max(50).default([]),
  removeAliases: z.array(AliasRef).max(500).default([]),
});
export type AdjustPlan = z.input<typeof AdjustPlan>;

/** Las tablas Markdown pierden los espacios de los extremos y colapsan los dobles: se compara igual. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const aliasKey = (slug: string, alias: string) => `${slug}\u0000${squash(alias)}`;

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());

/**
 * Lee las filas `| nombre | \`slug\` | quitar |` de la lista de alias. Las de `mantener` se ignoran.
 * El alias se quita solo del ejercicio de esa fila: el mismo texto en otro ejercicio no se toca.
 */
export function parseAliasList(md: string): AliasRef[] {
  const out = new Map<string, AliasRef>();
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 3 || cells[cells.length - 1] !== "quitar") continue;
    const slug = /^`(?:NUEVO\s+)?([^`]+)`$/.exec(cells[cells.length - 2])?.[1];
    const parsed = AliasRef.safeParse({ slug, alias: squash(cells[0]) });
    if (!parsed.success) throw invalid(`Fila de la lista de alias no válida: «${cells[0]}» (slug ${slug ?? "vacío"}).`);
    out.set(aliasKey(parsed.data.slug, parsed.data.alias), parsed.data);
  }
  return [...out.values()];
}

// Tablas con exercise_id del atleta (todas con RLS own_rows y FK sin cascada: no se puede borrar un ejercicio con referencias).
const REFS = [
  { table: "workout_sets", col: "exercise_id" },
  { table: "workout_exercises", col: "exercise_id" },
  { table: "workout_exercises", col: "replaces_exercise_id" },
  { table: "prescriptions", col: "exercise_id" },
  { table: "videos", col: "exercise_id" },
] as const;

async function countRefs(tx: Tx, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  let n = 0;
  for (const r of REFS)
    n += (await tx.query<{ n: number }>(`select count(*)::int as n from fit.${r.table} where ${r.col} = any($1::uuid[])`, [ids]))[0].n;
  return n;
}

export type MergeResult = {
  from: string; to: string; toName: string; found: boolean; moved: number; sets: number; ownDeleted: number;
  /** Nombres y alias del origen que pasan al destino, para que el histórico se siga enlazando solo. */
  carried: string[];
  /** Los que no pasan porque ya son el nombre de otro ejercicio. */
  skipped: string[];
  /** Se crea la copia propia del destino: desde entonces, los cambios del seed en ese ejercicio no le llegan al atleta. */
  destCopyCreated: boolean;
};
export type EquipmentResult = { slug: string; ownCopy: boolean; from: string | null; to: string; changed: boolean };
export type AliasResult = { slug: string; name: string; removed: string[] };
export type CommonDeleteResult = { slug: string; exists: boolean; inSeed: boolean; refsLeft: number; deleted: boolean };

export type AdjustReport = {
  dryRun: boolean;
  merges: MergeResult[];
  equipment: EquipmentResult[];
  aliases: AliasResult[];
  /** Filas de la lista que no estaban como alias de su ejercicio propio (ya quitadas o mal copiadas). */
  aliasesNotFound: AliasRef[];
  commonDeletes: CommonDeleteResult[];
};

async function mergeTx(tx: Tx, from: string, to: string, removing: Set<string>, apply: boolean): Promise<MergeResult> {
  const lib = await loadLibraryTx(tx);
  // La librería como queda tras quitar los alias de la lista: en la ejecución real ya están quitados; en el simulacro, no.
  const after = lib.map((e) => ({ ...e, aliases: e.aliases.filter((a) => !removing.has(aliasKey(e.slug, a))) }));
  const target = after.find((e) => e.slug === to);
  if (!target) throw notFound(`El ejercicio destino «${to}»`);
  // El origen puede tener copia propia, fila común o las dos (la copia tapa a la común, pero ambas pueden tener referencias).
  const src = await tx.query<Exercise>(`select ${EXERCISE_COLS} from fit.exercises e where e.slug = $1`, [from]);
  const ids = src.map((e) => e.id);
  const res: MergeResult = { from, to, toName: target.name, found: src.length > 0, moved: 0, sets: 0, ownDeleted: 0, carried: [], skipped: [], destCopyCreated: false };
  if (!ids.length) return res;

  // unique (workout_id, exercise_id): una sesión con los dos ejercicios no se puede fusionar sin decidir qué fila queda.
  const targetIds = (await tx.query<{ id: string }>("select id from fit.exercises where slug = $1", [to])).map((r) => r.id);
  const [{ n: clash }] = await tx.query<{ n: number }>(
    `select count(distinct a.workout_id)::int as n from fit.workout_exercises a join fit.workout_exercises b on b.workout_id = a.workout_id
     where a.exercise_id = any($1::uuid[]) and b.exercise_id = any($2::uuid[])`, [ids, targetIds]);
  if (clash) throw invalid(`${clash} sesiones tienen ${from} y ${to} a la vez. Júntalas a mano antes de fusionar.`);

  res.moved = await countRefs(tx, ids);
  res.sets = (await tx.query<{ n: number }>("select count(*)::int as n from fit.workout_sets where exercise_id = any($1::uuid[])", [ids]))[0].n;
  res.ownDeleted = src.filter((e) => e.userId).length;

  // Nombres del origen que pasan al destino (menos los que la lista quita): así el importador y Muse los siguen reconociendo.
  const others = after.filter((e) => e.slug !== from);
  const seen = new Set<string>();
  for (const label of src.flatMap((e) => [e.name, ...e.aliases]).map((l) => l.trim())) {
    if (seen.has(normalizeText(label))) continue;
    seen.add(normalizeText(label));
    if (removing.has(aliasKey(from, label)) || hasLabel(target, label)) continue;
    if (aliasOwnerIn(others, target, label)) res.skipped.push(label);
    else res.carried.push(label);
  }
  res.destCopyCreated = res.carried.length > 0 && !target.userId;
  if (!apply) return res;

  // Si hay nombres que pasar y el destino es común, hace falta su copia propia (el atleta no puede tocar la común).
  const dest = res.carried.length ? (await ownCopyTx(tx, target, lib)).exercise : target;
  for (const r of REFS) await tx.query(`update fit.${r.table} set ${r.col} = $1 where ${r.col} = any($2::uuid[])`, [dest.id, ids]);
  // Una sustitución del origen por el destino (o al revés) sería ahora una sustitución de sí mismo.
  await tx.query("update fit.workout_exercises set replaces_exercise_id = null where exercise_id = $1 and replaces_exercise_id = $1", [dest.id]);
  if (res.carried.length)
    await tx.query("update fit.exercises set aliases = aliases || $1::text[] where id = $2", [res.carried, dest.id]);
  // Solo la copia propia: la fila común no la puede borrar el atleta (RLS) y va aparte, como sistema.
  res.ownDeleted = (await tx.query<{ id: string }>("delete from fit.exercises where slug = $1 and user_id = auth.uid() returning id", [from])).length;
  return res;
}

async function equipmentTx(tx: Tx, slug: string, equipment: string, apply: boolean): Promise<EquipmentResult> {
  const [own] = await tx.query<{ id: string; equipment: string | null }>(
    "select id, equipment from fit.exercises where slug = $1 and user_id = auth.uid()", [slug]);
  if (!own) return { slug, ownCopy: false, from: null, to: equipment, changed: false };
  const changed = own.equipment !== equipment;
  if (changed && apply)
    await tx.query("update fit.exercises set equipment = $1, equipment_type = $2 where id = $3", [equipment, equipmentTypeFrom(equipment), own.id]);
  return { slug, ownCopy: true, from: own.equipment, to: equipment, changed };
}

async function aliasesTx(tx: Tx, list: AliasRef[], apply: boolean): Promise<{ results: AliasResult[]; notFound: AliasRef[] }> {
  const wanted = new Map(list.map((a) => [aliasKey(a.slug, a.alias), a]));
  const seen = new Set<string>();
  const rows = await tx.query<{ id: string; slug: string; name: string; aliases: string[] }>(
    "select id, slug, name, aliases from fit.exercises where user_id = auth.uid() order by slug");
  const results: AliasResult[] = [];
  for (const r of rows) {
    const removed = r.aliases.filter((a) => wanted.has(aliasKey(r.slug, a)));
    if (!removed.length) continue;
    removed.forEach((a) => seen.add(aliasKey(r.slug, a)));
    results.push({ slug: r.slug, name: r.name, removed });
    if (apply) await tx.query("update fit.exercises set aliases = $1 where id = $2", [r.aliases.filter((a) => !wanted.has(aliasKey(r.slug, a))), r.id]);
  }
  return { results, notFound: [...wanted].filter(([k]) => !seen.has(k)).map(([, a]) => a) };
}

/**
 * Borra la fila común de un ejercicio fusionado si nadie la usa y ya no está en las semillas (si no, `db:seed` la
 * volvería a crear). Va como sistema porque el catálogo común no es del atleta, como en `seedCatalog`. Además del
 * recuento, la FK sin cascada impide borrarla si queda alguna referencia.
 * `pendingMoves` descuenta, en simulacro, las referencias de la fila común que la fusión del atleta movería.
 */
async function deleteCommonIfUnused(slug: string, apply: boolean, pendingMoves: number, db?: Db): Promise<CommonDeleteResult> {
  const seeded = seedExerciseSlugs();
  // Sin semillas (otro directorio de trabajo) no se puede saber si db:seed la volvería a crear: mejor no borrar nada.
  if (!seeded.size) throw invalid("No encuentro data/seed: ejecuta el script desde la raíz del repo.");
  const inSeed = seeded.has(slug);
  return asSystem(async (tx) => {
    if (!apply) await tx.query("set transaction read only");
    const [row] = await tx.query<{ id: string }>("select id from fit.exercises where slug = $1 and user_id is null", [slug]);
    if (!row) return { slug, exists: false, inSeed, refsLeft: 0, deleted: false };
    const refsLeft = Math.max((await countRefs(tx, [row.id])) - (apply ? 0 : pendingMoves), 0);
    if (refsLeft > 0 || inSeed || !apply) return { slug, exists: true, inSeed, refsLeft, deleted: false };
    await tx.query("delete from fit.exercises where id = $1", [row.id]);
    return { slug, exists: true, inSeed, refsLeft: 0, deleted: true };
  }, db);
}

export async function adjustExercises(userId: string, plan: AdjustPlan, opts: { dryRun: boolean }, db?: Db): Promise<AdjustReport> {
  const p = AdjustPlan.parse(plan);
  const froms = new Set(p.merges.map((m) => m.from));
  if (p.merges.some((m) => m.from === m.to || froms.has(m.to))) throw invalid("Una fusión no puede apuntar a sí misma ni a otro origen.");
  const apply = !opts.dryRun;
  const removing = new Set(p.removeAliases.map((a) => aliasKey(a.slug, a.alias)));

  const own = await withUser(userId, async (tx) => {
    if (!apply) await tx.query("set transaction read only");
    // Alias primero: si fueran después, los de una copia que la fusión borra saldrían como «no encontrados» solo en la ejecución real.
    const aliases = p.removeAliases.length ? await aliasesTx(tx, p.removeAliases, apply) : { results: [], notFound: [] };
    const merges: MergeResult[] = [];
    for (const m of p.merges) merges.push(await mergeTx(tx, m.from, m.to, removing, apply));
    const equipment: EquipmentResult[] = [];
    for (const e of p.equipment) equipment.push(await equipmentTx(tx, e.slug, e.equipment, apply));
    return { merges, equipment, aliases };
  }, db);

  const commonDeletes: CommonDeleteResult[] = [];
  for (const m of own.merges) {
    // En simulacro, las referencias del atleta a la fila común aún no se han movido: se descuentan.
    const pending = apply ? 0 : await withUser(userId, async (tx) => {
      await tx.query("set transaction read only");
      const ids = (await tx.query<{ id: string }>("select id from fit.exercises where slug = $1 and user_id is null", [m.from])).map((r) => r.id);
      return countRefs(tx, ids);
    }, db);
    commonDeletes.push(await deleteCommonIfUnused(m.from, apply, pending, db));
  }

  return { dryRun: opts.dryRun, ...own, aliases: own.aliases.results, aliasesNotFound: own.aliases.notFound, commonDeletes };
}
