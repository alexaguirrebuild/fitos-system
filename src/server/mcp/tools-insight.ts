/**
 * Herramientas de visión general: «Hoy», progreso, carga, volumen, anotaciones, glosario, vídeos y fotos.
 * Aquí viven también los ayudantes de formato que comparten los demás ficheros de herramientas:
 * todo lo que sale hacia el modelo va recortado (≤ 20 elementos) y redondeado.
 */
import { z } from "zod";
import { AppError, invalid } from "@/server/errors";
import type { SetLog } from "@/engine";
import {
  AddAnnotationInput, DismissAnnotationInput, GearPatternsInput, GetGlossaryInput, GetProgressInput, GetTodayInput, GetVolumeStatusInput,
  ListAnnotationsInput, ListVideosInput, RegisterPhotoInput, RegisterVideoInput,
  addAnnotation, dismissAnnotation, gearPatterns, getGlossary, getLoadStatus, getProgress, getToday, getVolumeStatus, listAnnotations, listVideos,
  registerPhoto, registerVideo, resolveExercise, DateInput,
  type TodayExercise, type TodayView,
} from "@/server/services";
import { defineTool, type AnyTool } from "./registry";

/* ───────────────────────── Formato común ───────────────────────── */

export const DEFAULT_LIMIT = 20;
export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r0 = (n: number) => Math.round(n);
export const n1 = (n: number | null | undefined) => (n == null ? null : r1(n));
/** Número en español: coma decimal y como mucho un decimal. */
export const num = (n: number) => String(r1(n)).replace(".", ",");
/** «80×5 (RIR 2)». */
export const setText = (s: SetLog) => `${num(s.kg)}×${s.reps}${s.rir != null ? ` (RIR ${num(s.rir)})` : ""}`;
/** «4×4-6 RIR 2». */
export const rxText = (p: { sets: number; repMin: number | null; repMax: number | null; rirTarget: number | null }) =>
  `${p.sets}×${p.repMin ?? "?"}${p.repMax != null && p.repMax !== p.repMin ? `-${p.repMax}` : ""}${p.rirTarget != null ? ` RIR ${num(p.rirTarget)}` : ""}`;
/** Recorta una lista y dice cuántos había. */
export function cut<T>(list: T[], limit: number = DEFAULT_LIMIT): { items: T[]; total: number; truncated: boolean } {
  return { items: list.slice(0, limit), total: list.length, truncated: list.length > limit };
}
export const limitField = (max = 50) => z.number().int().min(1).max(max).default(DEFAULT_LIMIT).describe(`Máximo de elementos devueltos. Por defecto, ${DEFAULT_LIMIT}`);
/** Quita las claves vacías (null, undefined, listas vacías) para no gastar contexto del modelo. */
export function lean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))) as Partial<T>;
}
export const macrosText = (m: { kcal: number; proteinG: number; carbsG: number; fatG: number }) =>
  `${r0(m.kcal)} kcal, ${r0(m.proteinG)} g de proteína, ${r0(m.carbsG)} g de hidratos, ${r0(m.fatG)} g de grasa`;
export const roundMacros = (m: { kcal: number; proteinG: number; carbsG: number; fatG: number } | null) =>
  m ? { kcal: r0(m.kcal), proteinG: r0(m.proteinG), carbsG: r0(m.carbsG), fatG: r0(m.fatG) } : null;
export const AMBIGUOUS_HINT = "Pregunta cuál y repite con su id.";

/** Id o nombre de ejercicio → id. Con varios candidatos, error «ambiguo» con la lista: no se elige por el atleta. */
export async function exerciseIdOf(userId: string, ref: string): Promise<{ id: string; name: string }> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return { id: ref, name: ref };
  const r = await resolveExercise(userId, ref);
  if (r.match) return { id: r.match.id, name: r.match.name };
  if (!r.candidates.length) throw new AppError("no_encontrado", `No conozco el ejercicio «${ref}». Búscalo con search_exercises.`);
  throw new AppError("ambiguo", `«${ref}» puede ser más de un ejercicio. ${AMBIGUOUS_HINT}`, { candidates: r.candidates.map((c) => ({ id: c.id, name: c.name })) });
}

/* ───────────────────────── Hoy ───────────────────────── */

const todayExercise = (e: TodayExercise) => lean({
  id: e.exerciseId, name: e.name, rx: e.sets ? rxText(e) : null,
  kg: e.suggestion?.kg ?? null, reps: e.suggestion?.repsTarget ?? null, rir: e.suggestion?.rirTarget ?? null,
  rule: e.suggestion?.rule ?? null, why: e.suggestion?.why ?? null,
  last: e.lastSession ? `${e.lastSession.date}: ${e.lastSession.sets.map(setText).join(", ")}` : null,
  capKg: e.loadCap?.kg ?? null, ankleWarning: e.ankleWarning, setsDone: e.setsDone || null, done: e.done || null,
});

export function compactToday(t: TodayView) {
  const tr = t.training;
  return {
    date: t.date, weekday: t.weekday,
    nextAction: t.nextAction,
    athlete: { name: t.athlete.name, onboardingComplete: t.athlete.onboardingComplete, missing: t.athlete.missing.map((m) => m.question) },
    checkin: t.checkin, needsCheckin: t.needsCheckin,
    ankle: t.ankle ? lean({ pain: t.ankle.pain, painDate: t.ankle.painDate, restricted: t.ankle.restricted, impactAllowed: t.ankle.impactAllowed,
      squatCapPct: t.ankle.squatCapPct, notes: t.ankle.restricted ? t.ankle.notes : [] }) : null,
    training: tr ? {
      plan: tr.plan ? {
        macrocycle: tr.plan.macrocycle.name, goal: tr.plan.macrocycle.goal, mesocycle: tr.plan.mesocycle.name,
        microcycle: `${tr.plan.microcycle.position} de ${tr.plan.microcycle.of}`, microcycleId: tr.plan.microcycle.id,
        day: `${tr.plan.microcycle.day} de ${tr.plan.microcycle.lengthDays}`, isDeload: tr.isDeload,
        sessions: `${tr.plan.microcycle.sessionsDone} de ${tr.plan.microcycle.sessionsPlanned} hechas`,
        wheel: tr.plan.sessions.map((s) => `${s.name}${s.doneOn ? " ✓" : ""}`),
      } : null,
      todayKind: tr.todayKind, trainedToday: tr.trainedToday,
      next: tr.next ? {
        sessionTemplateId: tr.next.sessionTemplateId, name: tr.next.name, focus: tr.next.focus, reason: tr.next.reason, isCardio: tr.next.isCardio,
        lastDone: tr.next.lastDone ? `${tr.next.lastDone.name} el ${tr.next.lastDone.date}` : null,
        exercises: tr.next.exercises.slice(0, DEFAULT_LIMIT).map(todayExercise),
      } : null,
      inProgress: tr.inProgress ? {
        workoutId: tr.inProgress.workoutId, name: tr.inProgress.name, date: tr.inProgress.date, setsDone: tr.inProgress.setsDone,
        exercises: `${tr.inProgress.exercisesDone} de ${tr.inProgress.exercisesTotal}`, next: tr.inProgress.next,
      } : null,
      doneToday: tr.doneToday.map((d) => lean({ workoutId: d.workoutId, name: d.name, hardSets: d.hardSets, tonnage: n1(d.tonnage), srpe: d.srpe })),
    } : null,
    nutrition: t.nutrition ? {
      dayType: t.nutrition.dayType, dayTypeAssumed: t.nutrition.dayTypeAssumed, phase: t.nutrition.phase, target: roundMacros(t.nutrition.target),
      totals: roundMacros(t.nutrition.totals), remaining: roundMacros(t.nutrition.remaining), proteinPct: t.nutrition.proteinPct,
      items: t.nutrition.items, caffeine: t.nutrition.caffeine,
    } : null,
    activity: t.activity,
    load: t.load ? {
      acwr: { ratio: t.load.acwr.ratio, zone: t.load.acwr.zone, reliable: t.load.acwr.reliable, label: t.load.acwr.label },
      maxWeeklyStress: n1(t.load.stress.max), topStress: t.load.stress.top.map((m) => `${m.name}: ${num(m.value)} (${m.band})`),
      deload: lean(t.load.deload),
    } : null,
    weight: t.weight,
    annotations: t.annotations.map((a) => lean({ id: a.id, date: a.date, severity: a.severity, title: a.title })),
  };
}

const getTodayTool = defineTool({
  name: "get_today",
  title: "Qué toca hoy",
  description: "Úsala la primera, y siempre que pregunten «qué toca hoy» o «cómo voy»: devuelve en una llamada la única acción pendiente (nextAction), el check-in, el tobillo, la sesión que toca con la carga sugerida de cada ejercicio, la comida, los pasos, la carga y el peso del día.",
  scope: "mcp:read",
  readOnly: true,
  input: GetTodayInput,
  handler: async (ctx, args) => compactToday(await getToday(ctx.userId, args)),
});

/* ───────────────────────── Progreso, carga y volumen ───────────────────────── */

const getProgressTool = defineTool({
  name: "get_progress",
  title: "Progreso",
  description: "Úsala para «cómo voy de peso» o «estoy más fuerte»: devuelve la tendencia de peso y cintura, el 1RM estimado de los 6 ejercicios más entrenados, las sesiones por semana y la adherencia al plan en la ventana pedida (90 días por defecto).",
  scope: "mcp:read",
  readOnly: true,
  input: GetProgressInput,
  handler: async (ctx, args) => {
    const p = await getProgress(ctx.userId, args);
    const w = p.weight.series;
    const acwr = p.acwr[p.acwr.length - 1];
    return {
      from: p.from, to: p.to,
      weight: {
        weighIns: w.length, firstDate: w[0]?.date ?? null, lastDate: w[w.length - 1]?.date ?? null, lastKg: w[w.length - 1]?.kg ?? null,
        trendKg: p.weight.current, changeKg: p.weight.change, weeklyRatePct: p.weight.weeklyRatePct,
        recent: w.slice(-7).map((x) => `${x.date}: ${num(x.kg)} kg`),
      },
      waist: { lastCm: p.waist.series[p.waist.series.length - 1]?.cm ?? null, lastDate: p.waist.series[p.waist.series.length - 1]?.date ?? null, changeCm: p.waist.change },
      lifts: p.lifts.map((l) => {
        const first = l.series[0], last = l.series[l.series.length - 1];
        return lean({ exerciseId: l.exerciseId, name: l.name, sessions: l.sessions, firstE1rm: n1(first?.e1rm), firstDate: first?.date ?? null,
          lastE1rm: n1(last?.e1rm), lastDate: last?.date ?? null, lastSet: last ? setText(last) : null, changePct: l.changePct });
      }),
      acwr: acwr ? { date: acwr.date, acute: acwr.acute, chronic: acwr.chronic, ratio: acwr.ratio } : null,
      sessionsPerWeek: p.sessionsPerWeek.slice(-8).map((s) => `${s.weekStart}: ${s.done}`),
      adherence: p.adherence,
    };
  },
});

const getLoadStatusTool = defineTool({
  name: "get_load_status",
  title: "Carga y descarga",
  description: "Úsala para «¿estoy cargado?» o «¿me toca descarga?»: devuelve el ratio de carga aguda/crónica (con `reliable` falso si faltan días), el estrés semanal por grupo muscular y la decisión de descarga con sus señales.",
  scope: "mcp:read",
  readOnly: true,
  input: DateInput,
  handler: async (ctx, args) => {
    const l = await getLoadStatus(ctx.userId, args);
    return {
      date: l.date,
      acwr: { acute: r0(l.acwr.acute), chronic: r0(l.acwr.chronic), ratio: l.acwr.ratio, zone: l.acwr.zone, days: l.acwr.days, reliable: l.acwr.reliable, label: l.acwr.label },
      muscleStress: l.muscleStress.slice(0, 10).map((m) => ({ muscle: m.name, value: r1(m.value), band: m.band, sets: m.sets })),
      deload: l.deload,
      signals: {
        e1rmDropping: l.signals.e1rmDropping.map((e) => `${e.name}: ${e.e1rm.map(num).join(" → ")} kg`),
        readiness7dAvg: l.signals.readiness7dAvg, examPeriod: l.signals.examPeriod,
      },
    };
  },
});

const getVolumeStatusTool = defineTool({
  name: "get_volume_status",
  title: "Volumen por grupo muscular",
  description: "Úsala para «¿hago suficiente de X?»: devuelve las series efectivas por grupo muscular del microciclo actual (o del periodo pedido) frente a su mínimo y máximo semanales, con el consejo del motor para cada grupo.",
  scope: "mcp:read",
  readOnly: true,
  input: GetVolumeStatusInput,
  handler: async (ctx, args) => {
    const v = await getVolumeStatus(ctx.userId, args);
    return {
      from: v.from, to: v.to, days: v.days, microcycleId: v.microcycleId, unclassifiedSets: v.unclassifiedSets,
      muscles: v.muscles.slice(0, 30).map((m) => ({
        muscleId: m.muscleId, name: m.name, sets: m.sets, perWeek: r1(m.setsPerWeek), mev: m.mev, mrv: m.mrv, status: m.status,
        advice: `${m.advice.action}: ${m.advice.why}`,
      })),
    };
  },
});

/* ───────────────────────── Anotaciones y glosario ───────────────────────── */

const listAnnotationsTool = defineTool({
  name: "list_annotations",
  title: "Anotaciones",
  description: "Úsala para ver lo que el motor, el atleta o tú habéis dejado apuntado (récords, estancamientos, avisos de tobillo, notas): devuelve las anotaciones no descartadas de los últimos días, de la más reciente a la más antigua.",
  scope: "mcp:read",
  readOnly: true,
  input: ListAnnotationsInput.extend({ limit: limitField() }),
  handler: async (ctx, { limit, ...args }) => {
    const { items, total, truncated } = cut(await listAnnotations(ctx.userId, args), limit);
    return { total, truncated, annotations: items.map((a) => lean({ id: a.id, date: a.date, origin: a.origin, scope: a.scope, severity: a.severity, title: a.title, body: a.body, dismissed: a.dismissedAt ? true : null })) };
  },
});

const getGlossaryTool = defineTool({
  name: "get_glossary",
  title: "Glosario",
  description: "Úsala cuando haga falta explicar un término del método (RIR, MEV, myo-reps, descarga…): devuelve las definiciones que encajan con el texto o la categoría.",
  scope: "mcp:read",
  readOnly: true,
  input: GetGlossaryInput.extend({ limit: limitField().default(10).describe("Máximo de términos. Por defecto, 10") }),
  handler: async (ctx, { limit, ...args }) => {
    const { items, total, truncated } = cut(await getGlossary(ctx.userId, args), limit);
    return { total, truncated, terms: items.map((g) => lean({ term: g.term, category: g.category, definition: g.definition, notes: g.notes })) };
  },
});

const addNoteTool = defineTool({
  name: "add_note",
  title: "Apuntar una nota",
  description: "Úsala cuando el atleta diga algo que merece quedar apuntado y no tiene herramienta propia («hoy el hombro raro en press», «dormí en casa de mis padres»): guarda una anotación firmada como de Muse y devuelve su id.",
  scope: "mcp:log",
  readOnly: false,
  input: AddAnnotationInput.pick({ date: true, scope: true, title: true, body: true, severity: true }),
  handler: async (ctx, args) => {
    const a = await addAnnotation(ctx.userId, { ...args, origin: "muse" });
    return { summary: `Nota guardada el ${a.date} (${a.scope}): ${a.title}.`, id: a.id, date: a.date };
  },
});

const dismissAnnotationTool = defineTool({
  name: "dismiss_annotation",
  title: "Descartar una anotación",
  description: "Úsala cuando el atleta diga que un aviso ya está visto o no aplica: lo marca como descartado (deja de salir en «Hoy») y devuelve su título.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: DismissAnnotationInput,
  handler: async (ctx, args) => {
    const a = await dismissAnnotation(ctx.userId, args);
    return { summary: `Descartada: ${a.title}.`, id: a.id };
  },
});

/* ───────────────────────── Vídeos, fotos y material ───────────────────────── */

const listVideosTool = defineTool({
  name: "list_videos",
  title: "Vídeos de técnica",
  description: "Úsala para encontrar los vídeos grabados de un ejercicio: devuelve fecha, ejercicio, carga, material y el enlace de Drive de cada uno.",
  scope: "mcp:read",
  readOnly: true,
  input: ListVideosInput.extend({ limit: limitField(50) }),
  handler: async (ctx, args) => {
    const videos = await listVideos(ctx.userId, args);
    return {
      total: videos.length,
      videos: videos.map((v) => lean({
        id: v.id, date: v.recordedAt.slice(0, 10), exercise: v.exerciseName, set: v.kg != null && v.reps != null ? setText({ kg: v.kg, reps: v.reps, rir: v.rir }) : null,
        angle: v.angle, gear: [v.kneeSleeves && "rodilleras", v.belt && "cinturón", v.straps && "straps"].filter(Boolean).join(", ") || null,
        url: v.driveUrl, status: v.status, tags: v.tags, notes: v.techniqueNotes,
      })),
    };
  },
});

const getGearPatternsTool = defineTool({
  name: "get_gear_patterns",
  title: "Material y rendimiento",
  description: "Úsala para «¿rindo más con rodilleras, cinturón o cafeína?»: compara el mejor 1RM estimado por sesión de un ejercicio con y sin cada cosa. Con menos de 3 sesiones a cada lado no concluye nada, y lo dice.",
  scope: "mcp:read",
  readOnly: true,
  input: GearPatternsInput.extend({
    exerciseId: GearPatternsInput.shape.exerciseId.optional().describe("Id del ejercicio. Si no lo tienes, usa `exercise`"),
    exercise: z.string().trim().min(1).max(120).optional().describe("Nombre del ejercicio tal como lo dice el atleta"),
  }),
  handler: async (ctx, args) => {
    if (!args.exerciseId && !args.exercise) throw invalid("Indica el ejercicio (id o nombre).");
    const ex = args.exerciseId ? { id: args.exerciseId, name: null } : await exerciseIdOf(ctx.userId, args.exercise!);
    const g = await gearPatterns(ctx.userId, { exerciseId: ex.id });
    return {
      exerciseId: g.exerciseId, exercise: ex.name, sessions: g.sessions, enoughData: g.enoughData,
      comparisons: g.comparisons.map((c) => lean({ factor: c.factor, with: c.with, without: c.without, diffPct: c.diffPct, enoughData: c.enoughData, conclusion: c.conclusion })),
    };
  },
});

const registerVideoTool = defineTool({
  name: "register_video",
  title: "Registrar un vídeo",
  description: "Úsala cuando el atleta te pase el enlace de Drive de un vídeo de técnica: lo deja asociado a la serie, la sesión o el ejercicio. Por aquí no se sube el fichero, solo se registra el enlace. Devuelve el id del vídeo.",
  scope: "mcp:log",
  readOnly: false,
  input: RegisterVideoInput,
  handler: async (ctx, args) => {
    if (!args.driveUrl && !args.driveFileId) throw invalid("Falta el enlace de Drive (driveUrl) o el id del fichero (driveFileId). Por MCP no se sube el vídeo: solo se registra dónde está.", { falta: ["driveUrl"] });
    const v = await registerVideo(ctx.userId, args);
    return { summary: `Vídeo registrado${v.exerciseName ? ` de ${v.exerciseName}` : ""}${v.kg != null && v.reps != null ? ` (${setText({ kg: v.kg, reps: v.reps, rir: v.rir })})` : ""}.`, id: v.id, url: v.driveUrl };
  },
});

const registerPhotoTool = defineTool({
  name: "register_photo",
  title: "Registrar una foto de progreso",
  description: "Úsala cuando el atleta te pase el enlace de Drive de una foto de progreso: la deja registrada con su fecha y su pose. Por aquí no se sube el fichero, solo el enlace. Devuelve el id de la foto.",
  scope: "mcp:log",
  readOnly: false,
  input: RegisterPhotoInput,
  handler: async (ctx, args) => {
    if (!args.driveUrl && !args.driveFileId) throw invalid("Falta el enlace de Drive (driveUrl) o el id del fichero (driveFileId). Por MCP no se sube la foto: solo se registra dónde está.", { falta: ["driveUrl"] });
    const p = await registerPhoto(ctx.userId, args);
    return { summary: `Foto ${p.pose} del ${p.date} registrada.`, id: p.id, url: p.driveUrl };
  },
});

export const insightTools: AnyTool[] = [
  getTodayTool, getProgressTool, getLoadStatusTool, getVolumeStatusTool, listAnnotationsTool, getGlossaryTool, listVideosTool, getGearPatternsTool,
  addNoteTool, dismissAnnotationTool, registerVideoTool, registerPhotoTool,
];
