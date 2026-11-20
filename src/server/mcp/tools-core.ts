/** Herramientas base del servidor MCP: quién soy y cómo se usa esto. Las de dominio viven en sus propios ficheros. */
import { z } from "zod";
import { withUser } from "@/db/client";
import { notFound } from "@/server/errors";
import { DEFAULT_TZ, todayIn } from "@/server/time";
import { defineTool, type AnyTool } from "./registry";

export const SERVER_NAME = "sistema-fisico";
export const SERVER_VERSION = "0.1.0";

export const SERVER_GUIDE = `Sistema físico: entrenamiento y nutrición de un solo atleta. Todo lo que ves y escribes es suyo.

Flujo recomendado:
1. Empieza por get_today: dice la única cosa que toca ahora (nextAction), la sesión de hoy con sus cargas, la comida, los pasos y el tobillo.
2. Registra con la herramienta de lo que el atleta acaba de decir: log_set (series), log_food (comida), log_body_metrics (peso), log_checkin, log_steps, log_cardio, log_caffeine, log_pain. Una frase del atleta, una llamada.
3. Confirma leyéndole el \`summary\` que devuelve cada escritura y, si trae \`warnings\`, léelos también: no los resumas ni los suavices.

Reglas de uso:
1. Antes de escribir, confirma si hay ambigüedad. Si una herramienta devuelve candidatos (ejercicio, alimento, sesión), pregunta cuál y repite con su id; no elijas tú.
2. Nunca inventes calorías, macros, gramos ni cargas. Si falta un dato, pídelo o léelo con una herramienta. log_food falla a propósito si faltan gramos o macros.
3. El tobillo manda: si una herramienta devuelve un aviso de lesión, respétalo aunque el plan diga otra cosa (sin impacto, tope de carga, cambio de ejercicio).
4. Las cifras llevan fecha. Al citar un peso, una marca o un total, di de qué día es.
5. Las fechas van en AAAA-MM-DD, en la zona horaria del atleta (la devuelve whoami). Sin fecha, las herramientas usan hoy.
6. Solo ves las herramientas de los permisos que concedió el atleta: mcp:read lee, mcp:log registra, mcp:plan cambia el plan.
7. Las herramientas de mcp:plan cambian el plan (programa, descarga, volumen, objetivos de calorías, ficha, precios, ejercicios): confirma con el atleta antes de llamarlas, diciéndole qué va a cambiar.
8. Borrar (delete_set, delete_food_log) no se deshace: confirma antes cuál es.
9. Si una herramienta devuelve un error, no des la operación por hecha ni la repitas a ciegas: cuéntaselo al atleta.
10. Fotos y vídeos: por aquí no se suben ficheros. Se registra el enlace de Drive con register_photo y register_video.`;

const whoami = defineTool({
  name: "whoami",
  title: "Quién soy",
  description: "Devuelve el id del atleta de esta conexión, los permisos concedidos, su fecha local de hoy, su zona horaria y la versión del servidor. Llámala al empezar.",
  scope: "mcp:read",
  readOnly: true,
  input: z.object({}),
  handler: async (ctx) => {
    const rows = await withUser(ctx.userId, (tx) => tx.query<{ name: string | null; timezone: string | null }>("select name, timezone from fit.athletes where id = $1", [ctx.userId]));
    if (!rows[0]) throw notFound("El atleta");
    const timezone = rows[0].timezone || DEFAULT_TZ;
    return {
      athlete_id: ctx.userId,
      name: rows[0].name,
      client_id: ctx.clientId,
      scopes: ctx.scopes,
      today: todayIn(timezone),
      timezone,
      server: SERVER_NAME,
      version: SERVER_VERSION,
    };
  },
});

const serverGuide = defineTool({
  name: "server_guide",
  title: "Guía de uso",
  description: "Flujo recomendado (get_today, registrar, confirmar con el summary) y reglas de este servidor: cuándo preguntar, qué no inventar, el tobillo y las herramientas que cambian el plan. Léela una vez por conversación.",
  scope: "mcp:read",
  readOnly: true,
  input: z.object({}),
  handler: async () => SERVER_GUIDE,
});

export const coreTools: AnyTool[] = [whoami, serverGuide];
