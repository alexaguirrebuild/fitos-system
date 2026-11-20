/**
 * Aplica las migraciones pendientes de supabase/migrations.
 *   npm run db:migrate
 * Con DATABASE_URL va contra ese Postgres; sin ella, contra la base local de PGlite (.data/pglite).
 * Carga .env.local y .env si existen, sin pisar las variables que ya vengan del entorno.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { getDb, migrate } from "../src/db/client";

for (const file of [".env.local", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (existsSync(full)) process.loadEnvFile(full); // no sobrescribe lo que ya está definido
}

async function main() {
  const remote = !!process.env.DATABASE_URL;
  console.log(remote ? "Destino: Postgres (DATABASE_URL)" : "Destino: PGlite local");
  const db = await getDb();
  try {
    // En local getDb() ya migra al abrir; esta llamada lo deja explícito y es la única que actúa en remoto.
    const applied = await migrate(db);
    const all = await db.query<{ name: string }>("select name from public.fit_migrations order by name");
    console.log(applied.length ? `Aplicadas ahora: ${applied.join(", ")}` : "Nada pendiente.");
    console.log(`Migraciones en la base: ${all.map((r) => r.name).join(", ")}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
