/** Errores de dominio con código estable: la API, las acciones y el MCP los traducen sin adivinar. */
export type ErrorCode = "no_autorizado" | "no_encontrado" | "entrada_invalida" | "ambiguo" | "conflicto" | "limite" | "externo";

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
    this.name = "AppError";
  }
}
export const notFound = (what: string) => new AppError("no_encontrado", `${what} no existe o no es tuyo.`);
export const invalid = (msg: string, details?: unknown) => new AppError("entrada_invalida", msg, details);
