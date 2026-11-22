/**
 * Enlaza en bloque las series del histórico que quedaron sin ejercicio, según un mapa «nombre crudo → slug»
 * escrito a mano (tablas Markdown). El mapa vive fuera del repo porque los nombres crudos son notas personales.
 *
 * Idempotente: solo toca series con `exercise_id` nulo, así que repetirlo no hace nada.
 */
import { z } from "zod";
import { withUser, type Db } from "@/db/client";
import { invalid } from "@/server/errors";
import { linkRawName, listUnlinkedNames, loadLibraryTx } from "@/server/services/library";

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
};

// listUnlinkedNames no pagina: 200 es su máximo. Si se llega, puede haber más; el script lo avisa y repetirlo enlaza el resto.
const LIST_MAX = 200;

export async function linkOrphans(userId: string, entries: OrphanMapEntry[], opts: { dryRun: boolean }, db?: Db): Promise<OrphanReport & { truncated: boolean }> {
  const all = entries.map((e) => Entry.parse(e));
  const unlinked = await listUnlinkedNames(userId, { limit: LIST_MAX }, db);
  const byKey = new Map<string, { rawName: string; sets: number }[]>();
  for (const u of unlinked) {
    const k = orphanKey(u.rawName);
    byKey.set(k, [...(byKey.get(k) ?? []), { rawName: u.rawName, sets: u.sets }]);
  }

  // Id visible por slug: si el atleta tiene copia propia, esa tapa a la común (y es a la que hay que enlazar).
  const ids = new Map((await withUser(userId, loadLibraryTx, db)).map((e) => [e.slug, e.id]));
  const unknownSlugs = [...new Set(all.map((e) => e.slug).filter((s) => !ids.has(s)))];
  if (unknownSlugs.length && !opts.dryRun)
    throw invalid(`Slugs que no están en la librería: ${unknownSlugs.join(", ")}. ¿Falta aplicar el seed (npm run db:seed)?`);

  const actions: OrphanAction[] = [];
  const done = new Set<string>();
  for (const e of all) {
    const matches = byKey.get(e.rawName) ?? [];
    const a: OrphanAction = { rawName: e.rawName, slug: e.slug, matches, linked: 0 };
    actions.push(a);
    if (opts.dryRun) {
      if (!ids.has(e.slug)) continue;
      a.linked = matches.reduce((s, m) => s + m.sets, 0);
      matches.forEach((m) => done.add(m.rawName));
      continue;
    }
    for (const m of matches) {
      try {
        const r = await linkRawName(userId, { rawName: m.rawName, exerciseId: ids.get(e.slug)! }, db);
        a.linked += r.linked;
        ids.set(e.slug, r.exercise.id); // la primera vez puede crear la copia propia: las siguientes van a ella
        done.add(m.rawName);
      } catch (err) {
        a.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const remaining = opts.dryRun
    ? unlinked.filter((u) => !done.has(u.rawName)).map((u) => ({ rawName: u.rawName, sets: u.sets }))
    : (await listUnlinkedNames(userId, { limit: LIST_MAX }, db)).map((u) => ({ rawName: u.rawName, sets: u.sets }));
  return {
    dryRun: opts.dryRun,
    actions,
    unknownSlugs,
    linkedSets: actions.reduce((s, a) => s + a.linked, 0),
    linkedNames: actions.filter((a) => a.linked > 0).length,
    remaining,
    remainingSets: remaining.reduce((s, r) => s + r.sets, 0),
    truncated: unlinked.length === LIST_MAX,
  };
}
