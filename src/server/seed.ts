/** Carga idempotente del catálogo común (user_id null): grupos musculares, ejercicios, glosario y alimentos. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asSystem, type Db } from "@/db/client";

const SEED_DIR = path.join(process.cwd(), "data", "seed");
const read = <T>(dir: string, file: string): T[] => {
  const p = path.join(dir, file);
  if (!existsSync(p)) return [];
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(j) ? j : (j.foods ?? []);
};

type Ex = Record<string, unknown> & { slug: string };

export async function seedCatalog(db?: Db, dir: string = SEED_DIR) {
  const muscles = read<Record<string, unknown>>(dir, "muscle_groups.json");
  // Si un slug aparece en las dos listas, manda la base (clasificada a mano) y hereda vídeos y notas de la otra.
  const bySlug = new Map<string, Ex>();
  for (const e of read<Ex>(dir, "exercises.gorilangel.json")) bySlug.set(e.slug, e);
  for (const e of read<Ex>(dir, "exercises.base.json")) bySlug.set(e.slug, { ...bySlug.get(e.slug), ...e });
  const glossary = [...read<Record<string, unknown>>(dir, "glossary.gorilangel.json"), ...read<Record<string, unknown>>(dir, "glossary.base.json")];
  const foods = read<Record<string, unknown>>(dir, "foods.json");

  return asSystem(async (tx) => {
    for (const m of muscles)
      await tx.query(
        `insert into fit.muscle_groups (id, name, region, default_mev, default_mrv, half_life_h) values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do update set name = excluded.name, region = excluded.region, default_mev = excluded.default_mev,
           default_mrv = excluded.default_mrv, half_life_h = excluded.half_life_h`,
        [m.id, m.name, m.region, m.default_mev, m.default_mrv, m.half_life_h],
      );
    for (const e of bySlug.values())
      await tx.query(
        `insert into fit.exercises (slug, name, aliases, primary_muscle, secondary_muscles, kind, movement_pattern, equipment, stability,
           resistance_profile, stretch_bias, base_cost, load_step, per_side, warmup_kind, ankle_load, impact, video_urls, cues)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (slug) where user_id is null do update set name = excluded.name, aliases = excluded.aliases,
           primary_muscle = excluded.primary_muscle, secondary_muscles = excluded.secondary_muscles, kind = excluded.kind,
           movement_pattern = excluded.movement_pattern, equipment = excluded.equipment, stability = excluded.stability,
           resistance_profile = excluded.resistance_profile, stretch_bias = excluded.stretch_bias, base_cost = excluded.base_cost,
           load_step = excluded.load_step, per_side = excluded.per_side, warmup_kind = excluded.warmup_kind,
           ankle_load = excluded.ankle_load, impact = excluded.impact, video_urls = excluded.video_urls, cues = excluded.cues`,
        [e.slug, e.name, e.aliases ?? [], e.primary_muscle ?? null, e.secondary_muscles ?? [], e.kind ?? "aislamiento",
          e.movement_pattern ?? null, e.equipment ?? null, e.stability ?? "bilateral_guiado", e.resistance_profile ?? "constante",
          e.stretch_bias ?? false, e.base_cost ?? 1, e.load_step ?? 2.5, e.per_side ?? false, e.warmup_kind ?? "reducido",
          e.ankle_load ?? "ninguna", e.impact ?? false, e.video_urls ?? [], e.cues ?? null],
      );
    const seen = new Set<string>();
    for (const g of glossary) {
      if (!g.slug || !g.definition || seen.has(g.slug as string)) continue;
      seen.add(g.slug as string);
      await tx.query(
        `insert into fit.glossary (slug, term, category, definition, notes, source) values ($1,$2,$3,$4,$5,$6)
         on conflict (slug) do update set term = excluded.term, category = excluded.category, definition = excluded.definition,
           notes = excluded.notes, source = excluded.source`,
        [g.slug, g.term, g.category, g.definition, g.notes ?? null, g.source ?? null],
      );
    }
    let foodsIn = 0;
    for (const f of foods) {
      if (f.kcal_100 == null || !f.name) continue;
      const vals = [f.name, f.brand ?? null, f.barcode ?? null, f.store ?? null, f.category ?? null, f.source === "openfoodfacts" ? "openfoodfacts" : "catalogo",
        f.source_ref ?? null, f.license ?? null, f.kcal_100, f.protein_100 ?? 0, f.carbs_100 ?? 0, f.fat_100 ?? 0, f.fiber_100 ?? null,
        f.sugar_100 ?? null, f.salt_100 ?? null, f.is_liquid ?? false, f.serving_g ?? null, f.serving_label ?? null, f.package_g ?? null,
        f.price_eur ?? null, f.price_eur != null ? (f.price_checked_on ?? null) : null];
      const cols = `name, brand, barcode, store, category, source, source_ref, license, kcal_100, protein_100, carbs_100, fat_100, fiber_100,
        sugar_100, salt_100, is_liquid, serving_g, serving_label, package_g, price_eur, price_checked_on`;
      const ph = vals.map((_, i) => `$${i + 1}`).join(",");
      if (f.barcode) {
        await tx.query(
          `insert into fit.foods (${cols}) values (${ph})
           on conflict (barcode) where user_id is null and barcode is not null do update set name = excluded.name, brand = excluded.brand,
             store = excluded.store, category = excluded.category, kcal_100 = excluded.kcal_100, protein_100 = excluded.protein_100,
             carbs_100 = excluded.carbs_100, fat_100 = excluded.fat_100, package_g = excluded.package_g, price_eur = excluded.price_eur,
             price_checked_on = excluded.price_checked_on`,
          vals,
        );
      } else {
        const dup = await tx.query("select 1 from fit.foods where user_id is null and lower(name) = lower($1) and coalesce(brand,'') = coalesce($2,'')", [f.name, f.brand ?? null]);
        if (!dup.length) await tx.query(`insert into fit.foods (${cols}) values (${ph})`, vals);
      }
      foodsIn++;
    }
    return { muscles: muscles.length, exercises: bySlug.size, glossary: seen.size, foods: foodsIn };
  }, db);
}
