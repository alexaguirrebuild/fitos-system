/** Herramientas del plan: programa activo, siguiente sesión, descarga y volumen objetivo. Las de `mcp:plan` cambian el plan. */
import { z } from "zod";
import { AppError } from "@/server/errors";
import { todayIn } from "@/server/time";
import {
  ActivateProgramInput, DateInput, IsoDate, SetDeloadInput, SetVolumeTargetInput, Uuid,
  activateProgram, getActivePlan, getAthlete, getNextSession, listProgramTemplates, setDeload, setVolumeTarget,
  type PrescriptionView, type SessionTemplate,
} from "@/server/services";
import { defineTool, type AnyTool } from "./registry";
import { lean, rxText } from "./tools-insight";

const rxLine = (p: PrescriptionView) => lean({
  exerciseId: p.exerciseId, name: p.exercise.name, rx: rxText(p), restSeconds: p.restSeconds, technique: p.technique,
  capPct: p.loadCapPct, notes: p.notes,
});
const sessionLine = (s: SessionTemplate, withRx: boolean) => lean({
  id: s.id, position: s.position, name: s.name, focus: s.focus, kind: s.isRest ? "descanso" : s.isCardio ? "cardio" : "pesas", plannedMinutes: s.plannedMinutes,
  exercises: withRx ? s.prescriptions.map((p) => `${p.exercise.name} ${rxText(p)}`) : null,
});

const getPlanTool = defineTool({
  name: "get_plan",
  title: "Plan activo",
  description: "Úsala para «qué programa llevo» o «en qué semana estoy»: devuelve el macrociclo activo, el mesociclo, el microciclo (n de m, con su id y si es de descarga) y la rueda de sesiones con la pauta de cada ejercicio.",
  scope: "mcp:read",
  readOnly: true,
  input: DateInput,
  handler: async (ctx, args) => {
    const p = await getActivePlan(ctx.userId, args);
    if (!p) return { active: false, message: "No hay ningún programa activo. Mira list_program_templates y propón activar uno." };
    return {
      active: true,
      macrocycle: lean({ id: p.macrocycle.id, name: p.macrocycle.name, goal: p.macrocycle.goal, startDate: p.macrocycle.startDate, endDate: p.macrocycle.endDate,
        startWeightKg: p.macrocycle.startWeightKg, targetWeightKg: p.macrocycle.targetWeightKg }),
      mesocycle: { name: p.mesocycle.name, blockType: p.mesocycle.blockType, focus: p.mesocycle.focus, position: p.mesocycle.position, of: p.mesocycles.length },
      microcycle: { id: p.microcycle.id, position: p.microcycle.position, of: p.microcycles.length, startDate: p.microcycle.startDate, endDate: p.microcycle.endDate,
        lengthDays: p.microcycle.lengthDays, isDeload: p.microcycle.isDeload },
      beyondEnd: p.beyondEnd,
      sessions: p.sessions.map((s) => sessionLine(s, true)),
    };
  },
});

const getNextSessionTool = defineTool({
  name: "get_next_session",
  title: "Siguiente sesión",
  description: "Úsala para «qué sesión me toca»: devuelve la siguiente sesión de la rueda (o la que ya está en curso), por qué es esa, la última hecha y la pauta de cada ejercicio. Para las cargas sugeridas de hoy usa get_today o start_workout.",
  scope: "mcp:read",
  readOnly: true,
  input: DateInput,
  handler: async (ctx, args) => {
    const n = await getNextSession(ctx.userId, args);
    return {
      date: n.date, reason: n.reason, workoutId: n.workoutId,
      session: n.session ? { ...sessionLine(n.session, false), exercises: n.session.prescriptions.map(rxLine) } : null,
      lastDone: n.lastDone ? { name: n.lastDone.name, date: n.lastDone.date } : null,
      restBetween: n.restBetween, isDeload: n.isDeload,
      microcycle: n.microcycle ? { id: n.microcycle.id, position: n.microcycle.position, day: n.dayOfMicrocycle, done: n.doneInMicrocycle, planned: n.plannedInMicrocycle } : null,
    };
  },
});

const listProgramTemplatesTool = defineTool({
  name: "list_program_templates",
  title: "Programas disponibles",
  description: "Úsala antes de activar un programa: devuelve las plantillas disponibles con su slug, objetivo, semanas y sesiones de cada mesociclo.",
  scope: "mcp:read",
  readOnly: true,
  input: z.object({}),
  handler: async () => {
    const { templates, invalid } = listProgramTemplates();
    return {
      templates: templates.map((t) => ({ slug: t.slug, name: t.name, goal: t.goal, weeks: t.weeks,
        mesocycles: t.mesocycles.map((m) => `${m.name} (${m.blockType}, ${m.microcyclesPlanned} × ${m.microcycleDays} días): ${m.sessions.join(", ")}`) })),
      invalid: invalid.map((i) => i.file),
    };
  },
});

const activateProgramTool = defineTool({
  name: "activate_program",
  title: "Activar un programa",
  description: "Cambia el plan: cierra el programa activo y empieza otro desde la fecha indicada (hoy por defecto). Úsala solo cuando el atleta lo haya confirmado de forma explícita. Devuelve el plan nuevo y su primera sesión.",
  scope: "mcp:plan",
  readOnly: false,
  destructive: true,
  input: ActivateProgramInput.extend({ startDate: IsoDate.optional().describe("Primer día del programa (AAAA-MM-DD). Por defecto, hoy") }),
  handler: async (ctx, args) => {
    const startDate = args.startDate ?? todayIn((await getAthlete(ctx.userId)).timezone);
    const p = await activateProgram(ctx.userId, { ...args, startDate });
    const first = p.sessions.find((s) => !s.isRest);
    return {
      summary: `Programa activado: ${p.macrocycle.name}, del ${p.macrocycle.startDate} al ${p.macrocycle.endDate ?? "?"}. Primera sesión: ${first?.name ?? "sin sesiones"}.`,
      macrocycleId: p.macrocycle.id, microcycleId: p.microcycle.id, sessions: p.sessions.map((s) => sessionLine(s, false)),
    };
  },
});

const setDeloadTool = defineTool({
  name: "set_deload",
  title: "Marcar o quitar la descarga",
  description: "Cambia el plan: marca el microciclo actual (o el indicado) como semana de descarga, o la quita con isDeload=false. Úsala cuando el atleta diga «pásame a descarga» y lo confirme; mira antes get_load_status para decirle si las señales lo apoyan.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: SetDeloadInput.extend({
    microcycleId: Uuid.optional().describe("Id del microciclo. Sin él, el microciclo en curso"),
    isDeload: z.boolean().default(true).describe("Verdadero para marcarlo como descarga (por defecto); falso para quitarla"),
  }),
  handler: async (ctx, args) => {
    let microcycleId = args.microcycleId;
    if (!microcycleId) {
      const plan = await getActivePlan(ctx.userId);
      if (!plan) throw new AppError("no_encontrado", "No hay programa activo: no hay microciclo que marcar.");
      microcycleId = plan.microcycle.id;
    }
    const m = await setDeload(ctx.userId, { microcycleId, isDeload: args.isDeload });
    return {
      summary: m.isDeload
        ? `Microciclo ${m.position} (${m.startDate} a ${m.endDate}) marcado como descarga: 40 % menos de series, misma carga, 2 más en reserva.`
        : `Descarga quitada del microciclo ${m.position} (${m.startDate} a ${m.endDate}).`,
      microcycleId: m.id, isDeload: m.isDeload,
    };
  },
});

const setVolumeTargetTool = defineTool({
  name: "set_volume_target",
  title: "Cambiar el volumen objetivo de un grupo",
  description: "Cambia el plan: fija el mínimo y el máximo de series efectivas semanales de un grupo muscular (y su prioridad). Úsala solo tras confirmarlo con el atleta; get_volume_status da los valores actuales.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: SetVolumeTargetInput,
  handler: async (ctx, args) => {
    const m = await setVolumeTarget(ctx.userId, args);
    return { summary: `${m.name}: de ${m.mev} a ${m.mrv} series efectivas por semana${m.priority != null ? `, prioridad ${m.priority}` : ""} (antes, por defecto: ${m.defaultMev}-${m.defaultMrv}).`,
      muscleId: m.id, mev: m.mev, mrv: m.mrv, priority: m.priority };
  },
});

export const planTools: AnyTool[] = [getPlanTool, getNextSessionTool, listProgramTemplatesTool, activateProgramTool, setDeloadTool, setVolumeTargetTool];
