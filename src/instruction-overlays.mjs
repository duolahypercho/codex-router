function englishList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function grokFileToolsOverlay(includeWrite) {
  return grokFileToolsOverlayFor(new Set([
    "read_file",
    "grep",
    "list_dir",
    "search_replace",
    "run_terminal_command",
    ...(includeWrite ? ["write"] : []),
  ]));
}

export function grokFileToolsOverlayFor(installed) {
  const names = installed instanceof Set ? installed : new Set();
  const readers = ["read_file", "grep", "list_dir"].filter((name) => names.has(name));
  const hasSearch = names.has("search_replace");
  const hasWrite = names.has("write");
  const hasRun = names.has("run_terminal_command");
  if (!hasSearch && !hasWrite && readers.length === 0 && !hasRun) return "";
  const lines = ["## Workspace files"];
  const lead = [];
  if (readers.length) lead.push(`Read local files with ${englishList(readers)}.`);
  if (hasSearch) lead.push("Edit existing files with search_replace.");
  if (hasWrite) lead.push("Create files with write.");
  if (lead.length) lines.push(`- ${lead.join(" ")}`);
  if (hasSearch) {
    lines.push(`- Existing files: search_replace hunks, not whole-file rewrites${hasWrite ? "; write is create-only" : ""}.`);
  }
  if (hasRun) {
    lines.push("- run_terminal_command is only for processes such as git, tests, and installs. Do not read or write workspace files through the shell.");
  }
  lines.push("- Do not dump minified node_modules or package dist to understand a local adapter. Read the workspace adapter and its tests first.");
  return lines.join("\n");
}

export function applyGrokFileToolsOverlay(text, installed) {
  const overlay = grokFileToolsOverlayFor(installed);
  if (!overlay || typeof text !== "string") return text;
  return `${text}\n\n${overlay}`;
}

const GROK_FILE_TOOLS_OVERLAY = grokFileToolsOverlay(false);
const GROK_FILE_TOOLS_WRITE_OVERLAY = grokFileToolsOverlay(true);

const OVERLAYS = {
  "efficient-agentic": `## Routed execution discipline
- Continue through routine tool work without narrating each routine tool step. Send commentary only for material findings, blockers, or meaningful milestones.
- If an optional helper command is unavailable and a safe built-in alternative exists, switch silently and continue. Treat the substitution as routine; do not send a progress message merely to announce the fallback.
- Batch independent reads and checks when the available tool surface supports it. With direct function tools, issue independent calls in the same assistant turn when possible. Do not invent helper tools; use only tools exposed in the current turn.
- Request the minimum sufficient tool output so long sessions do not accumulate avoidable history. Before reading a file not already known to be small, inspect its byte or line count. Treat anything over 32 KiB or 400 lines as a large file; prefer targeted search or bounded sections over a broad dump; do not request the whole file first and recover from truncation afterward.
- Defer mutable or reference research for future implementation stages until immediately before the stage that will consume it. Do not front-load CI, deployment, provider, or dependency research while an earlier implementation area is still unresolved.
- Before running infrastructure, setup, or status commands that may print credentials, capture their output and emit only explicitly safe fields. Keep secrets, tokens, passwords, private keys, and credential-bearing connection strings out of tool output and shell history.
- For an unfamiliar CLI or test API, inspect installed help, function signatures, or authoritative documentation before iterating on guessed syntax; use failures to diagnose the implementation rather than as an API-discovery loop.
- Before authoring a fixture for an unfamiliar contract, inspect the canonical schema and type definitions or reuse a known-good fixture; do not invent a plausible shape from memory.
- Once a behavioral RED suite has been started, keep that implementation area active until the RED suite is green or a concrete blocker is recorded. Do not switch implementation areas merely because one subcase passes.
- If runtime evidence contradicts the current debugging hypothesis, invalidate that hypothesis and re-trace the production call path before changing the fixture or patching another symptom. After two failed hypotheses on the same assertion, re-read the production call path before attempting another fix.
- On Windows, avoid fragile nested PowerShell, SQL, and JSON quoting in one command. Prefer structured arguments, here-strings, or a temporary script/file for complex payloads, and check optional paths before reading them.
- After a tool result, continue execution unless it materially changes the plan or requires user input.
- Lead the final response with the outcome and verification rather than a chronological process recap.`,
  "filesystem-mcp-discipline": `## Local files and MCP resources
- Treat ordinary local filesystem paths as files, never as MCP resource URIs. Use an available filesystem or shell tool, such as exec_command, to inspect local files.
- Call read_mcp_resource only with a server name and URI returned by MCP resource or resource-template discovery in the current session. Never invent an MCP server name such as file.
- If an MCP read reports an unknown server or invalid URI, do not repeat the same invalid call for other local paths. Return to the available filesystem tools. Keep using read_mcp_resource for valid resources returned by MCP discovery.`,
  "grok-file-tools": GROK_FILE_TOOLS_OVERLAY,
  "grok-file-tools-write": GROK_FILE_TOOLS_WRITE_OVERLAY,
};

export function instructionOverlayExists(name) {
  return typeof name === "string" && Object.hasOwn(OVERLAYS, name);
}

export function applyInstructionOverlay(text, name) {
  if (typeof text !== "string" || !name) return text;
  const overlay = OVERLAYS[name];
  return overlay ? `${text}\n\n${overlay}` : text;
}
