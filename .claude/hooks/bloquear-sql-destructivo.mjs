// PreToolUse: freno de errores obvios, no una frontera de seguridad. Bloquea SQL destructivo que un agente lance
// por Bash/PowerShell o por las herramientas SQL de un MCP: DROP de objetos, TRUNCATE, DELETE/UPDATE sin WHERE
// y el reseteo de la base con la CLI de Supabase. Salir con 2 = bloquear; el texto de stderr le llega al agente.
// No ve el SQL que va dentro de un fichero (`psql -f`, migraciones): eso pasa por revisión (docs/coding-standards.md).
// Si la entrada no es JSON, deja pasar: bloquearlo todo dejaría la sesión sin shell.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const t = input?.tool_input ?? {};
  const text = [t.command, t.query, t.sql].filter((x) => typeof x === "string").join("\n");
  // Buscar texto o escribir un commit que menciona SQL no es ejecutarlo.
  // Solo si es un comando suelto: con «&&», «;», «|» o «$(» detrás podría ir cualquier cosa.
  const search = /^\s*(grep|rg|git\s+(commit|log|show|diff|grep))\b/.test(t.command ?? "");
  if (typeof t.command === "string" && search && !/&&|\|\||;|\||\$\(|`/.test(t.command)) process.exit(0);

  // Cada sentencia DELETE/UPDATE, hasta el siguiente «;» o el final: si no lleva WHERE, es a toda la tabla.
  const withoutWhere = (verb) =>
    [...text.matchAll(new RegExp(`\\b${verb}\\b[\\s\\S]*?(?=;|$(?![\\s\\S]))`, "gi"))].some((m) => !/\bwhere\b/i.test(m[0]));

  const rules = [
    [/\bdrop\s+(table|schema|database|view|materialized\s+view|function|policy|role|trigger|index|type|extension|sequence|domain|owned)\b/i, "DROP"],
    [/\balter\s+table\b[\s\S]*?\bdrop\s+(column|constraint)\b/i, "ALTER TABLE … DROP"],
    // TRUNCATE [TABLE] [ONLY] tabla seguido de fin, coma, «;» o CASCADE/RESTART: así «truncate de texto» no salta.
    [/\btruncate\s+(table\s+)?(only\s+)?("?\w+"?\.)?"?\w+"?\s*(,|;|$|\)|\b(cascade|restrict|restart|continue)\b)/im, "TRUNCATE"],
    [/\bsupabase\s+db\s+reset\b/i, "supabase db reset"],
  ];
  let hit = rules.find(([re]) => re.test(text))?.[1];
  if (!hit && /\bdelete\s+from\b/i.test(text) && withoutWhere("delete\\s+from")) hit = "DELETE sin WHERE";
  if (!hit && /\bupdate\s+["\w.]+(\s+\w+)?\s+set\b/i.test(text) && withoutWhere("update\\s+[\"\\w.]+(?:\\s+\\w+)?\\s+set")) hit = "UPDATE sin WHERE";
  if (!hit) process.exit(0);
  process.stderr.write(
    `Bloqueado por .claude/hooks/bloquear-sql-destructivo.mjs: ${hit}. ` +
      "En FITOS ningún agente borra esquema ni datos. Si hace falta, explícale a Alex qué y por qué, y que lo ejecute él.\n",
  );
  process.exit(2);
});
