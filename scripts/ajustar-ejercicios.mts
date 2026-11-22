/**
 * Ajusta el catálogo propio de un atleta: fusiona ejercicios duplicados, cambia el equipo de sus copias y quita alias.
 *   npm run ajustar:ejercicios -- <email> [--alias <lista.md>] [--fusionar origen:destino]... [--equipo slug=equipo]... [--dry-run]
 * La lista de alias vive en VIDA (son notas personales). Idempotente: repetirlo no hace nada.
 * Con --dry-run no escribe (transacciones `read only`) y además falla si `npm run db:seed` fuera a aplicar migraciones,
 * si un origen de fusión sigue en el seed (lo volvería a crear) o si el equipo pedido no coincide con el del seed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asSystem, getDb, pendingMigrations } from "../src/db/client";
import { adjustExercises, EQUIPMENT, parseAliasList } from "../src/server/exercise-adjust";

const seed = () => new Map(["exercises.base.json", "exercises.gorilangel.json"].flatMap((f) => {
  const p = path.join(process.cwd(), "data", "seed", f);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { slug: string; equipment?: string | null }[]).map((e) => [e.slug, e] as const) : [];
}));

function values(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const email = args[0] && !args[0].startsWith("--") ? args[0] : process.env.OWNER_EMAIL;
  if (!email) throw new Error("Pasa el email del atleta como primer argumento (o pon OWNER_EMAIL).");

  const aliasFile = values(args, "--alias")[0];
  if (aliasFile && !existsSync(aliasFile)) throw new Error(`No existe la lista de alias: ${aliasFile}`);
  const removeAliases = aliasFile ? parseAliasList(readFileSync(aliasFile, "utf8")) : [];
  const merges = values(args, "--fusionar").map((v) => {
    const [from, to] = v.split(":");
    if (!from || !to) throw new Error(`--fusionar va como origen:destino. Recibido: ${v}`);
    return { from, to };
  });
  const equipment = values(args, "--equipo").map((v) => {
    const [slug, eq] = v.split("=");
    if (!slug || !eq) throw new Error(`--equipo va como slug=equipo. Recibido: ${v}`);
    return { slug, equipment: eq as (typeof EQUIPMENT)[number] }; // lo valida zod en adjustExercises
  });
  if (!removeAliases.length && !merges.length && !equipment.length) throw new Error("No hay nada que ajustar: pasa --alias, --fusionar o --equipo.");

  const s = seed();
  const problems = [
    ...merges.filter((m) => s.has(m.from)).map((m) => `${m.from} sigue en el seed: db:seed lo volvería a crear.`),
    ...merges.filter((m) => !s.has(m.to)).map((m) => `${m.to} no está en el seed.`),
    ...equipment.filter((e) => s.get(e.slug)?.equipment !== e.equipment).map((e) => `${e.slug}: el seed dice «${s.get(e.slug)?.equipment ?? "nada"}», no «${e.equipment}».`),
  ];
  if (problems.length) throw new Error(`El plan no cuadra con el seed del repo:\n  ${problems.join("\n  ")}`);

  const db = await getDb();
  try {
    if (dryRun) {
      const pending = await pendingMigrations(db);
      if (pending.length) throw new Error(`db:seed aplicaría migraciones pendientes: ${pending.join(", ")}. Revísalas y aplícalas aparte antes de seguir.`);
    }
    const [athlete] = await asSystem(async (tx) => {
      if (dryRun) await tx.query("set transaction read only");
      return tx.query<{ id: string }>("select id from fit.athletes where email = $1", [email]);
    }, db);
    if (!athlete) throw new Error(`No hay ningún atleta con el email ${email}.`);

    const r = await adjustExercises(athlete.id, { merges, equipment, removeAliases }, { dryRun }, db);
    const v = (hoy: string, sim: string) => (dryRun ? sim : hoy);
    console.log(dryRun ? "SIMULACRO: no se escribe nada.\n" : "");

    for (const m of r.merges) {
      console.log(`Fusión ${m.from} → ${m.to} («${m.toName}»):`);
      console.log(m.found
        ? `  ${v("movidas", "movería")} ${m.moved} referencias (${m.sets} series); ${v("borrada", "borraría")} su copia propia: ${m.ownDeleted ? "sí" : "no tiene"}.`
        : "  el origen ya no existe (hecho antes).");
      if (m.carried.length) console.log(`  Nombres que ${v("pasaron", "pasarían")} al destino: ${m.carried.map((x) => `«${x}»`).join(", ")}.`);
      if (m.skipped.length) console.log(`  No pasan (ya son de otro ejercicio): ${m.skipped.map((x) => `«${x}»`).join(", ")}.`);
    }
    for (const c of r.commonDeletes)
      console.log(!c.exists ? `  Catálogo común: ${c.slug} ya no está.`
        : c.inSeed ? `  Catálogo común: ${c.slug} se queda (sigue en el seed).`
        : c.deleted || (dryRun && c.refsLeft === 0) ? `  Catálogo común: ${v("borrado", "borraría")} ${c.slug} (sin referencias).`
        : `  Catálogo común: ${c.slug} se queda (${c.refsLeft} referencias de otros).`);
    for (const e of r.equipment)
      console.log(`Equipo de ${e.slug}: ${!e.ownCopy ? "sin copia propia (lo cambia el seed)" : e.changed ? `${e.from ?? "nada"} → ${e.to}` : `ya es ${e.to}`}.`);

    const n = r.aliases.reduce((s, a) => s + a.removed.length, 0);
    if (removeAliases.length) {
      console.log(`\nAlias: ${v("quitados", "quitaría")} ${n} de ${removeAliases.length} de la lista.`);
      for (const a of r.aliases) for (const x of a.removed) console.log(`  ${a.slug.padEnd(38)} − ${x}`);
      if (r.aliasesNotFound.length) console.log(`  No están en ningún ejercicio propio (ya quitados o mal copiados): ${r.aliasesNotFound.length}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
