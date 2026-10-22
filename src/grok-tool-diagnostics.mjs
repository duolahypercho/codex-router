import { createHash } from "node:crypto";

// A fixed vocabulary, not a dump of the caller's tools. Names, descriptions,
// schemas, argument values and custom namespaces can all contain private data.
const PARAMETERS = new Set([
  "cmd", "command", "workdir", "working_directory", "shell", "login", "tty",
  "yield_time_ms", "max_output_tokens", "sandbox_permissions", "justification", "prefix_rule",
  "query", "limit", "session_id", "chars", "input", "operations", "path", "old_string", "new_string", "contents",
]);
const NAMES = new Set([
  "exec_command", "write_stdin", "shell_command", "apply_patch", "apply_patch_structured_v1", "replace_lines",
  "search_replace", "write", "run_terminal_command", "exec", "tool_search",
]);

const APP_NAMES = new Set(["list_projects", "create_thread", "automation_update"]);
const APP_NAMESPACES = new Set(["codex_app", "mcp__codex_app"]);

function diagnosticName(tool, namespace) {
  if (tool.type === "tool_search" && namespace === undefined && tool.namespace === undefined) {
    return "tool_search";
  }
  if (!["function", "custom"].includes(tool.type)) return undefined;
  let name = tool.name ?? tool.function?.name;
  if (typeof name !== "string") return undefined;
  if (namespace !== undefined && tool.namespace !== undefined && namespace !== tool.namespace) return undefined;
  const owner = namespace ?? tool.namespace;
  if (owner === undefined) {
    // Match only complete, fixed identities. Connector namespaces and arbitrary
    // client functions must never turn into diagnostic labels.
    for (const app of APP_NAMESPACES) {
      for (const fn of APP_NAMES) if (name === `${app}__${fn}`) return name;
    }
    if (name.startsWith("functions__")) name = name.slice("functions__".length);
  } else if (APP_NAMESPACES.has(owner)) {
    return APP_NAMES.has(name) ? `${owner}__${name}` : undefined;
  } else if (owner !== "functions") return undefined;
  return NAMES.has(name) ? name : undefined;
}

export function grokToolDiagnostics(tools) {
  let count = 0;
  const known = {};
  function visit(tool, namespace, namespaceDeferred = false) {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "namespace") {
      // Responses namespace declarations have one level; never traverse an
      // arbitrary nested object or reflect an untrusted namespace into logs.
      if (namespace !== undefined) return;
      for (const child of Array.isArray(tool.tools) ? tool.tools : []) visit(child, tool.name, tool.defer_loading === true);
      return;
    }
    count++;
    const name = diagnosticName(tool, namespace);
    if (!name) return;
    const entry = known[name] ??= { count: 0, declarations: [] };
    entry.count++;
    if (entry.declarations.length >= 4) return;
    const schema = tool.parameters ?? tool.function?.parameters ?? tool.inputSchema ?? tool.format;
    const properties = schema?.properties;
    entry.declarations.push({
      type: tool.type,
      ...(tool.type === "tool_search" && ["client", "server"].includes(tool.execution)
        ? { execution: tool.execution } : {}),
      deferred: namespaceDeferred || tool.defer_loading === true,
      ...(schema && typeof schema === "object" ? {
        schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
      } : {}),
      parameters: Object.keys(properties && typeof properties === "object" ? properties : {})
        .filter(key => PARAMETERS.has(key)).sort(),
    });
  }
  for (const tool of Array.isArray(tools) ? tools : []) visit(tool);
  return { count, known };
}
