/**
 * Enlaza las series del histórico sin ejercicio según el mapa aprobado por Alex.
 *   npm run enlazar:huerfanos -- <ruta_del_mapa.md> [email_del_atleta] [--dry-run]
 * El mapa vive en VIDA (los nombres crudos son notas personales y no entran en git).
 * Idempotente: repetirlo no hace nada. Con --dry-run no escribe: lista lo que haría.
 */
import { existsSync, readFileSync } from "node:fs";
import { asSystem, getDb } from "../src/db/client";
import { linkOrphans, parseOrphanMap } from "../src/server/link-orphans";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [mapPath, emailArg] = args.filter((a) => !a.startsWith("--"));
  if (!mapPath || !existsSync(mapPath)) throw new Error(`Pasa la ruta del mapa. No existe: ${mapPath ?? "(vacío)"}`);
  const email = emailArg ?? process.env.OWNER_EMAIL;
  if (!email) throw new Error("Pasa el email del atleta (o pon OWNER_EMAIL).");

  const entries = parseOrphanMap(readFileSync(mapPath, "utf8"));
  if (!entries.length) throw new Error("El mapa no tiene filas «| series | nombre | última | `slug` |».");

  const db = await getDb();
  try {
    const [athlete] = await asSystem((tx) => tx.query<{ id: string }>("select id from fit.athletes where email = $1", [email]), db);
    if (!athlete) throw new Error(`No hay ningún atleta con el email ${email}.`);

    const r = await linkOrphans(athlete.id, entries, { dryRun }, db);
    console.log(dryRun ? "SIMULACRO: no se escribe nada.\n" : "");
    for (const a of r.actions) {
      const sets = a.matches.reduce((s, m) => s + m.sets, 0);
      const state = a.error ? `ERROR: ${a.error}`
        : !a.matches.length ? "ya enlazado o no existe (0 series sueltas)"
        : r.unknownSlugs.includes(a.slug) ? `slug sin dar de alta (${sets} series)`
        : `${dryRun ? "enlazaría" : "enlazadas"} ${a.linked} series`;
      console.log(`  ${a.slug.padEnd(38)} ← ${a.rawName}  ·  ${state}`);
    }
    if (r.unknownSlugs.length) console.log(`\nSlugs que no están en la librería (falta el seed): ${r.unknownSlugs.join(", ")}`);
    console.log(`\nMapa: ${entries.length} nombres.`);
    console.log(`${dryRun ? "Enlazaría" : "Enlazadas"}: ${r.linkedSets} series de ${r.linkedNames} nombres.`);
    console.log(`${dryRun ? "Quedarían" : "Quedan"} sueltas: ${r.remainingSets} series de ${r.remaining.length} nombres.`);
    for (const x of r.remaining) console.log(`  ${String(x.sets).padStart(3)} · ${x.rawName}`);
    if (r.truncated) console.log("\nAviso: había 200 nombres sueltos o más (el máximo que se listan). Repite el script para el resto.");
    if (r.actions.some((a) => a.error)) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

// Los errores esperables (ruta, email, slug) salen como una línea, sin traza.
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
