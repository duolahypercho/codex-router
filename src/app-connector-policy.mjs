// This controls provider-facing declarations, never client execution rights.
export function appConnectorPolicy(environment = process.env) {
  const raw = environment.CODEX_ROUTER_APP_CONNECTORS;
  const eager = new Set();
  if (typeof raw !== "string") return { withhold: false, eager };
  let stated = false;
  let disabled = false;
  for (const entry of raw.split(",")) {
    const id = entry.trim().toLowerCase();
    if (!id) continue;
    stated = true;
    if (id === "all") disabled = true;
    else if (id !== "none") eager.add(id);
  }
  return { withhold: stated && !disabled, eager };
}

// Persist only canonical public identifiers, so the setting cannot inject
// shell commands, CMD expansion or extra environment lines into a launcher.
export function serviceAppConnectorEnvironment(environment = process.env) {
  const raw = environment.CODEX_ROUTER_APP_CONNECTORS;
  if (typeof raw !== "string" || !raw.trim()) return {};
  const entries = raw.split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.some(id => !/^[a-z0-9_-]+$/.test(id))) {
    throw new Error("CODEX_ROUTER_APP_CONNECTORS must contain comma-separated connector identifiers, none, or all.");
  }
  const policy = appConnectorPolicy(environment);
  return {
    CODEX_ROUTER_APP_CONNECTORS: !policy.withhold
      ? "all"
      : policy.eager.size > 0 ? [...policy.eager].join(",") : "none",
  };
}
