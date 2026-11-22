/**
 * Librería: ejercicios (comunes y propios), alias, alternativas, glosario y objetivos de volumen por grupo.
 *
 * Decisión: un ejercicio propio con el mismo slug que uno común lo «tapa». Así se puede personalizar un
 * ejercicio común (alias, salto de carga) sin tocar el catálogo, que el atleta no puede modificar.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { AppError, invalid, notFound } from "@/server/errors";
import { fatigueCost } from "@/engine";
import { Uuid, parseInput } from "./athlete";

/* ───────────────────────── Tipos y lectura ───────────────────────── */

export const EQUIPMENT_TYPES = ["libre", "multipower", "polea", "placas", "discos", "peso_corporal", "cardio"] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

/** Tipo de equipo a partir del material antiguo (`equipment`). Misma tabla que la migración 0007. */
export function equipmentTypeFrom(equipment: string | null | undefined): EquipmentType | null {
  switch (equipment) {
    case "barra": case "mancuernas": return "libre";
    case "multipower": return "multipower";
    case "polea": return "polea";
    case "maquina": return "placas";
    case "peso_corporal": return "peso_corporal";
    case "bici": case "eliptica": case "cinta": case "ninguno": return "cardio";
    default: return null;
  }
}

export type Exercise = {
  id: string;
  /** Null = librería común. */
  userId: string | null;
  slug: string;
  name: string;
  aliases: string[];
  primaryMuscle: string | null;
  secondaryMuscles: string[];
  kind: "compuesto" | "aislamiento" | "cardio" | "core";
  movementPattern: string | null;
  equipment: string | null;
  equipmentType: EquipmentType | null;
  stability: "unilateral_libre" | "bilateral_libre" | "unilateral_guiado" | "bilateral_guiado";
  resistanceProfile: "constante" | "variable";
  stretchBias: boolean;
  baseCost: number;
  loadStep: number;
  perSide: boolean;
  warmupKind: "no" | "reducido" | "completo";
  ankleLoad: "ninguna" | "baja" | "alta";
  impact: boolean;
  videoUrls: string[];
  cues: string | null;
};

export const EXERCISE_COLS = `e.id, e.user_id as "userId", e.slug, e.name, e.aliases, e.primary_muscle as "primaryMuscle",
  e.secondary_muscles as "secondaryMuscles", e.kind, e.movement_pattern as "movementPattern", e.equipment, e.equipment_type as "equipmentType", e.stability,
  e.resistance_profile as "resistanceProfile", e.stretch_bias as "stretchBias", e.base_cost as "baseCost",
  e.load_step as "loadStep", e.per_side as "perSide", e.warmup_kind as "warmupKind", e.ankle_load as "ankleLoad",
  e.impact, e.video_urls as "videoUrls", e.cues`;

/** Todos los ejercicios visibles; los propios tapan a los comunes con el mismo slug. */
export async function loadLibraryTx(tx: Tx): Promise<Exercise[]> {
  const all = await tx.query<Exercise>(`select ${EXERCISE_COLS} from fit.exercises e order by e.name, e.slug`);
  const own = new Set(all.filter((e) => e.userId).map((e) => e.slug));
  return all.filter((e) => e.userId || !own.has(e.slug));
}

export async function getExerciseTx(tx: Tx, id: string): Promise<Exercise> {
  const r = await tx.query<Exercise>(`select ${EXERCISE_COLS} from fit.exercises e where e.id = $1`, [id]);
  if (!r[0]) throw notFound("El ejercicio");
  return r[0];
}

/* ───────────────────────── Búsqueda ───────────────────────── */

/** Sin acentos, sin mayúsculas, sin signos. */
export const normalizeText = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const slugify = (s: string) => normalizeText(s).replace(/ /g, "-").slice(0, 70).replace(/-+$/, "");

const STOP = new Set(["de", "del", "con", "en", "la", "el", "los", "las", "a", "al", "y", "o", "por", "para"]);
const tokens = (s: string) => normalizeText(s).split(" ").filter((t) => t && !STOP.has(t));
const labels = (e: Exercise) => [e.name, e.slug.replace(/-/g, " "), ...e.aliases];
const ankleSafe = (e: Exercise) => e.ankleLoad !== "alta" && !e.impact;

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Parecido entre dos palabras: 1 iguales; 0,9 plural, prefijo o una errata; 0 distintas. */
function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  if (a.startsWith(b) || b.startsWith(a)) return 0.9;
  return levenshtein(a, b) <= (Math.min(a.length, b.length) > 7 ? 2 : 1) ? 0.9 : 0;
}

/** Coeficiente de Dice sobre palabras, con tolerancia a erratas. 0 a 1. */
function overlap(q: string[], label: string[]): number {
  if (!q.length || !label.length) return 0;
  const free = [...label];
  let hit = 0;
  for (const t of q) {
    let best = 0;
    let at = -1;
    free.forEach((l, i) => { const s = tokenSim(t, l); if (s > best) { best = s; at = i; } });
    if (at >= 0) { hit += best; free.splice(at, 1); }
  }
  return (2 * hit) / (q.length + label.length);
}

const bestOverlap = (q: string[], e: Exercise) => Math.max(...labels(e).map((l) => overlap(q, tokens(l))));

export const SearchExercisesInput = z.object({
  q: z.string().trim().max(120).optional().describe("Texto a buscar en nombre, slug y alias. Sin acentos ni mayúsculas"),
  muscle: z.string().trim().max(40).optional().describe("Id del grupo muscular (p. ej. «cuadriceps»). Sin texto, lista los de ese grupo"),
  ankleSafe: z.boolean().optional().describe("Excluye los ejercicios con carga alta de tobillo o con impacto"),
  equipmentType: z.enum(EQUIPMENT_TYPES).optional().describe("Solo ejercicios de este tipo de equipo: libre, multipower, polea, placas, discos, peso_corporal, cardio"),
  limit: z.number().int().min(1).max(200).default(20).describe("Máximo de resultados"),
});
export type SearchExercisesInput = z.input<typeof SearchExercisesInput>;

export function searchIn(lib: Exercise[], i: z.output<typeof SearchExercisesInput>): Exercise[] {
  let pool = lib;
  if (i.ankleSafe) pool = pool.filter(ankleSafe);
  if (i.equipmentType) pool = pool.filter((e) => e.equipmentType === i.equipmentType);
  if (i.muscle) {
    const m = normalizeText(i.muscle).replace(/ /g, "_");
    pool = pool.filter((e) => e.primaryMuscle === m || e.secondaryMuscles.includes(m));
    // Primero los que lo trabajan como principal.
    pool = [...pool].sort((a, b) => Number(b.primaryMuscle === m) - Number(a.primaryMuscle === m));
  }
  const q = normalizeText(i.q ?? "");
  if (!q) return pool.slice(0, i.limit);
  const qt = tokens(q);
  return pool
    .map((e) => {
      const ls = labels(e).map(normalizeText);
      const score = ls.includes(q) ? 3 : ls.some((l) => l.startsWith(q)) ? 2.5 : ls.some((l) => l.includes(q)) ? 2 : bestOverlap(qt, e);
      return { e, score };
    })
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    .slice(0, i.limit)
    .map((x) => x.e);
}

export async function searchExercises(userId: string, input?: SearchExercisesInput, db?: Db): Promise<Exercise[]> {
  const i = parseInput(SearchExercisesInput, input ?? {});
  return withUser(userId, async (tx) => searchIn(await loadLibraryTx(tx), i), db);
}

/* ───────────────────────── Resolver texto libre ───────────────────────── */

export type ExerciseMatch = { match?: Exercise; candidates: Exercise[] };

const CANDIDATE_MIN = 0.5;
const CLEAR_MIN = 0.75;
const CLEAR_MARGIN = 0.25;

/**
 * Texto → ejercicio. Coincidencia exacta (slug, nombre o alias) → `match`.
 * Si no, candidatos por solapamiento de palabras. Solo hay `match` sin coincidencia exacta cuando un candidato
 * destaca con claridad (≥ 0,75 y 0,25 por encima del segundo). Con varios parecidos no se adivina.
 */
export function resolveIn(lib: Exercise[], text: string): ExerciseMatch {
  const q = normalizeText(text);
  if (!q) return { candidates: [] };
  const exact = lib.filter((e) => labels(e).some((l) => normalizeText(l) === q));
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  if (exact.length > 1) return { candidates: exact };
  const qt = tokens(q);
  const scored = lib.map((e) => ({ e, score: bestOverlap(qt, e) })).filter((x) => x.score >= CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  const candidates = scored.slice(0, 6).map((x) => x.e);
  const [first, second] = scored;
  if (first && first.score >= CLEAR_MIN && (!second || first.score - second.score >= CLEAR_MARGIN)) return { match: first.e, candidates };
  return { candidates };
}

export const ResolveExerciseInput = z.object({
  text: z.string().trim().min(1).max(120).describe("Nombre del ejercicio tal como lo dice el atleta"),
});

export async function resolveExerciseTx(tx: Tx, text: string): Promise<ExerciseMatch> {
  return resolveIn(await loadLibraryTx(tx), text);
}

export async function resolveExercise(userId: string, input: z.input<typeof ResolveExerciseInput> | string, db?: Db): Promise<ExerciseMatch> {
  const { text } = parseInput(ResolveExerciseInput, typeof input === "string" ? { text: input } : input);
  return withUser(userId, (tx) => resolveExerciseTx(tx, text), db);
}

/* ───────────────────────── Alta y alias ───────────────────────── */

export const CreateExerciseInput = z.object({
  name: z.string().trim().min(2).max(120).describe("Nombre del ejercicio"),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(70).optional().describe("Identificador en minúsculas con guiones. Si no viene, sale del nombre"),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional().describe("Otros nombres con los que se le conoce"),
  primaryMuscle: z.string().max(40).nullable().optional().describe("Id del grupo muscular principal"),
  secondaryMuscles: z.array(z.string().max(40)).max(6).optional().describe("Ids de los grupos sinergistas"),
  kind: z.enum(["compuesto", "aislamiento", "cardio", "core"]).optional().describe("Tipo de ejercicio"),
  movementPattern: z.string().max(40).nullable().optional().describe("Patrón: dominante_rodilla, bisagra, empuje_h, empuje_v, traccion_h, traccion_v…"),
  equipment: z.string().max(40).nullable().optional().describe("Material: barra, mancuernas, maquina, polea, multipower, peso_corporal…"),
  equipmentType: z.enum(EQUIPMENT_TYPES).optional().describe("Tipo de equipo. Si no viene, sale del material"),
  stability: z.enum(["unilateral_libre", "bilateral_libre", "unilateral_guiado", "bilateral_guiado"]).optional().describe("Estabilidad que exige"),
  resistanceProfile: z.enum(["constante", "variable"]).optional().describe("Perfil de resistencia"),
  baseCost: z.number().min(0.5).max(2).optional().describe("Coste de fatiga base: 1,5 sentadilla y peso muerto; 1,2 press banca; 1,0 el resto"),
  loadStep: z.number().min(0.25).max(20).optional().describe("Salto real de carga en kg (2,5 barra; 1-2 mancuerna; la placa de la máquina)"),
  perSide: z.boolean().optional().describe("La carga se anota por lado"),
  warmupKind: z.enum(["no", "reducido", "completo"]).optional().describe("Calentamiento que pide"),
  ankleLoad: z.enum(["ninguna", "baja", "alta"]).optional().describe("Carga sobre el tobillo"),
  impact: z.boolean().optional().describe("Tiene impacto (saltos, carrera)"),
  cues: z.string().max(1000).nullable().optional().describe("Claves técnicas"),
});
export type CreateExerciseInput = z.input<typeof CreateExerciseInput>;

export async function createExerciseTx(tx: Tx, i: z.output<typeof CreateExerciseInput>): Promise<Exercise> {
  const slug = i.slug ?? slugify(i.name);
  if (!slug) throw invalid("El nombre no sirve para crear el ejercicio.");
  const dup = await tx.query("select 1 from fit.exercises where user_id = auth.uid() and slug = $1", [slug]);
  if (dup.length) throw new AppError("conflicto", `Ya tienes un ejercicio «${slug}».`);
  const muscles = [i.primaryMuscle, ...(i.secondaryMuscles ?? [])].filter((m): m is string => !!m);
  if (muscles.length) {
    const known = new Set((await tx.query<{ id: string }>("select id from fit.muscle_groups where id = any($1::text[])", [muscles])).map((r) => r.id));
    const bad = muscles.filter((m) => !known.has(m));
    if (bad.length) throw invalid(`Grupo muscular desconocido: ${bad.join(", ")}.`, { unknown: bad });
  }
  const [row] = await tx.query<{ id: string }>(
    `insert into fit.exercises (user_id, slug, name, aliases, primary_muscle, secondary_muscles, kind, movement_pattern, equipment,
       stability, resistance_profile, base_cost, load_step, per_side, warmup_kind, ankle_load, impact, cues, equipment_type)
     values (auth.uid(), $1, $2, $3::text[], $4, $5::text[], coalesce($6, 'aislamiento'), $7, $8, coalesce($9, 'bilateral_guiado'),
       coalesce($10, 'constante'), coalesce($11, 1.0), coalesce($12, 2.5), coalesce($13, false), coalesce($14, 'reducido'),
       coalesce($15, 'ninguna'), coalesce($16, false), $17, $18)
     returning id`,
    [slug, i.name, i.aliases ?? [], i.primaryMuscle ?? null, i.secondaryMuscles ?? [], i.kind ?? null, i.movementPattern ?? null,
      i.equipment ?? null, i.stability ?? null, i.resistanceProfile ?? null, i.baseCost ?? null, i.loadStep ?? null, i.perSide ?? null,
      i.warmupKind ?? null, i.ankleLoad ?? null, i.impact ?? null, i.cues ?? null, i.equipmentType ?? equipmentTypeFrom(i.equipment)],
  );
  return getExerciseTx(tx, row.id);
}

export async function createExercise(userId: string, input: CreateExerciseInput, db?: Db): Promise<Exercise> {
  const i = parseInput(CreateExerciseInput, input);
  return withUser(userId, (tx) => createExerciseTx(tx, i), db);
}

export const AddAliasInput = z.object({
  exerciseId: Uuid.describe("Id del ejercicio"),
  alias: z.string().trim().min(2).max(120).describe("Nombre alternativo con el que el atleta lo llama"),
});

export type AddAliasResult = { exercise: Exercise; cloned: boolean };

/** Otro ejercicio (ni este ni su copia propia) que ya se llama así. Si existe, el alias no se puede añadir. */
export function aliasOwnerIn(lib: Exercise[], ex: Pick<Exercise, "id" | "slug">, alias: string): Exercise | undefined {
  const key = normalizeText(alias);
  return lib.find((e) => e.id !== ex.id && e.slug !== ex.slug && labels(e).some((l) => normalizeText(l) === key));
}

/** ¿El texto ya es nombre, slug o alias de este ejercicio? */
export const hasLabel = (ex: Exercise, text: string) => labels(ex).some((l) => normalizeText(l) === normalizeText(text));

/**
 * Copia propia de un ejercicio común (la crea si no existe). El plan, las series y los vídeos del atleta pasan a apuntar
 * a la copia, para no partir el historial en dos. Un ejercicio que ya es propio se devuelve tal cual.
 */
export async function ownCopyTx(tx: Tx, ex: Exercise, lib?: Exercise[]): Promise<{ exercise: Exercise; cloned: boolean }> {
  if (ex.userId) return { exercise: ex, cloned: false };
  const mine = (lib ?? (await loadLibraryTx(tx))).find((e) => e.userId && e.slug === ex.slug);
  if (mine) return { exercise: mine, cloned: false };
  const [copy] = await tx.query<{ id: string }>(
    `insert into fit.exercises (user_id, slug, name, aliases, primary_muscle, secondary_muscles, kind, movement_pattern, equipment,
       stability, resistance_profile, stretch_bias, base_cost, load_step, per_side, warmup_kind, ankle_load, impact, video_urls, cues, equipment_type)
     select auth.uid(), slug, name, aliases, primary_muscle, secondary_muscles, kind, movement_pattern, equipment,
       stability, resistance_profile, stretch_bias, base_cost, load_step, per_side, warmup_kind, ankle_load, impact, video_urls, cues, equipment_type
     from fit.exercises where id = $1 returning id`, [ex.id]);
  for (const table of ["prescriptions", "workout_sets", "workout_exercises", "videos"])
    await tx.query(`update fit.${table} set exercise_id = $1 where exercise_id = $2`, [copy.id, ex.id]);
  await tx.query("update fit.workout_exercises set replaces_exercise_id = $1 where replaces_exercise_id = $2", [copy.id, ex.id]);
  return { exercise: await getExerciseTx(tx, copy.id), cloned: true };
}

/**
 * Añade un alias. El catálogo común no se puede tocar, así que un ejercicio común se copia como propio
 * (mismo slug: lo tapa) y el plan, las series y los vídeos del atleta pasan a apuntar a la copia,
 * para no partir el historial en dos.
 */
export async function addAliasTx(tx: Tx, i: z.output<typeof AddAliasInput>): Promise<AddAliasResult> {
  const lib = await loadLibraryTx(tx);
  let ex = await getExerciseTx(tx, i.exerciseId);
  const owner = aliasOwnerIn(lib, ex, i.alias);
  if (owner) throw new AppError("conflicto", `«${i.alias}» ya es el nombre de ${owner.name}.`, { exerciseId: owner.id });

  const own = await ownCopyTx(tx, ex, lib);
  ex = own.exercise;
  const cloned = own.cloned;
  if (!hasLabel(ex, i.alias))
    await tx.query("update fit.exercises set aliases = array_append(aliases, $1) where id = $2", [i.alias, ex.id]);
  return { exercise: await getExerciseTx(tx, ex.id), cloned };
}

export async function addAlias(userId: string, input: z.input<typeof AddAliasInput>, db?: Db): Promise<AddAliasResult> {
  const i = parseInput(AddAliasInput, input);
  return withUser(userId, (tx) => addAliasTx(tx, i), db);
}

/* ───────────────────────── Alternativas ───────────────────────── */

export const FindAlternativesInput = z.object({
  exerciseId: Uuid.describe("Id del ejercicio a sustituir"),
  ankleSafe: z.boolean().optional().describe("Solo alternativas sin carga alta de tobillo ni impacto"),
  limit: z.number().int().min(1).max(30).default(8).describe("Máximo de alternativas"),
});

export type Alternative = Exercise & { fatigueCost: number };

export const exerciseCost = (e: Pick<Exercise, "baseCost" | "stability" | "resistanceProfile">) =>
  Math.round(fatigueCost({ base: e.baseCost, stability: e.stability, resistance: e.resistanceProfile }) * 100) / 100;

/** Mismo músculo principal y mismo patrón, de menor a mayor coste de fatiga. */
export function alternativesIn(lib: Exercise[], ex: Exercise, opts: { ankleSafe?: boolean; limit?: number } = {}): Alternative[] {
  if (!ex.primaryMuscle) return [];
  return lib
    .filter((e) => e.id !== ex.id && e.slug !== ex.slug && e.kind !== "cardio" && e.primaryMuscle === ex.primaryMuscle)
    .filter((e) => !ex.movementPattern || e.movementPattern === ex.movementPattern)
    .filter((e) => !opts.ankleSafe || ankleSafe(e))
    .map((e) => ({ ...e, fatigueCost: exerciseCost(e) }))
    .sort((a, b) => a.fatigueCost - b.fatigueCost || a.name.localeCompare(b.name))
    .slice(0, opts.limit ?? 8);
}

export async function findAlternatives(userId: string, input: z.input<typeof FindAlternativesInput>, db?: Db): Promise<Alternative[]> {
  const i = parseInput(FindAlternativesInput, input);
  return withUser(userId, async (tx) => alternativesIn(await loadLibraryTx(tx), await getExerciseTx(tx, i.exerciseId), i), db);
}

/* ───────────────────────── Glosario ───────────────────────── */

export type GlossaryTerm = { slug: string; term: string; category: string; definition: string; notes: string | null; source: string | null };

export const GetGlossaryInput = z.object({
  q: z.string().trim().max(80).optional().describe("Texto a buscar en el término o en la definición"),
  category: z.string().trim().max(40).optional().describe("Categoría: tecnica, volumen, intensidad, nutricion, cardio, recuperacion"),
});

/** Lleva `userId` porque el glosario solo es legible con sesión (RLS). */
export async function getGlossary(userId: string, input?: z.input<typeof GetGlossaryInput>, db?: Db): Promise<GlossaryTerm[]> {
  const i = parseInput(GetGlossaryInput, input ?? {});
  const q = normalizeText(i.q ?? "");
  return withUser(userId, async (tx) => {
    const rows = await tx.query<GlossaryTerm>(
      "select slug, term, category, definition, notes, source from fit.glossary where ($1::text is null or category = $1) order by term",
      [i.category ?? null]);
    if (!q) return rows;
    const inTerm = rows.filter((r) => normalizeText(`${r.term} ${r.slug}`).includes(q));
    const inBody = rows.filter((r) => !inTerm.includes(r) && normalizeText(`${r.definition} ${r.notes ?? ""}`).includes(q));
    return [...inTerm, ...inBody];
  }, db);
}

/* ───────────────────────── Grupos musculares y volumen ───────────────────────── */

export type MuscleGroup = {
  id: string;
  name: string;
  region: "torso" | "brazo" | "pierna" | "core";
  /** Series efectivas por semana: mínimo y máximo vigentes (los propios si existen). */
  mev: number;
  mrv: number;
  defaultMev: number;
  defaultMrv: number;
  custom: boolean;
  priority: number | null;
  halfLifeH: number;
};

export async function listMuscleGroupsTx(tx: Tx): Promise<MuscleGroup[]> {
  return tx.query<MuscleGroup>(
    `select m.id, m.name, m.region, coalesce(t.mev, m.default_mev) as mev, coalesce(t.mrv, m.default_mrv) as mrv,
       m.default_mev as "defaultMev", m.default_mrv as "defaultMrv", (t.muscle_id is not null) as custom, t.priority,
       m.half_life_h as "halfLifeH"
     from fit.muscle_groups m left join fit.athlete_volume_targets t on t.muscle_id = m.id
     order by m.region, m.name`);
}

export async function listMuscleGroups(userId: string, _input?: unknown, db?: Db): Promise<MuscleGroup[]> {
  return withUser(userId, listMuscleGroupsTx, db);
}

export const SetVolumeTargetInput = z.object({
  muscleId: z.string().trim().min(2).max(40).describe("Id del grupo muscular"),
  mev: z.number().min(0).max(40).describe("Mínimo de series efectivas por semana"),
  mrv: z.number().min(1).max(60).describe("Máximo recuperable de series efectivas por semana"),
  priority: z.number().int().min(1).max(5).nullable().optional().describe("Prioridad del grupo: 1 la más alta"),
});

export async function setVolumeTarget(userId: string, input: z.input<typeof SetVolumeTargetInput>, db?: Db): Promise<MuscleGroup> {
  const i = parseInput(SetVolumeTargetInput, input);
  if (i.mev > i.mrv) throw invalid("El mínimo no puede superar al máximo.");
  return withUser(userId, async (tx) => {
    const known = await tx.query("select 1 from fit.muscle_groups where id = $1", [i.muscleId]);
    if (!known.length) throw notFound("El grupo muscular");
    await tx.query(
      `insert into fit.athlete_volume_targets (muscle_id, mev, mrv, priority) values ($1, $2, $3, $4)
       on conflict (user_id, muscle_id) do update set mev = excluded.mev, mrv = excluded.mrv,
         priority = coalesce(excluded.priority, fit.athlete_volume_targets.priority), updated_at = now()`,
      [i.muscleId, i.mev, i.mrv, i.priority ?? null]);
    return (await listMuscleGroupsTx(tx)).find((m) => m.id === i.muscleId)!;
  }, db);
}

/* ───────────────────────── Nombres del histórico sin enlazar ───────────────────────── */

export const ListUnlinkedNamesInput = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe("Máximo de nombres, de más a menos series"),
});

export type UnlinkedName = { rawName: string; sets: number; lastDate: string | null; candidates: { id: string; slug: string; name: string }[] };

/** Igual que `listUnlinkedNames`, dentro de una transacción ya abierta (el simulacro la abre en solo lectura). */
export async function listUnlinkedNamesTx(tx: Tx, limit: number): Promise<UnlinkedName[]> {
  const rows = await tx.query<{ rawName: string; sets: number; lastDate: string | null }>(
    `select s.exercise_name_raw as "rawName", count(*)::int as sets, max(w.date) as "lastDate"
     from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
     where s.exercise_id is null and s.exercise_name_raw is not null and btrim(s.exercise_name_raw) <> ''
     group by s.exercise_name_raw order by count(*) desc, s.exercise_name_raw limit $1`, [limit]);
  const lib = await loadLibraryTx(tx);
  return rows.map((r) => ({
    ...r,
    candidates: resolveIn(lib, r.rawName).candidates.slice(0, 3).map((e) => ({ id: e.id, slug: e.slug, name: e.name })),
  }));
}

/** Nombres en texto libre de series sin ejercicio, agrupados, con hasta 3 candidatos de la librería. */
export async function listUnlinkedNames(userId: string, input?: z.input<typeof ListUnlinkedNamesInput>, db?: Db): Promise<UnlinkedName[]> {
  const i = parseInput(ListUnlinkedNamesInput, input ?? {});
  return withUser(userId, (tx) => listUnlinkedNamesTx(tx, i.limit), db);
}

export const LinkRawNameInput = z.object({
  rawName: z.string().min(1).max(200).describe("El nombre en texto libre, tal como sale en list_unlinked_exercise_names"),
  exerciseId: Uuid.describe("Id del ejercicio al que se enlazan esas series"),
});

export type LinkRawNameResult = { linked: number; exercise: Exercise; aliasAdded: boolean; cloned: boolean };

/**
 * Enlaza todas las series con ese texto al ejercicio y guarda el texto como alias, para que no vuelva a quedar suelto.
 * No recalcula e1RM: sus métricas no dependen del ejercicio.
 */
export async function linkRawName(userId: string, input: z.input<typeof LinkRawNameInput>, db?: Db): Promise<LinkRawNameResult> {
  const i = parseInput(LinkRawNameInput, input);
  return withUser(userId, async (tx) => {
    const [{ n }] = await tx.query<{ n: number }>(
      "select count(*)::int as n from fit.workout_sets where exercise_id is null and exercise_name_raw = $1", [i.rawName]);
    if (!n) throw notFound(`Ninguna serie suelta con el nombre «${i.rawName}»`);
    const before = await getExerciseTx(tx, i.exerciseId);
    let aliasAdded = false;
    let cloned = false;
    let ex = before;
    const alias = i.rawName.trim();
    if (alias.length >= 2 && !hasLabel(before, alias)) {
      const r = await addAliasTx(tx, { exerciseId: i.exerciseId, alias });
      ex = r.exercise; cloned = r.cloned; aliasAdded = true;
    }
    await tx.query("update fit.workout_sets set exercise_id = $1 where exercise_id is null and exercise_name_raw = $2", [ex.id, i.rawName]);
    return { linked: n, exercise: ex, aliasAdded, cloned };
  }, db);
}
