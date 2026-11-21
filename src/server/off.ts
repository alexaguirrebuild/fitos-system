/**
 * Cliente de Open Food Facts (API v2, solo lectura). Datos con licencia ODbL.
 * `fetchImpl` es inyectable: los tests no salen a internet.
 */
import { kcalFromKj } from "@/engine/nutrition";
import { AppError, invalid } from "@/server/errors";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const OFF_FIELDS = "code,product_name,product_name_es,brands,quantity,product_quantity,serving_size,serving_quantity,nutriments,nutriscore_grade,stores_tags";
const DEFAULT_USER_AGENT = "fitos-system/0.1 (app personal de entrenamiento)";

export const offProductUrl = (barcode: string) => `https://world.openfoodfacts.org/product/${barcode}`;
const offApiUrl = (barcode: string) => `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=${OFF_FIELDS}&lc=es`;

/** Deja solo dígitos. Devuelve null si no quedan entre 8 y 14. */
export function cleanBarcode(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

/** El mismo producto puede estar como UPC (12) o EAN-13 con cero delante. */
export function barcodeVariants(code: string): string[] {
  if (code.length === 12) return [code, `0${code}`];
  if (code.length === 13 && code.startsWith("0")) return [code, code.slice(1)];
  return [code];
}

export type OffFood = {
  name: string;
  brand: string | null;
  barcode: string;
  kcal_100: number;
  protein_100: number;
  carbs_100: number;
  fat_100: number;
  fiber_100: number | null;
  sugar_100: number | null;
  salt_100: number | null;
  serving_g: number | null;
  serving_label: string | null;
  package_g: number | null;
  is_liquid: boolean;
  store: "mercadona" | "lidl" | null;
};
export type OffNormalized = { food: OffFood; reason: null } | { food: null; reason: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

type Amount = { value: number; unit: "g" | "ml" };
const UNIT: Record<string, [Amount["unit"], number]> = { kg: ["g", 1000], g: ["g", 1], mg: ["g", 0.001], l: ["ml", 1000], dl: ["ml", 100], cl: ["ml", 10], ml: ["ml", 1] };

/** Cantidades de un texto de etiqueta: «200 ml (206 g)», «6 x 125 g», «1,5 L». */
function amounts(text: string): Amount[] {
  const out: Amount[] = [];
  const re = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|mg|g|ml|cl|dl|l)(?![a-záéíóúñ])/gi;
  for (const m of text.matchAll(re)) {
    const [unit, factor] = UNIT[m[3].toLowerCase()];
    const value = Number(m[2].replace(",", ".")) * factor * (m[1] ? Number(m[1]) : 1);
    if (Number.isFinite(value) && value > 0) out.push({ value, unit });
  }
  return out;
}

/** Porción en gramos: si la etiqueta da gramos, mandan; si solo da ml, 1 ml ≈ 1 g. */
export function parseServing(text: string | null | undefined): { grams: number | null; liquid: boolean } {
  if (!text) return { grams: null, liquid: false };
  const a = amounts(text);
  const g = a.find((x) => x.unit === "g");
  const ml = a.find((x) => x.unit === "ml");
  return { grams: g ? round(g.value, 1) : ml ? round(ml.value, 1) : null, liquid: a.length > 0 && a[0].unit === "ml" };
}

// Lista corta y explícita de marcas propias. Si no está aquí, la tienda sale de `stores_tags` o se queda sin tienda.
const MERCADONA_BRANDS = ["hacendado"];
const LIDL_BRANDS = ["milbona", "realvalle", "crownfield", "alesto", "combino", "solevita", "freeway", "sondey", "vemondo"];

function detectStore(storesTags: unknown, brands: string | null): OffFood["store"] {
  const tags = Array.isArray(storesTags) ? storesTags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [];
  const brand = (brands ?? "").toLowerCase();
  if (tags.some((t) => t.includes("mercadona")) || MERCADONA_BRANDS.some((b) => brand.includes(b))) return "mercadona";
  if (tags.some((t) => t.includes("lidl")) || LIDL_BRANDS.some((b) => brand.includes(b))) return "lidl";
  return null;
}

/**
 * Pasa la respuesta de OFF (entera o solo `product`) a una fila de `foods`.
 * Si falta energía, proteína, hidratos o grasa no devuelve alimento: un producto a medias no se guarda.
 */
export function normalizeOffProduct(json: unknown): OffNormalized {
  if (!isObj(json)) return { food: null, reason: "Respuesta de Open Food Facts vacía." };
  const p = isObj(json.product) ? json.product : json;
  const barcode = cleanBarcode(String(p.code ?? json.code ?? ""));
  if (!barcode) return { food: null, reason: "El producto no trae un código de barras válido." };
  const name = str(p.product_name_es) ?? str(p.product_name);
  if (!name) return { food: null, reason: "El producto no tiene nombre en Open Food Facts." };

  const n = isObj(p.nutriments) ? p.nutriments : {};
  const kj = num(n["energy-kj_100g"]) ?? num(n["energy_100g"]);
  const kcal = num(n["energy-kcal_100g"]) ?? (kj != null ? kcalFromKj(kj) : null);
  const protein = num(n["proteins_100g"]);
  const carbs = num(n["carbohydrates_100g"]);
  const fat = num(n["fat_100g"]);
  const missing = [kcal == null && "energía", protein == null && "proteína", carbs == null && "hidratos", fat == null && "grasa"].filter(Boolean);
  if (missing.length) return { food: null, reason: `Producto incompleto en Open Food Facts: falta ${missing.join(", ")} por 100 g.` };
  if (kcal! < 0 || kcal! > 950 || [protein!, carbs!, fat!].some((v) => v < 0 || v > 100))
    return { food: null, reason: "Los valores por 100 g de Open Food Facts no son creíbles: revísalos a mano." };

  const brands = str(p.brands);
  const quantity = str(p.quantity);
  const servingSize = str(p.serving_size);
  const serving = parseServing(servingSize);
  const servingQty = num(p.serving_quantity);
  const qty = quantity ? amounts(quantity) : [];
  const productQty = num(p.product_quantity);
  const optional = (v: number | null, d: number) => (v == null || v < 0 || v > 100 ? null : round(v, d));

  return {
    reason: null,
    food: {
      name: name.slice(0, 200),
      brand: brands ? brands.split(",")[0].trim().slice(0, 120) : null,
      barcode,
      kcal_100: round(kcal!, 1),
      protein_100: round(protein!, 1),
      carbs_100: round(carbs!, 1),
      fat_100: round(fat!, 1),
      fiber_100: optional(num(n["fiber_100g"]), 1),
      sugar_100: optional(num(n["sugars_100g"]), 1),
      salt_100: optional(num(n["salt_100g"]), 2),
      serving_g: servingQty != null && servingQty > 0 && servingQty < 5000 ? round(servingQty, 1) : serving.grams,
      serving_label: servingSize ? servingSize.slice(0, 80) : null,
      package_g: productQty != null && productQty > 0 && productQty < 100_000 ? round(productQty, 1) : qty[0] ? round(qty[0].value, 1) : null,
      is_liquid: qty.length > 0 ? qty[0].unit === "ml" : serving.liquid,
      store: detectStore(p.stores_tags, brands),
    },
  };
}

export type FetchOffOptions = { fetchImpl?: FetchLike; userAgent?: string; timeoutMs?: number };

async function getOnce(code: string, o: Required<Pick<FetchOffOptions, "timeoutMs">> & { fetchImpl: FetchLike; userAgent: string }): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await o.fetchImpl(offApiUrl(code), { headers: { "User-Agent": o.userAgent, Accept: "application/json" }, signal: ctrl.signal });
  } catch (e) {
    const timedOut = ctrl.signal.aborted || (e instanceof Error && e.name === "AbortError");
    throw new AppError("externo", timedOut ? "Open Food Facts no responde (tiempo agotado)." : "No se pudo conectar con Open Food Facts.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AppError("externo", `Open Food Facts respondió ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AppError("externo", "Open Food Facts devolvió una respuesta que no es JSON.");
  }
  if (!isObj(body) || body.status === 0 || body.status === "0" || !isObj(body.product)) return null;
  return body;
}

/**
 * Pide un producto por código de barras. Devuelve la respuesta cruda de OFF o `null` si no existe.
 * Reintenta una vez con/sin cero inicial (UPC ↔ EAN-13). Timeout o 5xx → AppError("externo").
 */
export async function fetchOffProduct(barcode: string, opts: FetchOffOptions = {}): Promise<unknown | null> {
  const code = cleanBarcode(barcode);
  if (!code) throw invalid("Código de barras no válido: deben ser entre 8 y 14 dígitos.");
  const o = {
    fetchImpl: opts.fetchImpl ?? (globalThis.fetch as FetchLike),
    userAgent: opts.userAgent ?? process.env.OFF_USER_AGENT ?? DEFAULT_USER_AGENT,
    timeoutMs: opts.timeoutMs ?? 10_000,
  };
  for (const variant of barcodeVariants(code)) {
    const found = await getOnce(variant, o);
    if (found) return found;
  }
  return null;
}
