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
};

export function instructionOverlayExists(name) {
  return typeof name === "string" && Object.hasOwn(OVERLAYS, name);
}

export function applyInstructionOverlay(text, name) {
  if (typeof text !== "string" || !name) return text;
  const overlay = OVERLAYS[name];
  return overlay ? `${text}\n\n${overlay}` : text;
}
