/** Fechas del atleta como 'AAAA-MM-DD' en su zona horaria (por defecto Europe/Madrid). */
export const DEFAULT_TZ = "Europe/Madrid";

export function todayIn(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const diffDays = (from: string, to: string) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);

/** Lunes de la semana de `date`. */
export function weekStart(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
