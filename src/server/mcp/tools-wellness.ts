/** Herramientas de bienestar y ficha: check-in, POMS, medidas corporales, dolor y perfil del atleta. */
import { z } from "zod";
import {
  BodyMetricsInput, ListCheckinsInput, LogInjuryPainInput, SaveCheckinInput, SavePomsInput, UpdateAthleteInput,
  getOnboardingStatus, listCheckins, logBodyMetrics, logInjuryPain, saveCheckin, savePoms, updateAthlete,
  type AnkleStatus,
} from "@/server/services";
import { readinessBand } from "@/engine";
import { defineTool, type AnyTool } from "./registry";
import { lean, limitField, num, r1 } from "./tools-insight";

/** Lo que el agente debe decir del tobillo cuando la regla restringe. */
const ankleWarnings = (a: AnkleStatus | null): string[] => (a?.rule.restricted ? a.rule.notes : []);

const getCheckinsTool = defineTool({
  name: "get_checkins",
  title: "Check-ins recientes",
  description: "Úsala para «cómo he dormido esta semana» o para ver la recuperación de los últimos días: devuelve los check-ins (readiness, sueño, estrés, ganas, dolor, fatiga, tobillo) del más reciente al más antiguo y la media de readiness.",
  scope: "mcp:read",
  readOnly: true,
  input: ListCheckinsInput.extend({
    days: z.number().int().min(1).max(365).default(14).describe("Cuántos días hacia atrás, contando el último. Por defecto, 14"),
    limit: limitField(60),
  }),
  handler: async (ctx, { limit, ...args }) => {
    const list = await listCheckins(ctx.userId, args);
    const scored = list.filter((c) => c.readiness != null);
    return {
      total: list.length, truncated: list.length > limit,
      readinessAvg: scored.length ? r1(scored.reduce((a, c) => a + c.readiness!, 0) / scored.length) : null,
      checkins: list.slice(0, limit).map((c) => lean({
        date: c.date, readiness: c.readiness, band: c.readiness != null ? readinessBand(c.readiness).band : null, sleepQuality: c.sleepQuality,
        sleepHours: c.sleepHours, stress: c.stress, motivation: c.motivation, pain: c.pain, fatigue: c.fatigue, anklePain: c.anklePain, note: c.note,
      })),
    };
  },
});

const getOnboardingStatusTool = defineTool({
  name: "get_onboarding_status",
  title: "Qué falta en la ficha",
  description: "Úsala si get_today dice que la ficha está incompleta: devuelve qué datos faltan, con la pregunta exacta que hay que hacerle al atleta y por qué importa cada uno, las preguntas opcionales (lesión o molestia) y las de la ficha de ingreso que aún no ha contestado (intakeMissing).",
  scope: "mcp:read",
  readOnly: true,
  input: z.object({}),
  handler: async (ctx) => getOnboardingStatus(ctx.userId),
});

const logBodyMetricsTool = defineTool({
  name: "log_body_metrics",
  title: "Registrar peso y medidas",
  description: "Úsala cuando el atleta diga su peso («hoy 79,4») o una medida (cintura, cuello, brazo…): guarda solo lo que envíes en el día indicado y devuelve el % graso estimado si la altura está confirmada. Si trae un % graso medido (InBody, DEXA…) con bfPct y bfMethod, se guarda tal cual y no se recalcula por perímetros; también acepta masa muscular esquelética, antebrazo y ancho de hombros.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: BodyMetricsInput,
  handler: async (ctx, args) => {
    const m = await logBodyMetrics(ctx.userId, args);
    const parts = [
      args.weightKg != null && `${num(args.weightKg)} kg`, args.waistCm != null && `cintura ${num(args.waistCm)} cm`, args.neckCm != null && `cuello ${num(args.neckCm)} cm`,
      args.hipCm != null && `cadera ${num(args.hipCm)} cm`, args.chestCm != null && `pecho ${num(args.chestCm)} cm`, args.armCm != null && `brazo ${num(args.armCm)} cm`,
      args.thighCm != null && `muslo ${num(args.thighCm)} cm`, args.calfCm != null && `gemelo ${num(args.calfCm)} cm`,
      args.forearmCm != null && `antebrazo ${num(args.forearmCm)} cm`, args.shoulderWidthCm != null && `hombros ${num(args.shoulderWidthCm)} cm`,
      args.skeletalMuscleKg != null && `músculo esquelético ${num(args.skeletalMuscleKg)} kg`, args.bfPct != null && `% graso medido ${num(args.bfPct)}${args.bfMethod ? ` (${args.bfMethod})` : ""}`, args.skinfolds && "pliegues", args.note && "nota",
    ].filter(Boolean);
    return {
      summary: `Guardado el ${m.date}: ${parts.join(", ")}.${m.bfPct != null ? ` Grasa estimada: ${num(m.bfPct)} %${m.bfMarginPts != null ? ` (± ${num(m.bfMarginPts)})` : ""}.` : ""}`,
      date: m.date, weightKg: m.weightKg, waistCm: m.waistCm, bfPct: m.bfPct, bfMethod: m.bfMethod, skeletalMuscleKg: m.skeletalMuscleKg, leanKg: m.leanKg != null ? r1(m.leanKg) : null,
      warnings: m.warnings,
    };
  },
});

const logCheckinTool = defineTool({
  name: "log_checkin",
  title: "Hacer el check-in",
  description: "Úsala por la mañana o antes de entrenar: necesita sueño, estrés, ganas, dolor y fatiga (de 1 a 10; pregunta los que falten, no los inventes). Calcula el readiness, devuelve qué tipo de sesión toca hoy y la regla del tobillo si se indica su dolor.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: SaveCheckinInput,
  handler: async (ctx, args) => {
    const c = await saveCheckin(ctx.userId, args);
    return {
      summary: `Check-in del ${c.date} guardado: readiness ${c.readiness}. ${c.label}`,
      date: c.date, readiness: c.readiness, band: c.band, label: c.label, baseline: c.baseline,
      ankle: lean({ pain: c.ankle.pain, restricted: c.ankle.rule.restricted, squatCapPct: c.ankle.rule.squatCapPct }),
      warnings: ankleWarnings(c.ankle),
    };
  },
});

const savePomsTool = defineTool({
  name: "save_poms",
  title: "Guardar el test POMS",
  description: "Úsala solo cuando el atleta haya contestado las 52 preguntas del test de estado de ánimo (de 0 a 4, en orden): calcula las escalas, la alteración total y la forma del perfil, y devuelve su lectura.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: SavePomsInput,
  handler: async (ctx, args) => {
    const p = await savePoms(ctx.userId, args);
    return {
      summary: `POMS del ${p.date} guardado: alteración total ${p.tmd}. ${p.reading}`,
      date: p.date, tmd: p.tmd, shape: p.shape, scales: { tension: p.tension, depression: p.depression, anger: p.anger, vigor: p.vigor, fatigue: p.fatigue },
    };
  },
});

const logPainTool = defineTool({
  name: "log_pain",
  title: "Apuntar un dolor",
  description: "Úsala cuando el atleta diga que le duele una zona («me duele el tobillo 5» → zone: tobillo, pain: 5): lo apunta en su lesión (la crea si no existe) y, si es el tobillo, devuelve la regla de hoy: qué se limita y qué se cambia.",
  scope: "mcp:log",
  readOnly: false,
  idempotent: true,
  input: LogInjuryPainInput,
  handler: async (ctx, args) => {
    const r = await logInjuryPain(ctx.userId, args);
    return {
      summary: `Dolor de ${r.zone} ${r.pain}/10 apuntado el ${r.date}${r.created ? " (lesión nueva abierta)" : ""}.` +
        `${r.ankle ? (r.ankle.rule.restricted ? " El tobillo manda: sin impacto y tope del 75 % en sentadilla." : " Sin restricción por el tobillo.") : ""}`,
      zone: r.zone, date: r.date, pain: r.pain, moment: r.moment,
      ankle: r.ankle ? lean({ restricted: r.ankle.rule.restricted, impactAllowed: r.ankle.rule.impactAllowed, squatCapPct: r.ankle.rule.squatCapPct,
        dropTopSet: r.ankle.rule.dropTopSet, z2Modes: r.ankle.rule.z2Modes, swaps: r.ankle.rule.restricted ? r.ankle.rule.swaps : null }) : null,
      warnings: ankleWarnings(r.ankle),
    };
  },
});

const FIELD_LABEL: Record<string, string> = {
  name: "nombre", sex: "sexo", birthDate: "fecha de nacimiento", heightCm: "altura", heightConfirmed: "altura confirmada", timezone: "zona horaria",
  bedtime: "hora de acostarse", wakeTime: "hora de levantarse", hrRest: "pulso en reposo", adhd: "TDAH", adhdMedication: "medicación TDAH",
  goalWeightKg: "peso objetivo", goalWaistCm: "cintura objetivo", stepsGoal: "pasos objetivo", stepsOffExtra: "pasos extra en descanso",
  weeklyFoodBudgetEur: "presupuesto semanal de comida", stores: "tiendas",
};

const updateProfileTool = defineTool({
  name: "update_profile",
  title: "Cambiar la ficha del atleta",
  description: "Cambia el plan: actualiza datos de la ficha (altura, fecha de nacimiento, peso objetivo, hora de acostarse, pasos objetivo, presupuesto, tiendas…). De ellos salen calorías, zonas y corte de cafeína, así que confirma cada dato con el atleta antes. Devuelve lo que ha cambiado.",
  scope: "mcp:plan",
  readOnly: false,
  idempotent: true,
  input: UpdateAthleteInput,
  handler: async (ctx, args) => {
    const changed = Object.entries(args).filter(([, v]) => v !== undefined);
    const a = await updateAthlete(ctx.userId, args);
    return {
      summary: changed.length ? `Ficha actualizada: ${changed.map(([k, v]) => `${FIELD_LABEL[k] ?? k} = ${Array.isArray(v) ? v.join(", ") : v === null ? "sin dato" : v === true ? "sí" : v === false ? "no" : v}`).join("; ")}.` : "No has enviado ningún cambio.",
      profile: lean({ name: a.name, sex: a.sex, birthDate: a.birthDate, heightCm: a.heightCm, heightConfirmed: a.heightConfirmed, timezone: a.timezone, bedtime: a.bedtime,
        wakeTime: a.wakeTime, hrRest: a.hrRest, adhdMedication: a.adhdMedication, goalWeightKg: a.goalWeightKg, goalWaistCm: a.goalWaistCm, stepsGoal: a.stepsGoal,
        stepsOffExtra: a.stepsOffExtra, weeklyFoodBudgetEur: a.weeklyFoodBudgetEur, stores: a.stores }),
      warnings: a.heightConfirmed ? [] : ["Altura sin confirmar: no se calculan el gasto ni el % graso."],
    };
  },
});

export const wellnessTools: AnyTool[] = [getCheckinsTool, getOnboardingStatusTool, logBodyMetricsTool, logCheckinTool, savePomsTool, logPainTool, updateProfileTool];
