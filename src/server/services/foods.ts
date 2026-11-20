/**
 * Alimentos: catálogo común (Mercadona/Lidl + Open Food Facts) y alimentos propios del atleta.
 * El catálogo común (user_id null) solo se escribe por el camino del sistema y solo para guardar productos de OFF.
 */
import { z } from "zod";
import { asSystem, withUser, type Db, type Tx } from "@/db/client";
import { proteinPerEuro } from "@/engine/nutrition";
import { AppError, notFound } from "@/server/errors";
import { barcodeVariants, cleanBarcode, fetchOffProduct, normalizeOffProduct, offProductUrl, type FetchLike } from "@/server/off";
import { diffDays, todayIn } from "@/server/time";
import { Id, IsoDate, athleteTz, parseInput } from "./annotations";

export const FOOD_STORES = ["mercadona", "lidl", "otro"] as const;
export const FOOD_CATEGORIES = ["proteina", "hidrato", "grasa", "verdura", "fruta", "lacteo", "otro"] as const;
/** Un precio vale para presupuestar si se comprobó hace menos de estos días. */
export const PRICE_FRESH_DAYS = 60;

export type Food = {
  id: string;
  isOwn: boolean;
  name: string;
  brand: string | null;
  barcode: string | null;
  store: (typeof FOOD_STORES)[number] | null;
  category: string | null;
  source: "manual" | "openfoodfacts" | "catalogo";
  sourceRef: string | null;
  license: string | null;
  kcal100: number;
  protein100: number;
  carbs100: number;
  fat100: number;
  fiber100: number | null;
  sugar100: number | null;
  salt100: number | null;
  isLiquid: boolean;
  servingG: number | null;
  servingLabel: string | null;
  packageG: number | null;
  priceEur: number | null;
  pricePerKg: number | null;
  priceCheckedOn: string | null;
};

export type FoodRow = {
  id: string; user_id: string | null; name: string; brand: string | null; barcode: string | null; store: Food["store"]; category: string | null;
  source: Food["source"]; source_ref: string | null; license: string | null; kcal_100: number; protein_100: number; carbs_100: number; fat_100: number;
  fiber_100: number | null; sugar_100: number | null; salt_100: number | null; is_liquid: boolean; serving_g: number | null; serving_label: string | null;
  package_g: number | null; price_eur: number | null; price_per_kg: number | null; price_checked_on: string | null;
};

export const toFood = (r: FoodRow): Food => ({
  id: r.id, isOwn: r.user_id != null, name: r.name, brand: r.brand, barcode: r.barcode, store: r.store, category: r.category, source: r.source,
  sourceRef: r.source_ref, license: r.license, kcal100: r.kcal_100, protein100: r.protein_100, carbs100: r.carbs_100, fat100: r.fat_100,
  fiber100: r.fiber_100, sugar100: r.sugar_100, salt100: r.salt_100, isLiquid: r.is_liquid, servingG: r.serving_g, servingLabel: r.serving_label,
  packageG: r.package_g, priceEur: r.price_eur, pricePerKg: r.price_per_kg, priceCheckedOn: r.price_checked_on,
});

export const per100 = (f: Pick<Food, "kcal100" | "protein100" | "carbs100" | "fat100">) => ({ kcal: f.kcal100, protein: f.protein100, carbs: f.carbs100, fat: f.fat100 });

/** Días desde que se comprobó el precio; null si no hay precio fechado. */
export function priceAgeDays(f: Pick<Food, "pricePerKg" | "priceCheckedOn">, today: string): number | null {
  return f.pricePerKg == null || !f.priceCheckedOn ? null : diffDays(f.priceCheckedOn, today);
}
export function hasFreshPrice(f: Pick<Food, "pricePerKg" | "priceCheckedOn">, today: string): boolean {
  const age = priceAgeDays(f, today);
  return age != null && age < PRICE_FRESH_DAYS;
}

/** Quita acentos y mayúsculas. La misma tabla que NORM_SQL. */
export const normalizeText = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const normSql = (expr: string) => `translate(lower(${expr}), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc')`;

/** Clave para no contar dos veces el mismo producto cuando existe la copia propia y la común. */
const dedupeKey = (f: Food) => (f.barcode ? `b:${f.barcode}` : `n:${normalizeText(f.name)}|${normalizeText(f.brand ?? "")}|${f.store ?? ""}`);

/** Lo propio tapa a lo común. */
export function preferOwn(foods: Food[]): Food[] {
  const byKey = new Map<string, Food>();
  for (const f of foods) {
    const k = dedupeKey(f);
    const prev = byKey.get(k);
    if (!prev || (f.isOwn && !prev.isOwn)) byKey.set(k, f);
  }
  return [...byKey.values()];
}

/** Busca en local por código (propio primero, luego común). Para usar dentro de una transacción del atleta. */
export async function findLocalByBarcodeTx(tx: Tx, code: string): Promise<Food | null> {
  const rows = await tx.query<FoodRow>(
    "select * from fit.foods where barcode = any($1::text[]) order by (user_id is not null) desc, created_at limit 1",
    [barcodeVariants(code)],
  );
  return rows[0] ? toFood(rows[0]) : null;
}

export async function getFoodTx(tx: Tx, foodId: string): Promise<Food | null> {
  const rows = await tx.query<FoodRow>("select * from fit.foods where id = $1::uuid", [foodId]);
  return rows[0] ? toFood(rows[0]) : null;
}

/* ----------------------------- Código de barras ----------------------------- */

export const LookupBarcodeInput = z.object({
  barcode: z.string().trim().min(8).max(32).describe("Código de barras del producto (EAN-8, UPC o EAN-13). Se aceptan espacios y guiones."),
});
export type LookupBarcodeInput = z.input<typeof LookupBarcodeInput>;

export type LookupBarcodeResult =
  | { food: Food; origin: "local" | "openfoodfacts"; barcode: string }
  | { food: null; reason: string; cause: "no_encontrado" | "incompleto" | "externo"; barcode: string };

/**
 * 1) catálogo local (propio, luego común); 2) Open Food Facts; 3) lo guarda en el catálogo común.
 * Si no hay alimento devuelve el motivo y el código limpio, para abrir el alta manual con él puesto.
 */
export async function lookupBarcode(userId: string, input: LookupBarcodeInput, db?: Db, fetchImpl?: FetchLike): Promise<LookupBarcodeResult> {
  const i = parseInput(LookupBarcodeInput, input);
  const barcode = cleanBarcode(i.barcode);
  if (!barcode) throw new AppError("entrada_invalida", "Código de barras no válido: deben ser entre 8 y 14 dígitos.");

  const local = await withUser(userId, (tx) => findLocalByBarcodeTx(tx, barcode), db);
  if (local) return { food: local, origin: "local", barcode };

  let raw: unknown;
  try {
    raw = await fetchOffProduct(barcode, { fetchImpl });
  } catch (e) {
    if (e instanceof AppError && e.code === "externo")
      return { food: null, cause: "externo", barcode, reason: `${e.message} Puedes darlo de alta a mano.` };
    throw e;
  }
  if (!raw) return { food: null, cause: "no_encontrado", barcode, reason: "Ese código no está en Open Food Facts. Dalo de alta a mano." };
  const norm = normalizeOffProduct(raw);
  if (!norm.food) return { food: null, cause: "incompleto", barcode, reason: `${norm.reason} Dalo de alta a mano.` };

  const f = norm.food;
  // Único uso de asSystem en este servicio: el catálogo común no admite escrituras del rol del atleta.
  const saved = await asSystem(async (tx) => {
    const ins = await tx.query<FoodRow>(
      `insert into fit.foods (user_id, name, brand, barcode, store, source, source_ref, license,
         kcal_100, protein_100, carbs_100, fat_100, fiber_100, sugar_100, salt_100, is_liquid, serving_g, serving_label, package_g)
       values (null, $1, $2, $3, $4, 'openfoodfacts', $5, 'ODbL', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (barcode) where user_id is null and barcode is not null do nothing
       returning *`,
      [f.name, f.brand, f.barcode, f.store, offProductUrl(f.barcode), f.kcal_100, f.protein_100, f.carbs_100, f.fat_100,
        f.fiber_100, f.sugar_100, f.salt_100, f.is_liquid, f.serving_g, f.serving_label, f.package_g],
    );
    if (ins[0]) return ins[0];
    const prev = await tx.query<FoodRow>("select * from fit.foods where user_id is null and barcode = $1", [f.barcode]);
    return prev[0];
  }, db);
  return { food: toFood(saved), origin: "openfoodfacts", barcode };
}

/* ------------------------------- Búsqueda ------------------------------- */

export const SearchFoodsInput = z.object({
  q: z.string().trim().max(80).describe("Texto a buscar en el nombre o la marca. Da igual acentos y mayúsculas. Vacío lista todo."),
  store: z.enum(FOOD_STORES).optional().describe("Filtra por tienda: mercadona, lidl u otro."),
  category: z.enum(FOOD_CATEGORIES).optional().describe("Filtra por categoría: proteina, hidrato, grasa, verdura, fruta, lacteo u otro."),
  limit: z.number().int().min(1).max(50).optional().describe("Máximo de resultados. Por defecto, 20."),
});
export type SearchFoodsInput = z.input<typeof SearchFoodsInput>;

export async function searchFoods(userId: string, input: SearchFoodsInput, db?: Db): Promise<Food[]> {
  const i = parseInput(SearchFoodsInput, input);
  const tokens = normalizeText(i.q).split(/\s+/).filter(Boolean).slice(0, 6);
  const patterns = tokens.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
  const hay = normSql("name || ' ' || coalesce(brand, '')");
  return withUser(userId, async (tx) => {
    const rows = await tx.query<FoodRow>(
      `select * from fit.foods
       where (cardinality($1::text[]) = 0 or ${hay} like all ($1::text[]))
         and ($2::text is null or store = $2) and ($3::text is null or category = $3)
       order by (user_id is not null) desc,
                (case when $4::text <> '' and ${normSql("name")} like $4 || '%' then 0 else 1 end),
                length(name), name
       limit $5::int`,
      [patterns, i.store ?? null, i.category ?? null, (tokens[0] ?? "").replace(/[\\%_]/g, "\\$&"), i.limit ?? 20],
    );
    return rows.map(toFood);
  }, db);
}

/* ------------------------------- Alta manual ------------------------------- */

const per100Field = (what: string) => z.number().min(0).max(100).describe(`${what} por 100 g (o 100 ml).`);

export const CreateFoodInput = z.object({
  name: z.string().trim().min(1).max(200).describe("Nombre del alimento."),
  brand: z.string().trim().max(120).optional().describe("Marca."),
  barcode: z.string().trim().max(32).optional().describe("Código de barras, si lo tiene."),
  store: z.enum(FOOD_STORES).optional().describe("Tienda: mercadona, lidl u otro."),
  category: z.enum(FOOD_CATEGORIES).optional().describe("Categoría: proteina, hidrato, grasa, verdura, fruta, lacteo u otro."),
  kcal100: z.number().min(0).max(950).describe("Calorías por 100 g (o 100 ml)."),
  protein100: per100Field("Gramos de proteína"),
  carbs100: per100Field("Gramos de hidratos"),
  fat100: per100Field("Gramos de grasa"),
  fiber100: per100Field("Gramos de fibra").optional(),
  sugar100: per100Field("Gramos de azúcares").optional(),
  salt100: per100Field("Gramos de sal").optional(),
  isLiquid: z.boolean().optional().describe("Verdadero si se mide en mililitros."),
  servingG: z.number().positive().max(5000).optional().describe("Gramos de una ración."),
  servingLabel: z.string().trim().max(80).optional().describe("Cómo se llama la ración («1 yogur», «1 rebanada»)."),
  packageG: z.number().positive().max(100_000).optional().describe("Gramos del envase."),
  priceEur: z.number().min(0).max(10_000).optional().describe("Precio del envase en euros."),
  priceCheckedOn: IsoDate.optional().describe("Día en que se comprobó el precio. Por defecto, hoy si hay precio."),
});
export type CreateFoodInput = z.input<typeof CreateFoodInput>;

export async function createFood(userId: string, input: CreateFoodInput, db?: Db): Promise<Food> {
  const i = parseInput(CreateFoodInput, input);
  let barcode: string | null = null;
  if (i.barcode) {
    barcode = cleanBarcode(i.barcode);
    if (!barcode) throw new AppError("entrada_invalida", "Código de barras no válido: deben ser entre 8 y 14 dígitos.");
  }
  return withUser(userId, async (tx) => {
    if (barcode) {
      const dup = await tx.query("select 1 from fit.foods where user_id = $1::uuid and barcode = $2", [userId, barcode]);
      if (dup.length) throw new AppError("conflicto", "Ya tienes un alimento con ese código de barras.");
    }
    const checkedOn = i.priceEur != null ? (i.priceCheckedOn ?? todayIn(await athleteTz(tx))) : null;
    const rows = await tx.query<FoodRow>(
      `insert into fit.foods (user_id, name, brand, barcode, store, category, source, kcal_100, protein_100, carbs_100, fat_100,
         fiber_100, sugar_100, salt_100, is_liquid, serving_g, serving_label, package_g, price_eur, price_checked_on)
       values ($1::uuid, $2, $3, $4, $5, $6, 'manual', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::date)
       returning *`,
      [userId, i.name, i.brand ?? null, barcode, i.store ?? null, i.category ?? null, i.kcal100, i.protein100, i.carbs100, i.fat100,
        i.fiber100 ?? null, i.sugar100 ?? null, i.salt100 ?? null, i.isLiquid ?? false, i.servingG ?? null, i.servingLabel ?? null,
        i.packageG ?? null, i.priceEur ?? null, checkedOn],
    );
    return toFood(rows[0]);
  }, db);
}

/* --------------------------------- Precio --------------------------------- */

export const UpdateFoodPriceInput = z.object({
  foodId: Id.describe("Id del alimento."),
  priceEur: z.number().min(0).max(10_000).describe("Precio del envase en euros."),
  packageG: z.number().positive().max(100_000).describe("Gramos (o mililitros) del envase al que corresponde el precio."),
  checkedOn: IsoDate.optional().describe("Día en que se vio el precio. Por defecto, hoy."),
});
export type UpdateFoodPriceInput = z.input<typeof UpdateFoodPriceInput>;

export type UpdateFoodPriceResult = { food: Food; copied: boolean };

/** Guarda el precio. Si el alimento es del catálogo común, crea (o reutiliza) la copia propia y pone el precio ahí. */
export async function updateFoodPrice(userId: string, input: UpdateFoodPriceInput, db?: Db): Promise<UpdateFoodPriceResult> {
  const i = parseInput(UpdateFoodPriceInput, input);
  return withUser(userId, async (tx) => {
    const src = (await tx.query<FoodRow>("select * from fit.foods where id = $1::uuid", [i.foodId]))[0];
    if (!src) throw notFound("El alimento");
    const checkedOn = i.checkedOn ?? todayIn(await athleteTz(tx));
    const setPrice = (id: string) =>
      tx.query<FoodRow>("update fit.foods set price_eur = $2, package_g = $3, price_checked_on = $4::date where id = $1::uuid returning *", [
        id, i.priceEur, i.packageG, checkedOn,
      ]);
    if (src.user_id) return { food: toFood((await setPrice(src.id))[0]), copied: false };

    const own = await tx.query<{ id: string }>(
      `select id from fit.foods where user_id = $1::uuid and (
         ($2::text is not null and barcode = $2)
         or ($2::text is null and barcode is null and lower(name) = lower($3)
             and coalesce(brand, '') = coalesce($4::text, '') and coalesce(store, '') = coalesce($5::text, ''))
       ) limit 1`,
      [userId, src.barcode, src.name, src.brand, src.store],
    );
    if (own[0]) return { food: toFood((await setPrice(own[0].id))[0]), copied: false };

    const copy = await tx.query<FoodRow>(
      `insert into fit.foods (user_id, name, brand, barcode, store, category, source, source_ref, license, kcal_100, protein_100, carbs_100, fat_100,
         fiber_100, sugar_100, salt_100, nutrients, is_liquid, serving_g, serving_label, package_g, price_eur, price_checked_on)
       select $1::uuid, name, brand, barcode, store, category, source, source_ref, license, kcal_100, protein_100, carbs_100, fat_100,
         fiber_100, sugar_100, salt_100, nutrients, is_liquid, serving_g, serving_label, $3, $4, $5::date
       from fit.foods where id = $2::uuid returning *`,
      [userId, src.id, i.packageG, i.priceEur, checkedOn],
    );
    return { food: toFood(copy[0]), copied: true };
  }, db);
}

/* ------------------------------ Presupuesto ------------------------------ */

export const RankByBudgetInput = z.object({
  store: z.enum(FOOD_STORES).optional().describe("Solo alimentos de esta tienda."),
  category: z.enum(FOOD_CATEGORIES).optional().describe("Solo alimentos de esta categoría."),
  asOf: IsoDate.optional().describe("Día de referencia para decidir si un precio ha caducado. Por defecto, hoy."),
});
export type RankByBudgetInput = z.input<typeof RankByBudgetInput>;

export type RankedFood = { food: Food; proteinPerEuro: number; priceAgeDays: number };
export type StaleFood = { food: Food; priceAgeDays: number | null };
export type RankByBudgetResult = { asOf: string; freshDays: number; ranked: RankedFood[]; stale: StaleFood[] };

/** Alimentos con precio vigente (< 60 días) por gramos de proteína por euro. Los de precio caducado o sin fecha van aparte. */
export async function rankByBudget(userId: string, input: RankByBudgetInput = {}, db?: Db): Promise<RankByBudgetResult> {
  const i = parseInput(RankByBudgetInput, input);
  return withUser(userId, async (tx) => {
    const asOf = i.asOf ?? todayIn(await athleteTz(tx));
    const rows = await tx.query<FoodRow>(
      "select * from fit.foods where price_per_kg is not null and ($1::text is null or store = $1) and ($2::text is null or category = $2)",
      [i.store ?? null, i.category ?? null],
    );
    const ranked: RankedFood[] = [];
    const stale: StaleFood[] = [];
    for (const food of preferOwn(rows.map(toFood))) {
      const age = priceAgeDays(food, asOf);
      const ppe = proteinPerEuro(per100(food), food.pricePerKg!);
      if (age != null && age < PRICE_FRESH_DAYS && ppe != null) ranked.push({ food, proteinPerEuro: Math.round(ppe * 10) / 10, priceAgeDays: age });
      else stale.push({ food, priceAgeDays: age });
    }
    ranked.sort((a, b) => b.proteinPerEuro - a.proteinPerEuro || a.food.name.localeCompare(b.food.name));
    stale.sort((a, b) => a.food.name.localeCompare(b.food.name));
    return { asOf, freshDays: PRICE_FRESH_DAYS, ranked, stale };
  }, db);
}
