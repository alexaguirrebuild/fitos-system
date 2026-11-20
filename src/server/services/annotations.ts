/**
 * Anotaciones (lo que el motor o el atleta dejan apuntado) y registro de auditoría.
 * También vive aquí lo común a los servicios de nutrición, cardio, salud y medios:
 * validación de entrada en español y la zona horaria del atleta.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { invalid, notFound } from "@/server/errors";
import { DEFAULT_TZ, addDays, isIsoDate, todayIn } from "@/server/time";

/* ----------------------------- Común ----------------------------- */

const esErrors = z.locales.es().localeError;

/** Valida con zod y lanza AppError("entrada_invalida") con los mensajes en español. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input, { error: esErrors });
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`).join("; ");
    throw invalid(`Entrada no válida. ${msg}`, r.error.issues);
  }
  return r.data;
}

export const IsoDate = z.string().refine(isIsoDate, "Fecha no válida: usa AAAA-MM-DD");
export const Id = z.guid();
export const IsoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Fecha y hora no válidas: usa ISO 8601");

export async function athleteTz(tx: Tx): Promise<string> {
  const r = await tx.query<{ timezone: string }>("select timezone from fit.athletes limit 1");
  return r[0]?.timezone || DEFAULT_TZ;
}

/** Hora local 'HH:MM' de un instante en la zona del atleta. */
export function localTimeIn(tz: string, at: Date): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

export const toIso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/* --------------------------- Anotaciones --------------------------- */

export const ANNOTATION_SCOPES = ["ejercicio", "sesion", "volumen", "nutricion", "recuperacion", "tobillo", "cardio", "material"] as const;
export const ANNOTATION_SEVERITIES = ["info", "aviso", "accion"] as const;
export const ANNOTATION_ORIGINS = ["motor", "atleta", "muse"] as const;

export const AddAnnotationInput = z.object({
  date: IsoDate.optional().describe("Día de la anotación (AAAA-MM-DD). Por defecto, hoy."),
  scope: z.enum(ANNOTATION_SCOPES).describe("Ámbito: ejercicio, sesion, volumen, nutricion, recuperacion, tobillo, cardio o material."),
  title: z.string().trim().min(1).max(200).describe("Título corto de la anotación."),
  body: z.string().trim().max(4000).optional().describe("Detalle de la anotación."),
  severity: z.enum(ANNOTATION_SEVERITIES).optional().describe("Gravedad: info, aviso o accion. Por defecto, info."),
  origin: z.enum(ANNOTATION_ORIGINS).optional().describe("Quién la escribe: motor, atleta o muse. Por defecto, atleta."),
  rule: z.string().trim().max(80).optional().describe("Regla del motor que la generó, si la hay."),
  refTable: z.string().trim().max(60).optional().describe("Tabla del registro al que apunta (p. ej. cardio_sessions)."),
  refId: Id.optional().describe("Id del registro al que apunta."),
});
export type AddAnnotationInput = z.input<typeof AddAnnotationInput>;

export const ListAnnotationsInput = z.object({
  days: z.number().int().min(1).max(365).optional().describe("Cuántos días hacia atrás. Por defecto, 14."),
  scope: z.enum(ANNOTATION_SCOPES).optional().describe("Filtra por ámbito."),
  includeDismissed: z.boolean().optional().describe("Incluye también las descartadas. Por defecto, no."),
});
export type ListAnnotationsInput = z.input<typeof ListAnnotationsInput>;

export const DismissAnnotationInput = z.object({
  annotationId: Id.describe("Id de la anotación que se descarta."),
});
export type DismissAnnotationInput = z.input<typeof DismissAnnotationInput>;

export type Annotation = {
  id: string;
  date: string;
  origin: (typeof ANNOTATION_ORIGINS)[number];
  scope: (typeof ANNOTATION_SCOPES)[number];
  rule: string | null;
  severity: (typeof ANNOTATION_SEVERITIES)[number];
  title: string;
  body: string | null;
  refTable: string | null;
  refId: string | null;
  dismissedAt: string | null;
  createdAt: string;
};

type AnnotationRow = {
  id: string; date: string; origin: Annotation["origin"]; scope: Annotation["scope"]; rule: string | null;
  severity: Annotation["severity"]; title: string; body: string | null; ref_table: string | null; ref_id: string | null;
  dismissed_at: Date | string | null; created_at: Date | string;
};

const toAnnotation = (r: AnnotationRow): Annotation => ({
  id: r.id, date: r.date, origin: r.origin, scope: r.scope, rule: r.rule, severity: r.severity, title: r.title, body: r.body,
  refTable: r.ref_table, refId: r.ref_id, dismissedAt: toIso(r.dismissed_at), createdAt: toIso(r.created_at)!,
});

/** Versión para usar dentro de una transacción ya abierta (otros servicios). `origin` por defecto: motor. */
export async function addAnnotationTx(tx: Tx, userId: string, i: z.output<typeof AddAnnotationInput>, defaultOrigin: Annotation["origin"] = "motor"): Promise<Annotation> {
  const date = i.date ?? todayIn(await athleteTz(tx));
  const rows = await tx.query<AnnotationRow>(
    `insert into fit.annotations (user_id, date, origin, scope, rule, severity, title, body, ref_table, ref_id)
     values ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, $9, $10::uuid) returning *`,
    [userId, date, i.origin ?? defaultOrigin, i.scope, i.rule ?? null, i.severity ?? "info", i.title, i.body ?? null, i.refTable ?? null, i.refId ?? null],
  );
  return toAnnotation(rows[0]);
}

export async function addAnnotation(userId: string, input: AddAnnotationInput, db?: Db): Promise<Annotation> {
  const i = parseInput(AddAnnotationInput, input);
  return withUser(userId, (tx) => addAnnotationTx(tx, userId, i, "atleta"), db);
}

export async function listAnnotations(userId: string, input: ListAnnotationsInput = {}, db?: Db): Promise<Annotation[]> {
  const i = parseInput(ListAnnotationsInput, input);
  return withUser(userId, async (tx) => {
    const from = addDays(todayIn(await athleteTz(tx)), -((i.days ?? 14) - 1));
    const rows = await tx.query<AnnotationRow>(
      `select * from fit.annotations
       where date >= $1::date and ($2::text is null or scope = $2) and ($3::boolean or dismissed_at is null)
       order by date desc, created_at desc`,
      [from, i.scope ?? null, i.includeDismissed ?? false],
    );
    return rows.map(toAnnotation);
  }, db);
}

export async function dismissAnnotation(userId: string, input: DismissAnnotationInput, db?: Db): Promise<Annotation> {
  const i = parseInput(DismissAnnotationInput, input);
  return withUser(userId, async (tx) => {
    const rows = await tx.query<AnnotationRow>(
      "update fit.annotations set dismissed_at = coalesce(dismissed_at, now()) where id = $1::uuid returning *",
      [i.annotationId],
    );
    if (!rows[0]) throw notFound("La anotación");
    return toAnnotation(rows[0]);
  }, db);
}

/* ---------------------------- Auditoría ---------------------------- */

/** Añade una línea al registro de auditoría. `actor`: 'app' | 'mcp:<client_id>' | 'ingest:<token_id>'. Nunca secretos en `payload`. */
export async function audit(userId: string, actor: string, action: string, payload?: unknown, db?: Db): Promise<void> {
  if (!actor.trim() || !action.trim()) throw invalid("La auditoría necesita actor y acción.");
  await withUser(userId, (tx) =>
    tx.query("insert into fit.audit_log (user_id, actor, action, payload) values ($1::uuid, $2, $3, $4::jsonb)", [
      userId, actor.slice(0, 120), action.slice(0, 120), payload === undefined ? null : JSON.stringify(payload),
    ]), db);
}
