// Codex connects app connectors (Outlook, GitHub, Notion, ...) through its
// `codex_apps` MCP server and presents each one to the model as its own
// namespace: `mcp__codex_apps__github`, holding `fetch_issue`, `list_issues`,
// and the rest.
//
// Those namespaces use deferred loading. On a routed request the client ships
// only a handful of the tools inline and leaves `type: "tool_search"` as the
// way to reach the others. `flattenNamespaceTools` drops the search control --
// it has to, chat-completions providers reject the type outright -- so on a
// routed model the deferred remainder is simply unreachable. A live capture
// here sent one GitHub tool out of the 89 the connector actually exposes.
//
// `mergeCodexAppTools` already solves the same problem for `codex_app`, the
// app's own runtime, by merging a captured snapshot back in. Connectors cannot
// use a snapshot: which ones exist is per-account and changes whenever the
// operator connects one. They do not need it either, because Codex maintains
// the full set on disk at `$CODEX_HOME/cache/codex_apps_tools/<hash>.json` and
// refreshes it as connectors change. This module reads that cache and fills
// the deferred remainder back into the request.
//
// Merging is opt-in per connector because the schemas are big -- 649 KB, about
// 166k tokens, for all 171 tools on the capture machine. That size is why
// Codex defers them in the first place, so the operator names the connectors
// worth the context and the rest stay deferred exactly as they are today.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CODEX_HOME } from "./paths.mjs";

export const CONNECTOR_TOOL_CACHE_DIR =
  process.env.MODEL_ROUTER_CODEX_APPS_CACHE_DIR ||
  path.join(CODEX_HOME, "cache", "codex_apps_tools");

// The client prefixes every MCP server namespace with `mcp__`, so the cache's
// `codex_apps__github` is `mcp__codex_apps__github` in a request.
const CLIENT_NAMESPACE_PREFIX = "mcp__";
export const CONNECTOR_SERVER = "codex_apps";

// `<connector>.<method>` is the MCP tool name; the namespace child is the
// method alone. Splitting on the first dot keeps a method containing one from
// losing its tail.
function methodName(toolName, connector) {
  if (typeof toolName !== "string") return undefined;
  const prefix = `${connector}.`;
  if (toolName.startsWith(prefix)) return toolName.slice(prefix.length) || undefined;
  const dot = toolName.indexOf(".");
  return dot === -1 ? toolName : toolName.slice(dot + 1) || undefined;
}

// Codex writes one cache file per connector set and leaves older ones behind
// when the set changes, so the newest file is the live one.
function newestCacheFile(dir) {
  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  let newest;
  for (const name of entries) {
    const full = path.join(dir, name);
    let mtime;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
  }
  return newest?.path;
}

// Reads the cache into `namespace -> { name, description, tools: Map }`, keyed
// by the namespace name a request carries. Returns an empty Map when the cache
// is absent or unreadable: no connectors merged is exactly today's behavior,
// which is the right thing to fall back to.
export function readConnectorToolCatalog(dir = CONNECTOR_TOOL_CACHE_DIR) {
  const catalog = new Map();
  if (!dir || !existsSync(dir)) return catalog;
  const file = newestCacheFile(dir);
  if (!file) return catalog;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return catalog;
  }
  const entries = Array.isArray(parsed?.tools) ? parsed.tools : [];
  for (const entry of entries) {
    if (entry?.server_name && entry.server_name !== CONNECTOR_SERVER) continue;
    const toolNamespace = entry?.tool_namespace;
    const tool = entry?.tool;
    if (typeof toolNamespace !== "string" || !tool?.name) continue;
    const connector = toolNamespace.slice(toolNamespace.lastIndexOf("__") + 2);
    const name = methodName(tool.name, connector);
    if (!connector || !name) continue;
    const namespace = `${CLIENT_NAMESPACE_PREFIX}${toolNamespace}`;
    if (!catalog.has(namespace)) {
      catalog.set(namespace, {
        name: namespace,
        connector,
        connectorName: entry.connector_name || connector,
        description: entry.namespace_description || "",
        tools: new Map(),
      });
    }
    const bucket = catalog.get(namespace);
    if (bucket.tools.has(name)) continue;
    bucket.tools.set(name, {
      type: "function",
      name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    });
  }
  return catalog;
}

// The cache is ~1.4 MB where every connector is connected, so it is parsed
// once and re-read only when Codex rewrites it (a connector added or removed).
let cached;

export function connectorToolCatalog(dir = CONNECTOR_TOOL_CACHE_DIR) {
  const file = existsSync(dir) ? newestCacheFile(dir) : undefined;
  let mtime;
  if (file) {
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      mtime = undefined;
    }
  }
  if (cached && cached.dir === dir && cached.file === file && cached.mtime === mtime) {
    return cached.catalog;
  }
  const catalog = readConnectorToolCatalog(dir);
  cached = { dir, file, mtime, catalog };
  return catalog;
}

export function resetConnectorToolCatalogCache() {
  cached = undefined;
}

// Accepts either the namespace name (`mcp__codex_apps__github`) or the bare
// connector (`github`), because the second is what an operator types.
function selectedNamespaces(catalog, enabled) {
  const wanted = new Set();
  if (!enabled) return wanted;
  const names = enabled instanceof Set ? [...enabled] : enabled;
  if (!Array.isArray(names)) return wanted;
  for (const raw of names) {
    if (typeof raw !== "string" || !raw) continue;
    if (catalog.has(raw)) {
      wanted.add(raw);
      continue;
    }
    for (const [namespace, bucket] of catalog) {
      if (bucket.connector === raw) wanted.add(namespace);
    }
  }
  return wanted;
}

// Fill the deferred remainder of each selected connector back into `tools`.
// Client-provided definitions win, so a tool the client did ship keeps the
// client's exact schema; the cache only supplies what deferred loading held
// back. A selected connector the client omitted entirely is appended whole --
// the client still dispatches those calls natively, the same reasoning
// `mergeCodexAppTools` relies on.
export function mergeConnectorTools(tools, { catalog, enabled } = {}) {
  if (!Array.isArray(tools) || !(catalog instanceof Map) || catalog.size === 0) {
    return { tools, merged: false };
  }
  const wanted = selectedNamespaces(catalog, enabled);
  if (wanted.size === 0) return { tools, merged: false };
  const merged = [];
  const seen = new Set();
  let changed = false;
  for (const tool of tools) {
    if (tool?.type !== "namespace" || !wanted.has(tool.name)) {
      merged.push(tool);
      continue;
    }
    const bucket = catalog.get(tool.name);
    const clientTools = [];
    const present = new Set();
    for (const fn of Array.isArray(tool.tools) ? tool.tools : []) {
      if (!fn?.name) continue;
      clientTools.push(fn);
      present.add(fn.name);
    }
    const missing = [...bucket.tools.values()].filter((fn) => !present.has(fn.name));
    if (missing.length) {
      clientTools.push(...missing);
      changed = true;
    }
    merged.push({ ...tool, tools: clientTools });
    seen.add(tool.name);
  }
  for (const namespace of wanted) {
    if (seen.has(namespace)) continue;
    const bucket = catalog.get(namespace);
    if (!bucket || bucket.tools.size === 0) continue;
    merged.push({
      type: "namespace",
      name: namespace,
      description: bucket.description || `Tools provided by ${bucket.connectorName}.`,
      tools: [...bucket.tools.values()],
    });
    changed = true;
  }
  return changed ? { tools: merged, merged: true } : { tools, merged: false };
}
