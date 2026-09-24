import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  privateFileIsProtected,
  protectPrivateFile,
} from "./file-security.mjs";
import { subagentEffort } from "./multi-agent-state.mjs";
import { CODEX_AGENTS_DIR } from "./paths.mjs";

export function safeIdentifier(value, separator) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

// Only files matching this belong to the sync. Everything else in the agents
// directory is the user's own and is never read or removed here.
const MANAGED_AGENT_FILE = /^router-model-[a-z0-9-]+\.toml$/;

function managedAgentFiles(agentsDir) {
  try {
    return readdirSync(agentsDir).filter((entry) => MANAGED_AGENT_FILE.test(entry));
  } catch {
    return [];
  }
}

function writeManagedAgent(target, contents) {
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

// `effort` is the operator's per-model subagent depth (`subagentEffort`). Codex
// agent role files accept `model_reasoning_effort`, and without it a spawned
// child inherits the parent turn's effort -- a low-effort orchestrator would
// hand every worker low effort regardless of what the router was told.
export function routedAgentDefinition(model, { effort } = {}) {
  const slug = String(model?.slug || "").trim();
  if (!slug || !slug.includes("/")) {
    throw new Error(`Cannot create a routed agent for invalid model slug: ${slug || "<empty>"}`);
  }
  const fileStem = `router-model-${safeIdentifier(slug, "-")}`;
  const agentName = `router_${safeIdentifier(slug, "_")}`;
  const displayName = String(model.displayName || model.display_name || slug).trim();
  const reasoningEffort =
    typeof effort === "string" && effort.trim() ? effort.trim() : undefined;
  const contents = [
    "# Managed by Codex Router. Refresh the model catalog to update this file.",
    `name = ${tomlString(agentName)}`,
    `description = ${tomlString(`${displayName} agent routed through an authenticated Codex Router provider.`)}`,
    'model_provider = "codex-router"',
    `model = ${tomlString(slug)}`,
    ...(reasoningEffort ? [`model_reasoning_effort = ${tomlString(reasoningEffort)}`] : []),
    "",
    'developer_instructions = """',
    "Complete the bounded task assigned by the parent agent.",
    "Respect repository instructions, keep changes surgical, and run relevant verification.",
    "For inspection or review claims, cite the exact file and line. Before claiming that something is absent, search the relevant names and paths; before finishing, reopen every cited location and drop any claim that does not hold.",
    "Use only tool names, agent types, and model overrides offered by the current tool schema. Never invent or reuse a stale name; omit an optional override when no offered value fits.",
    "Do not stop after merely announcing a next action. Execute it when it is within scope, or report the exact blocker or decision needed.",
    "Return a concise summary of work completed, checks run, and remaining risks.",
    '"""',
    "",
  ].join("\n");
  return { agentName, fileName: `${fileStem}.toml`, contents };
}

// Writes one definition per model, and removes the definitions of models that
// are no longer passed in. Codex offers every file in the agents directory by
// name, so a definition left behind keeps a model spawnable through
// `agent_type` after the settings stopped allowing it.
export function syncRoutedCodexAgents(models, agentsDir = CODEX_AGENTS_DIR) {
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const previous = new Map(
    managedAgentFiles(agentsDir).map((entry) => [
      entry,
      readFileSync(path.join(agentsDir, entry), "utf8"),
    ]),
  );
  const written = [];
  const keep = new Set();
  try {
    for (const model of models) {
      const definition = routedAgentDefinition(model, {
        effort: subagentEffort(model.slug),
      });
      const target = path.join(agentsDir, definition.fileName);
      writeManagedAgent(target, definition.contents);
      keep.add(definition.fileName);
      written.push({ model: model.slug, agent: definition.agentName, path: target });
    }
    const removed = [];
    for (const entry of managedAgentFiles(agentsDir)) {
      if (keep.has(entry)) continue;
      try {
        unlinkSync(path.join(agentsDir, entry));
        removed.push(entry);
      } catch {
        // A definition that cannot be removed is reported by the doctor check
        // rather than failing the catalog write.
      }
    }
    return { written, removed };
  } catch (error) {
    const restoreErrors = [];
    for (const entry of managedAgentFiles(agentsDir)) {
      if (previous.has(entry)) continue;
      try {
        unlinkSync(path.join(agentsDir, entry));
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    for (const [entry, contents] of previous) {
      try {
        writeManagedAgent(path.join(agentsDir, entry), contents);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length) {
      throw new AggregateError(
        [error, ...restoreErrors],
        "Routed agent catalog update failed and its previous files could not be restored.",
      );
    }
    throw error;
  }
}

export function routedCodexAgentStatus(models, agentsDir = CODEX_AGENTS_DIR) {
  const status = {
    expected: models.length,
    current: 0,
    missing: [],
    stale: [],
    unprotected: [],
    extra: [],
  };
  const expectedFiles = new Set();
  for (const model of models) {
    // The same effort `syncRoutedCodexAgents` writes. Without it the expected
    // contents differ from the file on disk by exactly the
    // `model_reasoning_effort` line, so every model with a configured subagent
    // effort read as permanently `stale`: doctor reported drift, `--fix`
    // republished the identical bytes, and the next check reported it again.
    const definition = routedAgentDefinition(model, { effort: subagentEffort(model.slug) });
    const target = path.join(agentsDir, definition.fileName);
    expectedFiles.add(definition.fileName);
    if (!existsSync(target)) {
      status.missing.push(model.slug);
      continue;
    }
    let contents;
    try {
      contents = readFileSync(target, "utf8");
    } catch {
      status.stale.push(model.slug);
      continue;
    }
    if (contents !== definition.contents) {
      status.stale.push(model.slug);
      continue;
    }
    if (!privateFileIsProtected(target)) {
      status.unprotected.push(model.slug);
      continue;
    }
    status.current += 1;
  }
  status.extra = managedAgentFiles(agentsDir).filter((entry) => !expectedFiles.has(entry));
  return {
    ...status,
    // A leftover definition is as much a drift as a missing one: it keeps a
    // model spawnable that the settings no longer allow. An install with every
    // model switched off is a valid state, so an empty set stays ok.
    ok:
      status.current === status.expected &&
      status.stale.length === 0 &&
      status.unprotected.length === 0 &&
      status.extra.length === 0,
  };
}
