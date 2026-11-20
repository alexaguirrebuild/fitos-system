/** Herramientas de cardio y actividad diaria: semana de cardio, pasos y sueño. */
import { z } from "zod";
import { GetActivityInput, GetCardioWeekInput, LogCardioInput, LogStepsInput, getActivity, getAthlete, getCardioWeek, logCardio, logSteps } from "@/server/services";
import { stepsGoal } from "@/engine";
import { defineTool, type AnyTool } from "./registry";
import { cut, lean, num, r0 } from "./tools-insight";

const getCardioWeekTool = defineTool({
  name: "get_cardio_week",
  title: "Cardio de la semana",
  description: "Úsala para «cuánto cardio llevo»: devuelve las sesiones de la semana, los minutos por zona, lo que falta de zona 2 para el objetivo (150 min por defecto), el equilibrio con las pesas y las zonas de pulso del atleta.",
  scope: "mcp:read",
  readOnly: true,
  input: GetCardioWeekInput,
  handler: async (ctx, args) => {
    const w = await getCardioWeek(ctx.userId, args);
    const sessions = cut(w.sessions);
    return {
      weekStart: w.weekStart, weekEnd: w.weekEnd, sessionCount: w.sessionCount, minutesTotal: w.minutesTotal,
      z2: w.z2, minutesByZone: Object.fromEntries(Object.entries(w.minutesByZone).filter(([, m]) => m > 0)),
      ecosTotal: r0(w.ecosTotal), strength: w.strength,
      sessions: sessions.items.map((s) => lean({ id: s.id, date: s.date, mode: s.mode, minutes: s.minutes, avgHr: s.avgHr, zone: s.zone, distanceKm: s.distanceKm, impact: s.impact || null, note: s.note })),
      sessionsTruncated: sessions.truncated,
      hrZones: w.hrZones, warnings: w.warnings,
    };
  },
});

const getActivityTool = defineTool({
  name: "get_activity",
  title: "Pasos y sueño",
  description: "Úsala para «cuántos pasos llevo esta semana» o «cómo estoy durmiendo»: devuelve pasos, sueño, pulso en reposo y variabilidad de los últimos días (7 por defecto) con sus medias.",
  scope: "mcp:read",
  readOnly: true,
  input: GetActivityInput.extend({ days: z.number().int().min(1).max(90).default(7).describe("Cuántos días hacia atrás, contando hoy. Por defecto, 7") }),
  handler: async (ctx, args) => {
    const a = await getActivity(ctx.userId, args);
    const days = cut([...a.days].reverse());
    return {
      from: a.from, to: a.to, avg: a.avg,
      days: days.items.map((d) => lean({ date: d.date, steps: d.steps, sleepHours: d.sleepMinutes != null ? Math.round(d.sleepMinutes / 6) / 10 : null, sleepScore: d.sleepScore,
        restingHr: d.restingHr, hrvMs: d.hrvMs, activeKcal: d.activeKcal })),
      daysTruncated: days.truncated,
    };
  },
});

const logStepsTool = defineTool({
  name: "log_steps",
  title: "Apuntar los pasos",
  description: "Úsala cuando el atleta diga los pasos del día («llevo 8.400 pasos»): guarda el total del día (sustituye al anterior) y devuelve cuánto falta para el objetivo.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: LogStepsInput,
  handler: async (ctx, args) => {
    const d = await logSteps(ctx.userId, { ...args, source: args.source ?? "muse" });
    const a = await getAthlete(ctx.userId);
    // El objetivo exacto depende de si el día es On u Off; aquí se da el de día de entreno y el de descanso.
    const on = stepsGoal(true, a.stepsGoal, a.stepsOffExtra), off = stepsGoal(false, a.stepsGoal, a.stepsOffExtra);
    const steps = d.steps ?? args.steps;
    return {
      summary: `Pasos del ${d.date}: ${steps.toLocaleString("es-ES")}. Objetivo: ${on.toLocaleString("es-ES")} en día de entreno, ${off.toLocaleString("es-ES")} en descanso.`,
      date: d.date, steps, goalTrainingDay: on, goalRestDay: off,
    };
  },
});

const logCardioTool = defineTool({
  name: "log_cardio",
  title: "Registrar cardio",
  description: "Úsala cuando el atleta haga cardio («40 minutos de bici a 128 pulsaciones»): guarda modalidad, minutos y pulso, calcula la zona y la carga, y avisa si hace impacto (carrera, HIIT) con el tobillo por encima de 3.",
  scope: "mcp:log",
  readOnly: false,
  input: LogCardioInput,
  handler: async (ctx, args) => {
    const r = await logCardio(ctx.userId, { ...args, source: args.source ?? "muse" });
    const s = r.session;
    return {
      summary: `Cardio ${r.created ? "guardado" : "actualizado"} el ${s.date}: ${num(s.minutes)} min de ${s.mode.replace("_", " ")}${s.avgHr != null ? ` a ${s.avgHr} ppm` : ""}${s.zone != null ? `, zona ${s.zone}` : ""}.`,
      id: s.id, date: s.date, mode: s.mode, minutes: s.minutes, zone: s.zone, ecos: s.ecos, impact: s.impact, warnings: r.warnings,
    };
  },
});

export const cardioTools: AnyTool[] = [getCardioWeekTool, getActivityTool, logStepsTool, logCardioTool];
