/** Formato de cifras y fechas para la interfaz. Sin dependencias: sirve en servidor y en cliente. */

/** Número con coma decimal y como mucho `d` decimales (sin ceros de relleno). */
export function num(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const f = 10 ** d;
  return String(Math.round(n * f) / f).replace(".", ",");
}

/** Entero con separador de miles español (8.450). */
export function int(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export const signed = (n: number | null | undefined, d = 1) =>
  n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${num(Math.abs(n), d)}`;

/** Texto del usuario → número. Acepta coma o punto decimal. Vacío o basura → null. */
export function parseNum(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!s || !/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** '2026-11-20' → '20 nov'. Con `ref`, añade el año si no coincide con el de `ref`. */
export function day(iso: string | null | undefined, ref?: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const base = `${d} ${MONTHS[m - 1]}`;
  return ref && Number(ref.slice(0, 4)) !== y ? `${base} ${y}` : base;
}

export function weekday(iso: string): string {
  return WEEKDAYS[new Date(iso.slice(0, 10) + "T00:00:00Z").getUTCDay()];
}

export const diffDays = (from: string, to: string) =>
  Math.round((Date.parse(to.slice(0, 10) + "T00:00:00Z") - Date.parse(from.slice(0, 10) + "T00:00:00Z")) / 86_400_000);

/** Fecha relativa a hoy: «hoy», «ayer», «hace 3 días», y si es más viejo, la fecha. */
export function ago(iso: string | null | undefined, today: string): string {
  if (!iso) return "—";
  const n = diffDays(iso, today);
  if (n === 0) return "hoy";
  if (n === 1) return "ayer";
  if (n > 1 && n < 15) return `hace ${n} días`;
  return day(iso, today);
}

/** ISO con hora → 'HH:MM' en la zona indicada. */
export function clock(iso: string | null | undefined, tz = "Europe/Madrid"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-ES", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** Segundos → 'm:ss'. */
export function mmss(total: number): string {
  const s = Math.max(0, Math.round(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Rango de repeticiones: 8-10, o un solo número. */
export function repRange(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null && max == null) return "—";
  if (min == null || max == null || min === max) return String(min ?? max);
  return `${min}-${max}`;
}

/** Serie como '100 × 8 · RIR 2'. */
export function setText(s: { kg: number | null; reps: number | null; rir?: number | null }): string {
  const base = `${num(s.kg ?? 0, 2)} × ${s.reps ?? 0}`;
  return s.rir != null ? `${base} · RIR ${num(s.rir)}` : base;
}

/** Sin acentos ni mayúsculas, para buscar. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const MUSCLE_LABEL: Record<string, string> = {
  biceps: "Bíceps", triceps: "Tríceps", cuadriceps: "Cuádriceps", gluteo: "Glúteo", gluteos: "Glúteos",
};
/** Nombre legible de un id de grupo muscular cuando no se tiene la lista de grupos a mano. */
export const muscleName = (id: string | null | undefined) =>
  id ? MUSCLE_LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, " ") : "—";
