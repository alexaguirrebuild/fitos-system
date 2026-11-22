/**
 * Ajustes del catálogo de un atleta después de enlazar el histórico:
 *  - fusionar dos ejercicios que son el mismo (sus series, plan y vídeos pasan al destino);
 *  - cambiar el equipo de su copia propia (el seed solo actualiza la fila común, que la copia tapa);
 *  - quitar alias que en realidad eran notas.
 * Todo lo del atleta va en una sola transacción con `withUser`: o se aplica entero o nada.
 * El simulacro usa la misma transacción en `read only`.
 */
import { z } from "zod";
import { asSystem, withUser, type Db, type Tx } from "@/db/client";
import { invalid, notFound } from "@/server/errors";
import { equipmentTypeFrom, loadLibraryTx } from "@/server/services/library";

const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(70);
export const EQUIPMENT = ["barra", "mancuernas", "maquina", "polea", "multipower", "peso_corporal", "discos", "bici", "eliptica", "cinta", "ninguno"] as const;

export const AdjustPlan = z.object({
  merges: z.array(z.object({ from: Slug, to: Slug })).max(20).default([]),
  equipment: z.array(z.object({ slug: Slug, equipment: z.enum(EQUIPMENT) })).max(50).default([]),
  removeAliases: z.array(z.string().min(1).max(500)).max(500).default([]),
});
export type AdjustPlan = z.input<typeof AdjustPlan>;

/** Las tablas Markdown pierden los espacios de los extremos y colapsan los dobles: se compara igual. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Lee las filas `| nombre | … | quitar |` de la lista de alias. Las de `mantener` se ignoran. */
export function parseAliasList(md: string): string[] {
  const out = new Set<string>();
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const action = cells[cells.length - 1];
    if (cells.length < 2 || (action !== "quitar" && action !== "mantener")) continue;
    if (action === "quitar" && squash(cells[0])) out.add(squash(cells[0]));
  }
  return [...out];
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

export type MergeResult = { from: string; to: string; toName: string; found: boolean; moved: number; sets: number; ownDeleted: number };
export type EquipmentResult = { slug: string; ownCopy: boolean; from: string | null; to: string; changed: boolean };
export type AliasResult = { slug: string; name: string; removed: string[] };
export type CommonDeleteResult = { slug: string; exists: boolean; refsLeft: number; deleted: boolean };

export type AdjustReport = {
  dryRun: boolean;
  merges: MergeResult[];
  equipment: EquipmentResult[];
  aliases: AliasResult[];
  /** Nombres de la lista que no estaban como alias en ningún ejercicio propio (ya quitados o mal copiados). */
  aliasesNotFound: string[];
  commonDeletes: CommonDeleteResult[];
};

async function mergeTx(tx: Tx, from: string, to: string, apply: boolean): Promise<MergeResult> {
  const target = (await loadLibraryTx(tx)).find((e) => e.slug === to);
  if (!target) throw notFound(`El ejercicio destino «${to}»`);
  // El origen visible puede ser la copia propia, la común o las dos (la copia tapa a la común, pero ambas pueden tener referencias).
  const src = await tx.query<{ id: string; own: boolean }>("select id, (user_id is not null) as own from fit.exercises where slug = $1", [from]);
  const ids = src.map((r) => r.id);
  const res: MergeResult = { from, to, toName: target.name, found: src.length > 0, moved: await countRefs(tx, ids), sets: 0, ownDeleted: 0 };
  if (!ids.length) return res;
  res.sets = (await tx.query<{ n: number }>("select count(*)::int as n from fit.workout_sets where exercise_id = any($1::uuid[])", [ids]))[0].n;
  if (!apply) { res.ownDeleted = src.filter((r) => r.own).length; return res; }
  for (const r of REFS) await tx.query(`update fit.${r.table} set ${r.col} = $1 where ${r.col} = any($2::uuid[])`, [target.id, ids]);
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

async function aliasesTx(tx: Tx, list: string[], apply: boolean): Promise<{ results: AliasResult[]; notFound: string[] }> {
  const wanted = new Set(list.map(squash));
  const seen = new Set<string>();
  const rows = await tx.query<{ id: string; slug: string; name: string; aliases: string[] }>(
    "select id, slug, name, aliases from fit.exercises where user_id = auth.uid() order by slug");
  const results: AliasResult[] = [];
  for (const r of rows) {
    const removed = r.aliases.filter((a) => wanted.has(squash(a)));
    if (!removed.length) continue;
    removed.forEach((a) => seen.add(squash(a)));
    results.push({ slug: r.slug, name: r.name, removed });
    if (apply) await tx.query("update fit.exercises set aliases = $1 where id = $2", [r.aliases.filter((a) => !wanted.has(squash(a))), r.id]);
  }
  return { results, notFound: [...wanted].filter((a) => !seen.has(a)) };
}

/**
 * Borra la fila común de un ejercicio fusionado si nadie la usa. Va como sistema porque el catálogo común no es del
 * atleta (igual que el seed). Además del recuento, la FK sin cascada impide borrarla si queda alguna referencia.
 * `pendingMoves` descuenta, en simulacro, las referencias que la fusión del atleta movería.
 */
async function deleteCommonIfUnused(slug: string, apply: boolean, pendingMoves: number, db?: Db): Promise<CommonDeleteResult> {
  return asSystem(async (tx) => {
    if (!apply) await tx.query("set transaction read only");
    const [row] = await tx.query<{ id: string }>("select id from fit.exercises where slug = $1 and user_id is null", [slug]);
    if (!row) return { slug, exists: false, refsLeft: 0, deleted: false };
    const refsLeft = (await countRefs(tx, [row.id])) - (apply ? 0 : pendingMoves);
    if (refsLeft > 0 || !apply) return { slug, exists: true, refsLeft: Math.max(refsLeft, 0), deleted: false };
    await tx.query("delete from fit.exercises where id = $1", [row.id]);
    return { slug, exists: true, refsLeft: 0, deleted: true };
  }, db);
}

export async function adjustExercises(userId: string, plan: AdjustPlan, opts: { dryRun: boolean }, db?: Db): Promise<AdjustReport> {
  const p = AdjustPlan.parse(plan);
  const froms = new Set(p.merges.map((m) => m.from));
  if (p.merges.some((m) => m.from === m.to || froms.has(m.to))) throw invalid("Una fusión no puede apuntar a sí misma ni a otro origen.");
  const apply = !opts.dryRun;

  const own = await withUser(userId, async (tx) => {
    if (!apply) await tx.query("set transaction read only");
    // Alias primero: si van después, los de una copia que la fusión borra saldrían como «no encontrados» solo en la ejecución real.
    const aliases = p.removeAliases.length ? await aliasesTx(tx, p.removeAliases, apply) : { results: [], notFound: [] };
    const merges: MergeResult[] = [];
    for (const m of p.merges) merges.push(await mergeTx(tx, m.from, m.to, apply));
    const equipment: EquipmentResult[] = [];
    for (const e of p.equipment) equipment.push(await equipmentTx(tx, e.slug, e.equipment, apply));
    return { merges, equipment, aliases };
  }, db);

  // En simulacro, las referencias de la copia propia no cuentan para la fila común: solo las que estén en la propia fila común.
  const commonDeletes: CommonDeleteResult[] = [];
  for (const m of own.merges) {
    const commonRefs = apply ? 0 : await withUser(userId, async (tx) => {
      await tx.query("set transaction read only");
      const ids = (await tx.query<{ id: string }>("select id from fit.exercises where slug = $1 and user_id is null", [m.from])).map((r) => r.id);
      return countRefs(tx, ids);
    }, db);
    commonDeletes.push(await deleteCommonIfUnused(m.from, apply, commonRefs, db));
  }

  return { dryRun: opts.dryRun, ...own, aliases: own.aliases.results, aliasesNotFound: own.aliases.notFound, commonDeletes };
}
