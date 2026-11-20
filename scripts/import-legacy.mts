/**
 * Importa el histórico de SISTEMA-ALEX-APP.  npm run import:legacy -- [carpeta_con_json] [email_del_atleta]
 *  - con carpeta: lee entrenos.json y estado.json (mismo formato que VIDA/_datos/supabase-AAAA-MM-DD);
 *  - sin carpeta: lee el Supabase antiguo con LEGACY_SUPABASE_URL, LEGACY_SUPABASE_SERVICE_KEY y LEGACY_USER_ID.
 * No imprime datos: solo el recuento.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asSystem, getDb } from "../src/db/client";
import { importLegacy, type LegacyEntreno, type LegacyEstado } from "../src/server/legacy-import";
import { seedCatalog } from "../src/server/seed";

const [dir, emailArg] = process.argv.slice(2);
const email = emailArg ?? process.env.OWNER_EMAIL ?? "dev@local";

async function fromSupabase(): Promise<{ entrenos: LegacyEntreno[]; estado: LegacyEstado | null }> {
  const url = process.env.LEGACY_SUPABASE_URL, key = process.env.LEGACY_SUPABASE_SERVICE_KEY, uid = process.env.LEGACY_USER_ID;
  if (!url || !key || !uid) throw new Error("Faltan LEGACY_SUPABASE_URL, LEGACY_SUPABASE_SERVICE_KEY o LEGACY_USER_ID (o pasa una carpeta con el export).");
  const get = async (q: string) => {
    const r = await fetch(`${url}/rest/v1/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`Supabase antiguo respondió ${r.status} en ${q.split("?")[0]}`);
    return r.json();
  };
  const entrenos = await get(`entrenos?user_id=eq.${uid}&select=fecha,dia,data,created_at&order=fecha.asc`);
  const estado = await get(`estado?user_id=eq.${uid}&select=data,updated_at`);
  return { entrenos, estado: estado[0] ?? null };
}

const input = dir
  ? (() => {
      const e = path.join(dir, "entrenos.json"), s = path.join(dir, "estado.json");
      if (!existsSync(e)) throw new Error(`No existe ${e}`);
      const st = existsSync(s) ? JSON.parse(readFileSync(s, "utf8")) : null;
      return { entrenos: JSON.parse(readFileSync(e, "utf8")) as LegacyEntreno[], estado: (Array.isArray(st) ? st[0] : st) as LegacyEstado | null };
    })()
  : await fromSupabase();

const db = await getDb();
await seedCatalog(db);
const [{ id }] = await asSystem(
  (tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ($1) on conflict (email) do update set updated_at = now() returning id", [email]),
  db,
);
const r = await importLegacy(id, input, db);
console.log(`Importado para ${email}: ${r.workouts} sesiones, ${r.sets} series (${r.skippedSets} descartadas por dato inválido), ${r.checkins} check-ins.`);
console.log(`Ejercicios enlazados a la librería: ${r.linked} de ${r.exercises}. Sin enlazar: ${r.unlinked} (conservan tu texto original).`);
await db.close();
