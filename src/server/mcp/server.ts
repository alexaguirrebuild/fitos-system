/** El servidor MCP de una petición: se monta con el contexto del token y solo con las herramientas que sus scopes permiten. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type AnyTool, type ToolContext, type ToolHooks } from "./registry";
import { coreTools, SERVER_NAME, SERVER_VERSION } from "./tools-core";

/**
 * Todas las herramientas del servidor.
 * PUNTO DE EXTENSIÓN: las de dominio se añaden aquí, una lista por fichero de `src/server/mcp/`:
 *   import { trainingTools } from "./tools-training";
 *   export const allTools: AnyTool[] = [...coreTools, ...trainingTools, ...nutritionTools];
 * Cada herramienta se declara con defineTool() (ver registry.ts). Los nombres no se pueden repetir.
 */
export const allTools: AnyTool[] = [...coreTools];

export function buildMcpServer(ctx: ToolContext, tools: AnyTool[] = allTools, hooks: ToolHooks = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: "Entrenamiento y nutrición de un atleta. Empieza por whoami y server_guide. Confirma antes de escribir si hay ambigüedad y no inventes cifras." },
  );
  registerTools(server, ctx, tools, hooks);
  return server;
}
