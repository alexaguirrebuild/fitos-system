/** Herramientas base del servidor MCP: quién soy y cómo se usa esto. Las de dominio viven en sus propios ficheros. */
import { z } from "zod";
import { withUser } from "@/db/client";
import { notFound } from "@/server/errors";
import { DEFAULT_TZ, todayIn } from "@/server/time";
import { defineTool, type AnyTool } from "./registry";

export const SERVER_NAME = "sistema-fisico";
export const SERVER_VERSION = "0.1.0";

export const SERVER_GUIDE = `Sistema físico: entrenamiento y nutrición de un solo atleta. Todo lo que ves y escribes es suyo.

Reglas de uso:
1. Antes de escribir, confirma si hay ambigüedad. Si una herramienta devuelve candidatos (ejercicio, alimento, sesión), pregunta cuál; no elijas tú.
2. Nunca inventes calorías, macros ni cargas. Si falta un dato, pídelo o léelo con una herramienta.
3. Los avisos de tobillo mandan: si una herramienta devuelve un aviso de lesión, respétalo aunque el plan diga otra cosa.
4. Toda cifra lleva su fecha. Al citar un peso, una marca o un total, di de qué día es.
5. Las fechas van en AAAA-MM-DD, en la zona horaria del atleta (la devuelve whoami).
6. Solo ves las herramientas de los permisos que concedió el atleta: mcp:read lee, mcp:log registra, mcp:plan cambia el plan.
7. Si una herramienta devuelve un error, no des la operación por hecha ni la repitas a ciegas: cuéntaselo al atleta.`;

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
  description: "Reglas cortas para usar este servidor: cuándo confirmar antes de escribir, qué no inventar y cómo citar cifras. Léela una vez por conversación.",
  scope: "mcp:read",
  readOnly: true,
  input: z.object({}),
  handler: async () => SERVER_GUIDE,
});

export const coreTools: AnyTool[] = [whoami, serverGuide];
