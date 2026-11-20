/** Ayudantes de las Server Actions. Solo servidor: no importar desde componentes cliente. */
import type { z } from "zod";
import { AppError } from "@/server/errors";
import type { ActionError, ActionResult } from "@/lib/result";

const FALLBACK: Record<string, string> = {
  no_autorizado: "La sesión ha caducado. Vuelve a entrar.",
  externo: "Un servicio externo no ha respondido. Prueba otra vez en un momento.",
};

const isNextSignal = (e: unknown) =>
  !!e && typeof e === "object" && "digest" in e && typeof (e as { digest?: unknown }).digest === "string" && /^NEXT_/.test((e as { digest: string }).digest);

/** Traduce AppError a `{ ok: false }`. Lo inesperado se registra sin datos y sale con un mensaje neutro. */
export function fail(e: unknown): { ok: false; error: ActionError } {
  // Las señales de control de Next (redirect, notFound) tienen que seguir su camino.
  if (isNextSignal(e)) throw e;
  if (e instanceof AppError)
    return { ok: false, error: { code: e.code, message: e.message || FALLBACK[e.code] || "No se pudo guardar.", details: e.code === "ambiguo" ? e.details : undefined } };
  console.error("[accion]", e instanceof Error ? e.message : "error desconocido");
  return { ok: false, error: { code: "interno", message: "Algo ha fallado al guardar. Prueba otra vez." } };
}

/**
 * Ejecuta un caso de uso con el atleta de la sesión. Si se pasa el schema zod del servicio, valida antes
 * y devuelve el primer problema en claro.
 */
export async function act<I, T>(schema: z.ZodType | null, input: I, fn: (userId: string, input: I) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const { requireUser } = await import("@/server/auth");
    const userId = await requireUser();
    if (schema) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return {
          ok: false,
          error: {
            code: "entrada_invalida",
            message: first ? `${first.path.join(".") || "Dato"}: ${first.message}` : "Datos no válidos.",
            details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        };
      }
    }
    return { ok: true, data: await fn(userId, input) };
  } catch (e) {
    return fail(e);
  }
}
