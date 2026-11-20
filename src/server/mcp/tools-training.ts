/** Herramientas de entreno: sesión, series, historial y librería de ejercicios. */
import { z } from "zod";
import { isHardSet, SESSION_CAP } from "@/engine";
import { AppError, invalid } from "@/server/errors";
import {
  AddAliasInput, AddExerciseToWorkoutInput, CreateExerciseInput, DeleteSetInput, FindAlternativesInput, FinishWorkoutInput, GetExerciseHistoryInput,
  ListWorkoutsInput, LogSetInput, LogSorenessInput, SearchExercisesInput, StartWorkoutInput, SwapExerciseInput, UpdateSetInput, Uuid,
  addAlias, addExerciseToWorkout, createExercise, deleteSet, findAlternatives, finishWorkout, getExerciseHistory, getNextSession, getWorkoutView,
  listWorkouts, logSet, logSoreness, searchExercises, startWorkout, swapExercise, updateSet,
  type Exercise, type ExerciseBlock, type NextSet, type SetView, type WorkoutView,
} from "@/server/services";
import { defineTool, type AnyTool } from "./registry";
import { AMBIGUOUS_HINT, exerciseIdOf, lean, limitField, n1, num, r1, rxText, setText } from "./tools-insight";

/* ───────────────────────── Formato ───────────────────────── */

const isWorking = (s: SetView) => s.setType !== "aproximacion" && s.kg != null && s.reps != null && s.reps > 0;
const asLog = (s: { kg: number | null; reps: number | null; rir: number | null }) => ({ kg: s.kg ?? 0, reps: s.reps ?? 0, rir: s.rir });
const compactSet = (s: SetView) => lean({ id: s.id, n: s.setIndex, type: s.setType === "normal" ? null : s.setType, kg: s.kg, reps: s.reps, rir: s.rir, e1rm: n1(s.e1rm), note: s.note });
const restText = (sec: number) => (sec >= 60 ? `${num(sec / 60)} min` : `${sec} s`);
const nextText = (n: NextSet) =>
  `${n.exerciseName}, serie ${n.setNumber}${n.kg != null ? `: ${num(n.kg)} kg` : ""}${n.reps != null ? ` × ${n.reps}` : ""}${n.rir != null ? `, RIR ${num(n.rir)}` : ""}. Descanso: ${restText(n.restSeconds)}`;
const compactExercise = (e: Exercise) => lean({
  id: e.id, name: e.name, muscle: e.primaryMuscle, kind: e.kind, equipment: e.equipment, ankleLoad: e.ankleLoad === "ninguna" ? null : e.ankleLoad,
  aliases: e.aliases.slice(0, 4),
});

const compactBlock = (b: ExerciseBlock) => lean({
  position: b.position, id: b.exercise.id, name: b.exercise.name, origin: b.origin === "plan" ? null : b.origin, replaces: b.replaces?.name ?? null,
  rx: b.prescription ? rxText(b.prescription) : null, technique: b.prescription?.technique ?? null,
  target: b.suggestion ? lean({ kg: b.suggestion.kg, sets: b.suggestion.sets, reps: b.suggestion.repsTarget, rir: b.suggestion.rirTarget, rule: b.suggestion.rule, why: b.suggestion.why }) : null,
  warmup: b.warmup.map((w) => `${num(w.kg)}×${w.reps}`), platesPerSide: b.plates?.plates ?? null,
  last: b.lastSession ? `${b.lastSession.date}: ${b.lastSession.sets.map(setText).join(", ")}` : null,
  bestE1rm: b.bestE1rm ? `${num(b.bestE1rm.value)} kg (${b.bestE1rm.date})` : null,
  capKg: b.loadCap?.kg ?? null, ankleWarning: b.ankleWarning?.message ?? null,
  sets: b.sets.map(compactSet), setsDone: b.workingSetsDone, done: b.done,
});

function compactView(v: WorkoutView) {
  return {
    workout: lean({ id: v.workout.id, date: v.workout.date, name: v.workout.name, status: v.workout.status, srpe: v.workout.srpe, durationMin: v.workout.durationMin, notes: v.workout.notes }),
    readiness: v.readiness, readinessLabel: v.readinessLabel, deload: v.deload,
    exercises: v.exercises.slice(0, 25).map(compactBlock),
    totals: { sets: v.totals.sets, hardSets: v.totals.hardSets, tonnage: r1(v.totals.tonnage) },
    next: v.next,
  };
}

/** Avisos de la sesión que el agente debe leer en voz alta: tobillo, descarga y readiness bajo. */
function viewWarnings(v: WorkoutView): string[] {
  const out = v.exercises.flatMap((b) => (b.ankleWarning ? [b.ankleWarning.message] : []));
  if (v.deload) out.push("Semana de descarga: menos series, misma carga, 2 más en reserva.");
  if (v.readiness != null && v.readiness < 70 && v.readinessLabel) out.push(`Readiness ${v.readiness}: ${v.readinessLabel}`);
  return out;
}

/* ───────────────────────── Lectura ───────────────────────── */

const getWorkoutTool = defineTool({
  name: "get_workout",
  title: "Ver una sesión",
  description: "Úsala para ver una sesión concreta (en curso o pasada): devuelve cada ejercicio con su objetivo de hoy, las series hechas con su id, los totales y la siguiente serie. Sin id, la sesión en curso de hoy.",
  scope: "mcp:read",
  readOnly: true,
  input: z.object({ workoutId: Uuid.optional().describe("Id de la sesión. Sin él, la sesión en curso (o la última de hoy)") }),
  handler: async (ctx, args) => {
    let id = args.workoutId;
    if (!id) {
      const recent = await listWorkouts(ctx.userId, { limit: 5 });
      id = (recent.find((w) => w.status === "en_curso") ?? recent[0])?.id;
      if (!id) throw new AppError("no_encontrado", "Todavía no hay ninguna sesión registrada.");
    }
    return compactView(await getWorkoutView(ctx.userId, id));
  },
});

const listWorkoutsTool = defineTool({
  name: "list_workouts",
  title: "Sesiones recientes",
  description: "Úsala para «qué entrené esta semana» o para encontrar el id de una sesión: devuelve las sesiones de la más reciente a la más antigua con fecha, nombre, estado, series, tonelaje y esfuerzo.",
  scope: "mcp:read",
  readOnly: true,
  input: ListWorkoutsInput.extend({ limit: limitField(50) }),
  handler: async (ctx, args) => {
    const list = await listWorkouts(ctx.userId, args);
    return {
      total: list.length,
      workouts: list.map((w) => lean({ id: w.id, date: w.date, name: w.name, status: w.status, sets: w.sets, hardSets: w.hardSets, tonnage: n1(w.tonnage), srpe: w.srpe, durationMin: w.durationMin, load: w.load })),
    };
  },
});

const getExerciseHistoryTool = defineTool({
  name: "get_exercise_history",
  title: "Historial de un ejercicio",
  description: "Úsala para «cuánto hice la última vez en X» o «cómo voy en X»: devuelve las últimas sesiones de ese ejercicio con sus series, el mejor 1RM estimado y la tendencia.",
  scope: "mcp:read",
  readOnly: true,
  input: GetExerciseHistoryInput.extend({ limit: z.number().int().min(1).max(20).default(8).describe("Máximo de sesiones. Por defecto, 8") }),
  handler: async (ctx, args) => {
    const h = await getExerciseHistory(ctx.userId, args);
    return {
      exercise: { id: h.exercise.id, name: h.exercise.name },
      best: h.best ? { e1rm: r1(h.best.e1rm), date: h.best.date } : null,
      trend: h.trend,
      sessions: h.sessions.map((s) => lean({ date: s.date, workoutId: s.workoutId, sets: s.sets.map(setText).join(", "), e1rm: n1(s.e1rm), confidence: s.confidence,
        gear: [s.kneeSleeves && "rodilleras", s.belt && "cinturón"].filter(Boolean).join(", ") || null })),
    };
  },
});

const searchExercisesTool = defineTool({
  name: "search_exercises",
  title: "Buscar ejercicios",
  description: "Úsala para encontrar el id de un ejercicio por nombre, alias o grupo muscular (por ejemplo antes de cambiarlo o cuando log_set devuelve candidatos): devuelve nombre, id, músculo, material y carga de tobillo.",
  scope: "mcp:read",
  readOnly: true,
  input: SearchExercisesInput.extend({ limit: limitField(50) }),
  handler: async (ctx, args) => {
    const list = await searchExercises(ctx.userId, args);
    return { total: list.length, exercises: list.map(compactExercise) };
  },
});

const findAlternativesTool = defineTool({
  name: "find_exercise_alternatives",
  title: "Alternativas a un ejercicio",
  description: "Úsala cuando una máquina está ocupada o el tobillo molesta: devuelve ejercicios del mismo músculo y patrón, de menor a mayor coste de fatiga. Con `ankleSafe` solo los que no cargan el tobillo.",
  scope: "mcp:read",
  readOnly: true,
  input: FindAlternativesInput.extend({
    exerciseId: Uuid.optional().describe("Id del ejercicio a sustituir. Si no lo tienes, usa `exercise`"),
    exercise: z.string().trim().min(1).max(120).optional().describe("Nombre del ejercicio tal como lo dice el atleta"),
  }),
  handler: async (ctx, { exercise, exerciseId, ...rest }) => {
    if (!exerciseId && !exercise) throw invalid("Indica el ejercicio (id o nombre).");
    const ex = exerciseId ? { id: exerciseId } : await exerciseIdOf(ctx.userId, exercise!);
    const list = await findAlternatives(ctx.userId, { ...rest, exerciseId: ex.id });
    return { exerciseId: ex.id, alternatives: list.map((a) => ({ ...compactExercise(a), fatigueCost: a.fatigueCost })) };
  },
});

/* ───────────────────────── Registro ───────────────────────── */

const startWorkoutTool = defineTool({
  name: "start_workout",
  title: "Empezar la sesión",
  description: "Úsala cuando el atleta diga «empiezo» o «voy a entrenar»: abre la sesión que toca según el plan (o la que indiques, o una libre con `free`) y devuelve cada ejercicio con su carga, repeticiones y RIR de hoy. Si ya hay una abierta para esa sesión, devuelve esa.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: StartWorkoutInput.extend({ free: z.boolean().optional().describe("Verdadero para una sesión libre, fuera del plan") }),
  handler: async (ctx, { free, ...args }) => {
    let sessionTemplateId = args.sessionTemplateId;
    if (!sessionTemplateId && !free && !args.name) {
      const next = await getNextSession(ctx.userId, args.date);
      if (next.session && !next.session.isRest) sessionTemplateId = next.session.id;
    }
    const v = await startWorkout(ctx.userId, { ...args, sessionTemplateId });
    const first = v.next;
    return {
      summary: `Sesión abierta el ${v.workout.date}: ${v.workout.name ?? "Sesión libre"}, ${v.exercises.length} ejercicios.${first ? ` Primera serie: ${nextText(first)}.` : ""}`,
      warnings: viewWarnings(v),
      ...compactView(v),
    };
  },
});

const logSetTool = defineTool({
  name: "log_set",
  title: "Registrar una serie",
  description: "Úsala cada vez que el atleta diga una serie («press banca 100 por 8, RIR 2» → exercise, kg, reps, rir): la guarda en la sesión en curso (o abre una) y devuelve la serie, si es récord y la siguiente serie con su descanso. Si el nombre encaja con varios ejercicios no guarda nada y devuelve los candidatos: pregunta cuál y repite con su id.",
  scope: "mcp:log",
  readOnly: false,
  input: LogSetInput,
  handler: async (ctx, args) => {
    const r = await logSet(ctx.userId, args);
    if (!r.ok) {
      const p = r.problems[0];
      throw new AppError("ambiguo", `${p?.message ?? "No he podido guardar la serie."} ${AMBIGUOUS_HINT}`, {
        candidates: r.problems.flatMap((x) => x.candidates ?? []).map((c) => ({ id: c.id, name: c.name })),
        instruccion: "pregunta cuál y repite con su id",
      });
    }
    const warnings = [...r.warnings];
    // Avisos del ejercicio en la sesión: tobillo y series basura (más de 10 efectivas del mismo grupo como principal).
    const view = await getWorkoutView(ctx.userId, r.workoutId).catch(() => null);
    const block = view?.exercises.find((b) => b.exercise.id === r.exercise.id);
    if (block?.ankleWarning && block.workingSetsDone <= 1) warnings.push(block.ankleWarning.message);
    const muscle = block?.exercise.primaryMuscle;
    if (view && muscle && !r.duplicate) {
      const hard = view.exercises.filter((b) => b.exercise.primaryMuscle === muscle).flatMap((b) => b.sets.filter(isWorking).map(asLog)).filter(isHardSet).length;
      if (hard > SESSION_CAP) warnings.push(`Series basura: llevas ${hard} series efectivas de ${muscle} en esta sesión. A partir de ${SESSION_CAP} la curva se aplana.`);
    }
    const s = r.set;
    const done = `${r.exercise.name}, serie ${block?.workingSetsDone ?? s.setIndex}: ${num(s.kg ?? 0)} kg × ${s.reps}${s.rir != null ? `, RIR ${num(s.rir)}` : ""}`;
    return {
      summary: `${r.duplicate ? "Ya estaba guardada" : "Guardado"}: ${done}.${r.pr ? ` Récord: ${num(r.pr.e1rm)} kg de 1RM estimado (antes ${num(r.pr.previous)}).` : ""}` +
        `${r.next ? ` Siguiente: ${nextText(r.next)}.` : " No quedan series pendientes: cierra la sesión con finish_workout."}`,
      workoutId: r.workoutId, exercise: { id: r.exercise.id, name: r.exercise.name }, set: compactSet(s), duplicate: r.duplicate,
      isPr: r.isPr, pr: r.pr ? { e1rm: r1(r.pr.e1rm), previous: r1(r.pr.previous) } : null,
      next: r.next, totals: { sets: r.totals.sets, hardSets: r.totals.hardSets, tonnage: r1(r.totals.tonnage) }, warnings,
    };
  },
});

const updateSetTool = defineTool({
  name: "update_set",
  title: "Corregir una serie",
  description: "Úsala cuando el atleta corrija una serie ya guardada («eran 9, no 8»): cambia solo lo que envíes y devuelve la serie corregida. El id de la serie lo dan log_set y get_workout.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: UpdateSetInput,
  handler: async (ctx, args) => {
    const s = await updateSet(ctx.userId, args);
    return { summary: `Serie corregida: ${num(s.kg ?? 0)} kg × ${s.reps}${s.rir != null ? `, RIR ${num(s.rir)}` : ""}.`, workoutId: s.workoutId, set: compactSet(s) };
  },
});

const deleteSetTool = defineTool({
  name: "delete_set",
  title: "Borrar una serie",
  description: "Úsala solo cuando el atleta pida quitar una serie guardada por error: la borra sin posibilidad de recuperarla. Confirma antes cuál es.",
  scope: "mcp:log",
  readOnly: false,
  destructive: true,
  input: DeleteSetInput,
  handler: async (ctx, args) => {
    const r = await deleteSet(ctx.userId, args);
    return { summary: "Serie borrada.", workoutId: r.workoutId, deleted: true };
  },
});

const addExerciseTool = defineTool({
  name: "add_exercise_to_workout",
  title: "Añadir un ejercicio a la sesión",
  description: "Úsala cuando el atleta quiera hacer un ejercicio que no estaba en la sesión: lo añade al final y devuelve su objetivo de hoy. Con un nombre ambiguo devuelve candidatos sin añadir nada.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: AddExerciseToWorkoutInput,
  handler: async (ctx, args) => {
    const v = await addExerciseToWorkout(ctx.userId, args);
    const b = v.exercises[v.exercises.length - 1];
    return { summary: `Añadido a la sesión: ${b?.exercise.name ?? args.exercise}.`, warnings: b?.ankleWarning ? [b.ankleWarning.message] : [], exercise: b ? compactBlock(b) : null, exercises: v.exercises.map((x) => x.exercise.name) };
  },
});

const swapExerciseTool = defineTool({
  name: "swap_exercise",
  title: "Cambiar un ejercicio",
  description: "Úsala para sustituir un ejercicio de la sesión por otro solo hoy (máquina ocupada, tobillo): conserva la pauta de series, rango y RIR, y devuelve el objetivo del nuevo. No vale si ya hay series del que se quita.",
  scope: "mcp:log",
  readOnly: false,
  input: SwapExerciseInput,
  handler: async (ctx, args) => {
    const v = await swapExercise(ctx.userId, args);
    const b = v.exercises.find((x) => x.exercise.id === args.toExerciseId);
    return { summary: `Cambiado solo en esta sesión: ${b?.replaces?.name ?? "el ejercicio"} por ${b?.exercise.name ?? "el nuevo"}.`, warnings: b?.ankleWarning ? [b.ankleWarning.message] : [], exercise: b ? compactBlock(b) : null };
  },
});

const finishWorkoutTool = defineTool({
  name: "finish_workout",
  title: "Cerrar la sesión",
  description: "Úsala cuando el atleta diga «he terminado»: necesita su esfuerzo percibido de 0 a 10 (pregúntalo si no lo ha dicho). Cierra la sesión y devuelve carga, series efectivas, tonelaje, récords y los avisos del motor (estancamientos, series basura).",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: FinishWorkoutInput.extend({ workoutId: Uuid.optional().describe("Id de la sesión. Sin él, la sesión en curso") }),
  handler: async (ctx, args) => {
    let workoutId = args.workoutId;
    if (!workoutId) {
      const open = (await listWorkouts(ctx.userId, { limit: 10 })).find((w) => w.status === "en_curso");
      if (!open) throw new AppError("no_encontrado", "No hay ninguna sesión en curso que cerrar.");
      workoutId = open.id;
    }
    const s = await finishWorkout(ctx.userId, { ...args, workoutId });
    const w = s.workout;
    return {
      summary: `Sesión cerrada: ${w.name ?? "sesión"} del ${w.date}, ${w.durationMin ?? "?"} min, esfuerzo ${num(w.srpe ?? 0)}/10 (carga ${Math.round(s.load)}). ` +
        `${s.hardSets} series efectivas, ${Math.round(s.tonnage).toLocaleString("es-ES")} kg movidos${s.prs.length ? `, ${s.prs.length} ${s.prs.length === 1 ? "récord" : "récords"}` : ""}.`,
      workoutId: w.id, load: Math.round(s.load), hardSets: s.hardSets, tonnage: r1(s.tonnage),
      setsByMuscle: Object.fromEntries(Object.entries(s.setsByMuscle).map(([m, n]) => [m, r1(n)])),
      prs: s.prs.map((p) => `${p.name}: ${num(p.e1rm)} kg de 1RM estimado (antes ${num(p.previous)})`),
      warnings: s.annotations.filter((a) => a.severity !== "info").map((a) => `${a.title}. ${a.body ?? ""}`.trim()),
      notes: s.annotations.filter((a) => a.severity === "info" && a.rule !== "pr").map((a) => a.title),
    };
  },
});

const logSorenessTool = defineTool({
  name: "log_soreness",
  title: "Apuntar agujetas",
  description: "Úsala cuando el atleta diga que tiene agujetas en algún grupo: guarda de 1 (nada) a 5 (no puedo moverlo) por grupo muscular (id del grupo: pectoral, cuadriceps, biceps…) y devuelve lo guardado.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: LogSorenessInput,
  handler: async (ctx, args) => {
    const r = await logSoreness(ctx.userId, args);
    return { summary: `Agujetas del ${r.date}: ${Object.entries(r.scores).map(([m, n]) => `${m} ${n}/5`).join(", ")}.`, ...r };
  },
});

/* ───────────────────────── Librería (cambia el plan) ───────────────────────── */

const createExerciseTool = defineTool({
  name: "create_exercise",
  title: "Crear un ejercicio",
  description: "Úsala cuando el atleta haga un ejercicio que no está en la librería (comprueba antes con search_exercises): lo crea como propio con su grupo muscular, tipo y material, y devuelve su id. Confirma los datos con el atleta antes.",
  scope: "mcp:plan",
  readOnly: false,
  input: CreateExerciseInput,
  handler: async (ctx, args) => {
    const e = await createExercise(ctx.userId, args);
    return { summary: `Ejercicio creado: ${e.name}${e.primaryMuscle ? ` (${e.primaryMuscle})` : ", sin grupo muscular"}.`, exercise: compactExercise(e) };
  },
});

const addAliasTool = defineTool({
  name: "add_exercise_alias",
  title: "Añadir un alias a un ejercicio",
  description: "Úsala cuando el atleta llame a un ejercicio de una forma que el sistema no reconoce («la katana» = extensión de tríceps katana): guarda ese nombre para que log_set lo entienda la próxima vez. Confirma antes a qué ejercicio se refiere.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: AddAliasInput,
  handler: async (ctx, args) => {
    const r = await addAlias(ctx.userId, args);
    return { summary: `«${args.alias}» ya vale como nombre de ${r.exercise.name}.`, exercise: compactExercise(r.exercise), cloned: r.cloned };
  },
});

export const trainingTools: AnyTool[] = [
  getWorkoutTool, listWorkoutsTool, getExerciseHistoryTool, searchExercisesTool, findAlternativesTool,
  startWorkoutTool, logSetTool, updateSetTool, deleteSetTool, addExerciseTool, swapExerciseTool, finishWorkoutTool, logSorenessTool,
  createExerciseTool, addAliasTool,
];
