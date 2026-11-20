/** Forma común de lo que devuelve una Server Action: nunca lanza por un error de dominio. */
export type ActionError = { code: string; message: string; details?: unknown };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };
