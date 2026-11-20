/** Lectura de FormData para las Server Actions de formulario. Solo servidor. */
import type { FormState } from "@/components/form-action";
import type { ActionResult } from "@/lib/result";
import { parseNum } from "@/lib/format";

export const text = (f: FormData, k: string): string | undefined => {
  const v = String(f.get(k) ?? "").trim();
  return v ? v : undefined;
};
/** Número con coma o punto. Vacío → undefined. Texto no numérico → NaN (lo rechazará el schema). */
export const number = (f: FormData, k: string): number | undefined => {
  const raw = text(f, k);
  if (raw === undefined) return undefined;
  return parseNum(raw) ?? Number.NaN;
};
export const bool = (f: FormData, k: string): boolean => f.get(k) === "on" || f.get(k) === "true" || f.get(k) === "1";

/** Convierte el resultado de `act` en el estado que pinta <FormAction>. */
export function toState<T>(r: ActionResult<T>, ok: (data: T) => string): FormState {
  return r.ok ? { ok: true, message: ok(r.data) } : { ok: false, message: r.error.message };
}
