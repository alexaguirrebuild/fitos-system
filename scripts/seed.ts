/** Carga el catálogo común (ejercicios, grupos, glosario, alimentos). Idempotente.  npm run db:seed */
import { getDb, migrate } from "../src/db/client";
import { seedCatalog } from "../src/server/seed";

const db = await getDb();
if (db.driver === "pg") console.log("migraciones aplicadas:", await migrate(db));
console.log("catálogo:", await seedCatalog(db));
await db.close();
