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

export function routedAgentDefinition(model) {
  const slug = String(model?.slug || "").trim();
  if (!slug || !slug.includes("/")) {
    throw new Error(`Cannot create a routed agent for invalid model slug: ${slug || "<empty>"}`);
  }
  const fileStem = `router-model-${safeIdentifier(slug, "-")}`;
  const agentName = `router_${safeIdentifier(slug, "_")}`;
  const displayName = String(model.displayName || model.display_name || slug).trim();
  const contents = [
    "# Managed by Codex Router. Refresh the model catalog to update this file.",
    `name = ${tomlString(agentName)}`,
    `description = ${tomlString(`${displayName} agent routed through an authenticated Codex Router provider.`)}`,
    'model_provider = "codex-router"',
    `model = ${tomlString(slug)}`,
    "",
    'developer_instructions = """',
    "Complete the bounded task assigned by the parent agent.",
    "Respect repository instructions, keep changes surgical, and run relevant verification.",
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
  const written = [];
  const keep = new Set();
  for (const model of models) {
    const definition = routedAgentDefinition(model);
    const target = path.join(agentsDir, definition.fileName);
    const temporary = `${target}.tmp.${process.pid}`;
    writeFileSync(temporary, definition.contents, { encoding: "utf8", mode: 0o600 });
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
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
    const definition = routedAgentDefinition(model);
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
