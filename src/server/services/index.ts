/**
 * Barril de servicios: un único punto de importación para la app y el MCP.
 *   import { getToday, logSet, getNutritionDay } from "@/server/services";
 *
 * Hay nombres repetidos entre ficheros (ayudantes comunes y un tipo). Se resuelven aquí de forma explícita:
 *  - `parseInput`, `IsoDate`, `athleteTz`: los de athlete.ts. Los de annotations.ts salen con sufijo `Loose`/`Any`.
 *  - `normalizeText`: el de library.ts. El de foods.ts sale como `normalizeFoodText`.
 *  - `Annotation`: el de annotations.ts (fila completa). El resumen que devuelve finishWorkout sale como `WorkoutAnnotation`.
 */
export * from "./athlete";
export * from "./library";
export * from "./plan";
export * from "./training";
export * from "./wellness";
export * from "./analytics";
export * from "./nutrition";
export * from "./foods";
export * from "./cardio";
export * from "./health";
export * from "./media";
export * from "./annotations";
export * from "./today";

export { parseInput, IsoDate, athleteTz } from "./athlete";
export { parseInput as parseInputLoose, IsoDate as IsoDateLoose, athleteTz as athleteTzAny } from "./annotations";
export { normalizeText } from "./library";
export { normalizeText as normalizeFoodText } from "./foods";
export type { Annotation } from "./annotations";
export type { Annotation as WorkoutAnnotation } from "./training";
