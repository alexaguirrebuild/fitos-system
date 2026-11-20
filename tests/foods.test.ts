import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, openMemoryDb, withUser, type Db } from "@/db/client";
import { AppError } from "@/server/errors";
import { fetchOffProduct, normalizeOffProduct, offProductUrl, parseServing, type FetchLike } from "@/server/off";
import { createFood, lookupBarcode, rankByBudget, searchFoods, updateFoodPrice } from "@/server/services/foods";

/** Respuestas de Open Food Facts grabadas a mano: los tests no salen a internet. */
const OFF_YOGUR = {
  code: "8480000123456",
  status: 1,
  product: {
    code: "8480000123456",
    product_name: "Greek yogurt",
    product_name_es: "Yogur griego natural",
    brands: "Hacendado",
    quantity: "6 x 125 g",
    serving_size: "125 g",
    nutriments: { "energy-kcal_100g": 121, proteins_100g: 3.6, carbohydrates_100g: 4.1, fat_100g: 10, sugars_100g: 4.1, salt_100g: 0.11 },
    stores_tags: ["mercadona"],
  },
};
const OFF_BEBIDA = {
  code: "4056489000001",
  status: 1,
  product: {
    code: "4056489000001",
    product_name: "Bebida de avena",
    brands: "Vemondo, Lidl",
    quantity: "1 l",
    serving_size: "200 ml (206 g)",
    nutriments: { "energy-kj_100g": 1046, proteins_100g: 1, carbohydrates_100g: 6.5, fat_100g: 1.5 },
    stores_tags: [],
  },
};
const OFF_INCOMPLETO = {
  code: "8410000000017",
  status: 1,
  product: { code: "8410000000017", product_name: "Galletas", brands: "Marca", nutriments: { "energy-kcal_100g": 480, fat_100g: 20 } },
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** fetch falso: responde por código de barras y cuenta las llamadas. */
function fakeOff(products: Record<string, unknown>) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const code = /\/product\/(\d+)\.json/.exec(url)?.[1] ?? "";
    return products[code] ? jsonResponse(products[code]) : jsonResponse({ code, status: 0, status_verbose: "product not found" }, 404);
  };
  return { calls, fetchImpl };
}

describe("Open Food Facts: normalización", () => {
  it("usa las kcal de la etiqueta, la marca y la tienda", () => {
    const { food } = normalizeOffProduct(OFF_YOGUR);
    expect(food).toMatchObject({
      name: "Yogur griego natural", brand: "Hacendado", barcode: "8480000123456", kcal_100: 121, protein_100: 3.6, carbs_100: 4.1, fat_100: 10,
      sugar_100: 4.1, salt_100: 0.11, fiber_100: null, serving_g: 125, package_g: 750, is_liquid: false, store: "mercadona",
    });
  });

  it("saca las kcal de los kJ cuando faltan y parsea la porción en ml con gramos", () => {
    const { food } = normalizeOffProduct(OFF_BEBIDA);
    expect(food?.kcal_100).toBe(250); // 1046 kJ / 4,184
    expect(food?.serving_g).toBe(206);
    expect(food?.serving_label).toBe("200 ml (206 g)");
    expect(food?.package_g).toBe(1000);
    expect(food?.is_liquid).toBe(true);
    expect(food?.store).toBe("lidl"); // por la marca
  });

  it("parsea porciones sueltas", () => {
    expect(parseServing("30 g")).toEqual({ grams: 30, liquid: false });
    expect(parseServing("200 ml (206 g)")).toEqual({ grams: 206, liquid: true });
    expect(parseServing("1 vaso (250 ml)")).toEqual({ grams: 250, liquid: true });
    expect(parseServing("una porción")).toEqual({ grams: null, liquid: false });
  });

  it("un producto incompleto no se guarda: devuelve null y el motivo", () => {
    const r = normalizeOffProduct(OFF_INCOMPLETO);
    expect(r.food).toBeNull();
    expect(r.reason).toMatch(/proteína/);
    expect(r.reason).toMatch(/hidratos/);
  });
});

describe("Open Food Facts: cliente", () => {
  it("manda el User-Agent y pide solo los campos que usa", async () => {
    const off = fakeOff({ "8480000123456": OFF_YOGUR });
    const raw = await fetchOffProduct("8480-0001 23456", { fetchImpl: off.fetchImpl, userAgent: "test-agent/1.0" });
    expect(raw).toEqual(OFF_YOGUR);
    expect(off.calls).toHaveLength(1);
    expect(off.calls[0].userAgent).toBe("test-agent/1.0");
    expect(off.calls[0].url).toContain("/api/v2/product/8480000123456.json?fields=code,product_name");
    expect(off.calls[0].url).toContain("lc=es");
  });

  it("si no existe reintenta una vez con el cero inicial (UPC → EAN-13) y devuelve null si tampoco", async () => {
    const off = fakeOff({ "0123456789012": { ...OFF_YOGUR, code: "0123456789012" } });
    expect(await fetchOffProduct("123456789012", { fetchImpl: off.fetchImpl })).not.toBeNull();
    expect(off.calls.map((c) => /product\/(\d+)/.exec(c.url)?.[1])).toEqual(["123456789012", "0123456789012"]);

    const none = fakeOff({});
    expect(await fetchOffProduct("8480000999999", { fetchImpl: none.fetchImpl })).toBeNull();
    expect(none.calls).toHaveLength(1);
  });

  it("5xx y timeout son AppError('externo'); un código corto, entrada inválida", async () => {
    const down: FetchLike = async () => new Response("boom", { status: 503 });
    await expect(fetchOffProduct("8480000123456", { fetchImpl: down })).rejects.toMatchObject({ code: "externo" });

    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    await expect(fetchOffProduct("8480000123456", { fetchImpl: hang, timeoutMs: 20 })).rejects.toMatchObject({ code: "externo", message: expect.stringMatching(/tiempo/) });

    await expect(fetchOffProduct("123", { fetchImpl: down })).rejects.toBeInstanceOf(AppError);
  });
});

describe("alimentos (PGlite)", () => {
  let db: Db;
  let a: string;
  let b: string;

  beforeAll(async () => {
    db = await openMemoryDb();
    const rows = await asSystem((tx) => tx.query<{ id: string }>("insert into fit.athletes (email) values ('a@test.local'), ('b@test.local') returning id"), db);
    [a, b] = rows.map((r) => r.id);
    await asSystem(async (tx) => {
      await tx.query(
        `insert into fit.foods (name, brand, store, category, source, kcal_100, protein_100, carbs_100, fat_100, package_g, price_eur, price_checked_on) values
           ('Pechuga de pollo', 'Hacendado', 'mercadona', 'proteina', 'catalogo', 110, 23, 0, 2, 1000, 6.50, current_date - 5),
           ('Atún al natural', 'Hacendado', 'mercadona', 'proteina', 'catalogo', 100, 24, 0, 0.5, 336, 3.60, current_date - 90),
           ('Piña en su jugo', 'Hacendado', 'mercadona', 'fruta', 'catalogo', 60, 0.4, 13, 0.1, 560, null, null),
           ('Queso fresco batido', 'Milbona', 'lidl', 'proteina', 'catalogo', 46, 8, 3.5, 0.1, 500, 0.99, current_date - 10)`,
      );
    }, db);
  });
  afterAll(async () => db.close());

  it("lookupBarcode: local → OFF → guardado; la segunda llamada no usa la red", async () => {
    const off = fakeOff({ "8480000123456": OFF_YOGUR });
    const first = await lookupBarcode(a, { barcode: "8480000123456" }, db, off.fetchImpl);
    expect(first.food).not.toBeNull();
    expect(first).toMatchObject({ origin: "openfoodfacts", barcode: "8480000123456" });
    expect(first.food).toMatchObject({
      name: "Yogur griego natural", isOwn: false, source: "openfoodfacts", license: "ODbL", sourceRef: offProductUrl("8480000123456"), store: "mercadona", kcal100: 121,
    });
    expect(off.calls).toHaveLength(1);

    const second = await lookupBarcode(a, { barcode: "8480000123456" }, db, off.fetchImpl);
    expect(second).toMatchObject({ origin: "local" });
    expect(second.food?.id).toBe(first.food?.id);
    expect(off.calls).toHaveLength(1); // sin red

    // Queda en el catálogo común: el otro atleta lo ve sin llamar a OFF.
    const other = await lookupBarcode(b, { barcode: "8480000123456" }, db, off.fetchImpl);
    expect(other).toMatchObject({ origin: "local" });
    expect(off.calls).toHaveLength(1);
    const common = await db.query<{ n: number }>("select count(*)::int as n from fit.foods where barcode = '8480000123456' and user_id is null");
    expect(common[0].n).toBe(1);
  });

  it("lookupBarcode: sin producto, incompleto o con OFF caído devuelve el motivo y no guarda nada", async () => {
    const off = fakeOff({ "8410000000017": OFF_INCOMPLETO });
    const missing = await lookupBarcode(a, { barcode: "8480000999999" }, db, off.fetchImpl);
    expect(missing).toMatchObject({ food: null, cause: "no_encontrado", barcode: "8480000999999" });

    const partial = await lookupBarcode(a, { barcode: "8410000000017" }, db, off.fetchImpl);
    expect(partial).toMatchObject({ food: null, cause: "incompleto" });

    const down: FetchLike = async () => new Response("", { status: 500 });
    const ext = await lookupBarcode(a, { barcode: "8410000000024" }, db, down);
    expect(ext).toMatchObject({ food: null, cause: "externo" });

    const saved = await db.query<{ n: number }>("select count(*)::int as n from fit.foods where barcode in ('8480000999999', '8410000000017', '8410000000024')");
    expect(saved[0].n).toBe(0);
    await expect(lookupBarcode(a, { barcode: "12ab" }, db, off.fetchImpl)).rejects.toMatchObject({ code: "entrada_invalida" });
  });

  it("lo propio va antes que lo común en lookup y en búsqueda", async () => {
    const mine = await createFood(a, { name: "Yogur griego (mi etiqueta)", barcode: "8480000123456", kcal100: 118, protein100: 4, carbs100: 4, fat100: 9.5 }, db);
    expect(mine.isOwn).toBe(true);
    const found = await lookupBarcode(a, { barcode: "8480000123456" }, db);
    expect(found.food?.id).toBe(mine.id);
    const theirs = await lookupBarcode(b, { barcode: "8480000123456" }, db);
    expect(theirs.food?.isOwn).toBe(false);
    await expect(createFood(a, { name: "Otro", barcode: "8480000123456", kcal100: 1, protein100: 0, carbs100: 0, fat100: 0 }, db)).rejects.toMatchObject({ code: "conflicto" });

    const res = await searchFoods(a, { q: "YOGUR" }, db);
    expect(res.map((f) => f.isOwn)).toEqual([true, false]);
  });

  it("searchFoods ignora acentos y mayúsculas y filtra por tienda y categoría", async () => {
    expect((await searchFoods(a, { q: "pina" }, db)).map((f) => f.name)).toEqual(["Piña en su jugo"]);
    expect((await searchFoods(a, { q: "ATUN natural" }, db)).map((f) => f.name)).toEqual(["Atún al natural"]);
    expect((await searchFoods(a, { q: "", store: "lidl" }, db)).map((f) => f.name)).toEqual(["Queso fresco batido"]);
    expect((await searchFoods(a, { q: "", category: "proteina", store: "mercadona" }, db)).map((f) => f.name).sort()).toEqual(["Atún al natural", "Pechuga de pollo"]);
    expect(await searchFoods(a, { q: "100%" }, db)).toEqual([]);
  });

  it("updateFoodPrice en un alimento común crea la copia propia con el precio y no toca el común", async () => {
    const [pina] = await searchFoods(a, { q: "piña" }, db);
    const r = await updateFoodPrice(a, { foodId: pina.id, priceEur: 1.4, packageG: 560, checkedOn: "2026-10-20" }, db);
    expect(r.copied).toBe(true);
    expect(r.food).toMatchObject({ isOwn: true, name: "Piña en su jugo", priceEur: 1.4, packageG: 560, pricePerKg: 2.5, priceCheckedOn: "2026-10-20" });
    const common = await db.query<{ price_eur: number | null }>("select price_eur from fit.foods where id = $1", [pina.id]);
    expect(common[0].price_eur).toBeNull();

    // Segunda vez: reutiliza la copia, no crea otra.
    const again = await updateFoodPrice(a, { foodId: pina.id, priceEur: 1.5, packageG: 560, checkedOn: "2026-10-21" }, db);
    expect(again.copied).toBe(false);
    expect(again.food.id).toBe(r.food.id);
    expect(again.food.priceEur).toBe(1.5);
    const mineOnly = await withUser(b, (tx) => tx.query("select 1 from fit.foods where id = $1", [r.food.id]), db);
    expect(mineOnly).toEqual([]);
  });

  it("rankByBudget ordena por proteína por euro lo que tiene precio vigente y aparta lo caducado", async () => {
    const r = await rankByBudget(b, {}, db);
    expect(r.ranked.map((x) => x.food.name)).toEqual(["Queso fresco batido", "Pechuga de pollo"]);
    // Queso: 80 g de proteína por kg a 1,98 €/kg → 40,4 g/€. Pollo: 230 g/kg a 6,50 €/kg → 35,4 g/€.
    expect(r.ranked.map((x) => x.proteinPerEuro)).toEqual([40.4, 35.4]);
    expect(r.stale.map((x) => x.food.name)).toEqual(["Atún al natural"]);
    expect(r.stale[0].priceAgeDays).toBeGreaterThanOrEqual(60);

    const merca = await rankByBudget(b, { store: "mercadona" }, db);
    expect(merca.ranked.map((x) => x.food.name)).toEqual(["Pechuga de pollo"]);
    // Con otra fecha de referencia, todo ha caducado.
    const later = await rankByBudget(b, { asOf: "2030-01-01" }, db);
    expect(later.ranked).toEqual([]);
    expect(later.stale).toHaveLength(3);
  });
});
