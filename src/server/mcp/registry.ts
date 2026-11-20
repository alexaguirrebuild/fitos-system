/**
 * Registro de herramientas MCP. Cada herramienta declara el scope que exige; al montar el servidor
 * de una petición solo se registran las que cubre el token (las demás ni se listan).
 * Los resultados salen como JSON compacto; un AppError llega al modelo como error legible, con sus
 * `details` (candidatos de ejercicio, etc.) para que pregunte en vez de adivinar.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError } from "@/server/errors";
import type { Scope } from "@/server/oauth";

export interface ToolContext {
  /** El atleta dueño del token. Los servicios lo usan con withUser(): RLS hace el resto. */
  userId: string;
  clientId: string;
  scopes: Scope[];
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  /** snake_case, único en todo el servidor. */
  name: string;
  title: string;
  /** Para el modelo: qué hace, cuándo usarla y qué devuelve. */
  description: string;
  scope: Scope;
  /** true: no cambia nada. false: escribe, y cada llamada queda en fit.audit_log. */
  readOnly: boolean;
  /** Borra o pisa datos que no se recuperan. Por defecto false. */
  destructive?: boolean;
  /** Repetir la llamada con los mismos argumentos no cambia el resultado. Por defecto, lo que valga `readOnly`. */
  idempotent?: boolean;
  input: S;
  handler: (ctx: ToolContext, args: z.output<S>) => Promise<unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lista heterogénea: cada herramienta tiene su esquema
export type AnyTool = ToolDef<any>;

/** Declara una herramienta con los argumentos del handler tipados desde su esquema. */
export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): AnyTool {
  return def;
}

export interface ToolHooks {
  /** Se llama tras cada escritura que salió bien (herramientas con `readOnly: false`). */
  audit?: (tool: string, args: unknown) => Promise<void>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Resultado de una herramienta: texto (JSON compacto) y, si es un objeto, también `structuredContent`. */
export function toolResult(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  return { content: [{ type: "text", text }], ...(isPlainObject(data) ? { structuredContent: data } : {}) };
}

/** AppError → mensaje en español y sus detalles. Cualquier otra cosa → mensaje genérico, sin traza. */
export function toolError(tool: string, error: unknown): CallToolResult {
  let body: Record<string, unknown>;
  if (error instanceof AppError) {
    body = { error: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) };
  } else if (error instanceof z.ZodError) {
    body = { error: "entrada_invalida", message: "Los argumentos no son válidos.", details: error.issues.map((i) => ({ campo: i.path.join("."), problema: i.message })) };
  } else {
    console.error(`[mcp] ${tool} falló:`, error instanceof Error ? error.message : "error desconocido");
    body = { error: "interno", message: "Error interno. No se ha completado la operación; no la des por hecha." };
  }
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

async function runTool(def: AnyTool, ctx: ToolContext, args: unknown, hooks: ToolHooks): Promise<CallToolResult> {
  let data: unknown;
  try {
    data = await def.handler(ctx, args);
  } catch (error) {
    return toolError(def.name, error);
  }
  if (!def.readOnly && hooks.audit) {
    // La escritura ya está hecha: si falla el apunte de auditoría no se devuelve error (el modelo reintentaría y duplicaría).
    await hooks.audit(def.name, args).catch((e) => console.error(`[mcp] auditoría de ${def.name}:`, e instanceof Error ? e.message : "error desconocido"));
  }
  return toolResult(data);
}

/** Registra en `server` las herramientas de `defs` que el token puede usar. Devuelve sus nombres. */
export function registerTools(server: McpServer, ctx: ToolContext, defs: AnyTool[], hooks: ToolHooks = {}): string[] {
  const names: string[] = [];
  for (const def of defs) {
    if (!ctx.scopes.includes(def.scope)) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input as z.ZodObject,
        annotations: {
          title: def.title,
          readOnlyHint: def.readOnly,
          destructiveHint: def.readOnly ? false : (def.destructive ?? false),
          idempotentHint: def.idempotent ?? def.readOnly,
          openWorldHint: false,
        },
      },
      (args: unknown) => runTool(def, ctx, args, hooks),
    );
    names.push(def.name);
  }
  return names;
}
