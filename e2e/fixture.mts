/**
 * Base de las pruebas E2E: PGlite nueva en PGLITE_DIR con el catálogo, el atleta dev con su ficha
 * y un programa que empieza hoy. Solo en modo dev y nunca con DATABASE_URL (producción).
 *   PGLITE_DIR=.data/e2e AUTH_MODE=dev tsx e2e/fixture.mts   (lo lanza playwright.config.ts)
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/client";
import { ensureDevUser } from "../src/server/auth";
import { seedCatalog } from "../src/server/seed";
import { saveOnboarding } from "../src/server/services/athlete";
import { recalcTargets } from "../src/server/services/nutrition";
import { activateProgram } from "../src/server/services/plan";
import { addDays, todayIn } from "../src/server/time";

if (process.env.DATABASE_URL) throw new Error("E2E: DATABASE_URL está definida. Las pruebas solo corren contra PGlite local.");
const dir = process.env.PGLITE_DIR;
// Solo .data/e2e de este proyecto: la carpeta se borra entera y no puede ser la base dev (.data/pglite) ni otra.
if (!dir || path.resolve(dir) !== path.resolve(".data", "e2e")) {
  throw new Error("E2E: PGLITE_DIR tiene que ser .data/e2e (se borra en cada ejecución).");
}
rmSync(dir, { recursive: true, force: true });

const db = await getDb();
await seedCatalog(db);
const userId = await ensureDevUser(db);
const D = todayIn("Europe/Madrid");
await saveOnboarding(userId, {
  heightCm: 175, birthDate: "2004-01-15", sex: "H", hrRest: 60, bedtime: "23:30", adhdMedication: false, weeklyFoodBudgetEur: 60,
  stores: ["mercadona"], goalWeightKg: 75, weightKg: 80, waistCm: 85, measuredOn: addDays(D, -2),
}, db);
await activateProgram(userId, { slug: "torso-pierna-6d", startDate: D }, db);
await recalcTargets(userId, {}, db);
await db.close();
console.log(`E2E: base lista en ${dir} (atleta dev, programa torso-pierna-6d desde ${D}).`);
