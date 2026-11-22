/**
 * Enlaza en bloque las series del histórico que quedaron sin ejercicio, según un mapa «nombre crudo → slug»
 * escrito a mano (tablas Markdown). El mapa vive fuera del repo porque los nombres crudos son notas personales.
 *
 * Idempotente: solo toca series con `exercise_id` nulo, así que repetirlo no hace nada.
 * El simulacro lee en una transacción `read only` y repite las comprobaciones de `linkRawName`, para que lo que
 * dice que haría sea lo que luego pasa.
 */
import { z } from "zod";
import { withUser, type Db } from "@/db/client";
import { invalid } from "@/server/errors";
import { aliasOwnerIn, hasLabel, LinkRawNameInput, linkRawName, listUnlinkedNamesTx, loadLibraryTx, type Exercise } from "@/server/services/library";

export type OrphanMapEntry = { rawName: string; slug: string };

const Entry = z.object({
  rawName: z.string().min(1).max(500),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(70),
});

/** Clave de comparación: la tabla Markdown pierde los espacios de los extremos, así que se comparan sin ellos y colapsados. */
export const orphanKey = (s: string) => s.replace(/\s+/g, " ").trim();

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());

/**
 * Lee las filas de las tablas cuyo último campo es un slug entre comillas invertidas (`slug` o `NUEVO slug`)
 * y cuya segunda columna es el nombre crudo. Ignora cabeceras, separadores y el resto del texto.
 */
export function parseOrphanMap(md: string): OrphanMapEntry[] {
  const out = new Map<string, OrphanMapEntry>();
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 3) continue;
    // Cualquier cosa entre comillas invertidas cuenta como fila: un slug mal escrito falla aquí, no se salta en silencio.
    const m = /^`(?:NUEVO\s+)?([^`]+)`$/.exec(cells[cells.length - 1]);
    if (!m) continue;
    const parsed = Entry.safeParse({ rawName: orphanKey(cells[1]), slug: m[1] });
    if (!parsed.success) throw invalid(`Fila del mapa no válida: slug «${m[1]}» o nombre vacío.`);
    const prev = out.get(parsed.data.rawName);
    if (prev && prev.slug !== parsed.data.slug)
      throw invalid(`El mapa enlaza «${parsed.data.rawName}» a dos ejercicios: ${prev.slug} y ${parsed.data.slug}.`);
    out.set(parsed.data.rawName, parsed.data);
  }
  return [...out.values()];
}

export type OrphanAction = {
  rawName: string;
  slug: string;
  /** Textos exactos en la base que corresponden a esta fila (puede haber varios si solo cambian los espacios). */
  matches: { rawName: string; sets: number }[];
  linked: number;
  /** Sin series sueltas: si ya hay series enlazadas con este nombre (pasada anterior) o si no aparece en la base. */
  alreadyLinked: boolean;
  error?: string;
};

export type OrphanReport = {
  dryRun: boolean;
  actions: OrphanAction[];
  unknownSlugs: string[];
  linkedSets: number;
  linkedNames: number;
  /** Lo que sigue suelto al terminar (en simulacro, lo que quedaría). */
  remaining: { rawName: string; sets: number }[];
  remainingSets: number;
  /** Se llegó al máximo que lista `listUnlinkedNames`: puede haber más; repetir el script enlaza el resto. */
  truncated: boolean;
};

const LIST_MAX = 200;

type Snapshot = { unlinked: { rawName: string; sets: number }[]; linkedKeys: Set<string>; lib: Exercise[] };

async function snapshot(userId: string, readOnly: boolean, db?: Db): Promise<Snapshot> {
  return withUser(userId, async (tx) => {
    if (readOnly) await tx.query("set transaction read only");
    const unlinked = (await listUnlinkedNamesTx(tx, LIST_MAX)).map((u) => ({ rawName: u.rawName, sets: u.sets }));
    const linked = await tx.query<{ raw: string }>(
      "select distinct exercise_name_raw as raw from fit.workout_sets where exercise_id is not null and exercise_name_raw is not null");
    return { unlinked, linkedKeys: new Set(linked.map((r) => orphanKey(r.raw))), lib: await loadLibraryTx(tx) };
  }, db);
}

/** Lo que `linkRawName` rechazaría, comprobado sin escribir. Simula los alias que van añadiendo las filas anteriores. */
function dryRunError(lib: Exercise[], ex: Exercise, rawName: string): string | undefined {
  if (!LinkRawNameInput.safeParse({ rawName, exerciseId: ex.id }).success) return "el nombre pasa de 200 caracteres";
  const alias = rawName.trim();
  if (alias.length < 2 || hasLabel(ex, alias)) return undefined;
  const owner = aliasOwnerIn(lib, ex, alias);
  if (owner) return `«${alias}» ya es el nombre de ${owner.name}.`;
  ex.aliases = [...ex.aliases, alias];
  return undefined;
}

export async function linkOrphans(userId: string, entries: OrphanMapEntry[], opts: { dryRun: boolean }, db?: Db): Promise<OrphanReport> {
  const all = entries.map((e) => Entry.parse(e));
  const snap = await snapshot(userId, opts.dryRun, db);
  const byKey = new Map<string, { rawName: string; sets: number }[]>();
  for (const u of snap.unlinked) byKey.set(orphanKey(u.rawName), [...(byKey.get(orphanKey(u.rawName)) ?? []), u]);

  // Ejercicio visible por slug: si el atleta tiene copia propia, esa tapa a la común (y es a la que hay que enlazar).
  // En simulacro se trabaja sobre copias para poder ir añadiendo alias sin tocar nada.
  const lib = snap.lib.map((e) => ({ ...e, aliases: [...e.aliases] }));
  const bySlug = new Map(lib.map((e) => [e.slug, e]));
  const unknownSlugs = [...new Set(all.map((e) => e.slug).filter((s) => !bySlug.has(s)))];
  if (unknownSlugs.length && !opts.dryRun)
    throw invalid(`Slugs que no están en la librería: ${unknownSlugs.join(", ")}. ¿Falta aplicar el seed (npm run db:seed)?`);

  const actions: OrphanAction[] = [];
  const done = new Set<string>();
  for (const e of all) {
    const matches = byKey.get(e.rawName) ?? [];
    const a: OrphanAction = { rawName: e.rawName, slug: e.slug, matches, linked: 0, alreadyLinked: !matches.length && snap.linkedKeys.has(e.rawName) };
    actions.push(a);
    const ex = bySlug.get(e.slug);
    if (!ex) continue;
    for (const m of matches) {
      if (opts.dryRun) {
        const err = dryRunError(lib, ex, m.rawName);
        if (err) { a.error = err; continue; }
        a.linked += m.sets;
        done.add(m.rawName);
        continue;
      }
      try {
        const r = await linkRawName(userId, { rawName: m.rawName, exerciseId: ex.id }, db);
        a.linked += r.linked;
        // La primera vez puede crear la copia propia: las siguientes filas de ese slug van a ella.
        bySlug.set(e.slug, { ...r.exercise, aliases: [...r.exercise.aliases] });
        done.add(m.rawName);
      } catch (err) {
        a.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const remaining = opts.dryRun ? snap.unlinked.filter((u) => !done.has(u.rawName)) : (await snapshot(userId, true, db)).unlinked;
  return {
    dryRun: opts.dryRun,
    actions,
    unknownSlugs,
    linkedSets: actions.reduce((s, a) => s + a.linked, 0),
    linkedNames: actions.filter((a) => a.linked > 0).length,
    remaining,
    remainingSets: remaining.reduce((s, r) => s + r.sets, 0),
    truncated: snap.unlinked.length === LIST_MAX,
  };
}
