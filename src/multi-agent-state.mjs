import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { subagentProofSnapshot } from "./subagent-proofs.mjs";

export const MULTI_AGENT_STATE_PATH =
  process.env.MODEL_ROUTER_MULTI_AGENT_STATE ||
  path.join(STATE_DIR, "multi-agent-settings.json");
// Legacy all-on/all-off switch from the first dynamic-subagent release.
export const MULTI_AGENT_ALL_PATH =
  process.env.MODEL_ROUTER_MULTI_AGENT_ALL ||
  path.join(STATE_DIR, "multi-agent-all.json");

export const SUBAGENT_MODES = Object.freeze(["all", "selected", "proven"]);

function defaultSettings() {
  return { version: 2, mode: "proven", enabled: [], disabled: [] };
}

function legacySettings() {
  if (!existsSync(MULTI_AGENT_ALL_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(MULTI_AGENT_ALL_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return { ...defaultSettings(), mode: parsed.enabled ? "all" : "proven" };
    }
  } catch {
    // Corrupt legacy state is ignored; the conservative default is safer.
  }
  return undefined;
}

// Local selection is operator intent. Registry certification is separate;
// diagnostic probe records never make this choice for the operator.
export function readMultiAgentSettings() {
  if (existsSync(MULTI_AGENT_STATE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(MULTI_AGENT_STATE_PATH, "utf8"));
      if (
        parsed?.version === 2 &&
        SUBAGENT_MODES.includes(parsed.mode) &&
        Array.isArray(parsed.enabled) &&
        Array.isArray(parsed.disabled)
      ) {
        return parsed;
      }
    } catch {
      // Fall through to the legacy switch, then the conservative default.
    }
  }
  return legacySettings() || defaultSettings();
}

export function readAllMultiAgent() {
  return readMultiAgentSettings().mode === "all";
}

export function subagentSettingsSnapshot() {
  const settings = readMultiAgentSettings();
  return {
    ...settings,
    all: settings.mode === "all",
    path: MULTI_AGENT_STATE_PATH,
    // Machine-local certification evidence, keyed by slug: checking /
    // candidate / failed (with the failure reason). It explains why an
    // unknown model is awaiting review, but cannot manufacture a v2 claim.
    proofs: subagentProofSnapshot(),
    // Per-model reasoning depth applied only to child turns. Empty when the
    // operator has never set one, which is the common case.
    efforts: subagentEfforts(),
  };
}

function writeSettings(settings) {
  writePrivateJson(MULTI_AGENT_STATE_PATH, settings, { directoryMode: 0o700 });
}

export function setMultiAgentMode(mode) {
  if (!SUBAGENT_MODES.includes(mode)) {
    throw new Error(`Unknown subagent mode "${mode}". Choose: ${SUBAGENT_MODES.join(", ")}`);
  }
  const current = readMultiAgentSettings();
  const next =
    mode === "all"
      ? { ...current, version: 2, mode, disabled: [] }
      : { ...current, version: 2, mode };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

export function setMultiAgentModel(slug, enabled) {
  return setMultiAgentModels([slug], enabled);
}

// Applies a provider-sized selection in one protected-state write. Besides
// being faster than one command per model, this prevents a half-cleared
// provider when the UI closes or a later catalog refresh fails.
export function setMultiAgentModels(slugs, enabled) {
  const values = [...new Set(slugs.map((slug) => String(slug || "").trim()).filter(Boolean))];
  if (values.length === 0) throw new Error("At least one model slug is required.");
  const current = readMultiAgentSettings();
  const enabledSet = new Set(current.enabled);
  const disabledSet = new Set(current.disabled);
  for (const value of values) {
    if (enabled) {
      enabledSet.add(value);
      disabledSet.delete(value);
    } else {
      enabledSet.delete(value);
      disabledSet.add(value);
    }
  }
  const next = {
    version: 2,
    mode: current.mode === "proven" && enabled ? "selected" : current.mode,
    enabled: [...enabledSet].sort(),
    disabled: [...disabledSet].sort(),
    // Rebuilt literally rather than spread, so every writer has to carry the
    // effort map forward by hand or silently drop a user's choices.
    ...(current.efforts ? { efforts: current.efforts } : {}),
  };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

// Codex picks a subagent's model, but nothing lets an operator say how hard
// that subagent should think. A child auditing one file rarely needs the depth
// its parent is running at, and the reverse is true for a child doing the
// analysis the parent delegated precisely because it was expensive. Effort is
// per model rather than global: the useful setting is "when work lands on this
// model as a child, run it at this depth", and that answer differs by model.
//
// An absent entry means "leave the turn alone", which is not the same as
// recording the model's own default -- a default that later changes upstream
// should follow the model, not stay frozen at whatever it was when someone
// opened a settings page.
export function subagentEfforts() {
  const efforts = readMultiAgentSettings().efforts;
  if (!efforts || typeof efforts !== "object" || Array.isArray(efforts)) return {};
  const clean = {};
  for (const [slug, effort] of Object.entries(efforts)) {
    if (typeof slug === "string" && typeof effort === "string" && slug && effort) {
      clean[slug] = effort;
    }
  }
  return clean;
}

export function subagentEffort(slug) {
  return subagentEfforts()[String(slug || "")];
}

// `effort` of undefined/null clears the override and restores the model's own
// default. Validation against the model's advertised levels belongs to the
// caller, which is the layer that can see the registry.
export function setSubagentEffort(slug, effort) {
  const key = String(slug || "").trim();
  if (!key) throw new Error("A model slug is required.");
  const current = readMultiAgentSettings();
  const efforts = { ...subagentEfforts() };
  if (effort === undefined || effort === null || effort === "") delete efforts[key];
  else efforts[key] = String(effort).trim();
  const next = { ...current, version: 2 };
  if (Object.keys(efforts).length) next.efforts = efforts;
  else delete next.efforts;
  writeSettings(next);
  return subagentSettingsSnapshot();
}

export function replaceMultiAgentState({ mode, enabled = [], disabled = [], efforts }) {
  if (!SUBAGENT_MODES.includes(mode)) {
    throw new Error(`Unknown subagent mode "${mode}". Choose: ${SUBAGENT_MODES.join(", ")}`);
  }
  const carried = efforts === undefined ? readMultiAgentSettings().efforts : efforts;
  const next = {
    version: 2,
    mode,
    enabled: [...new Set(enabled)].sort(),
    disabled: [...new Set(disabled)].sort(),
    ...(carried && Object.keys(carried).length ? { efforts: carried } : {}),
  };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

// The three modes documented in `.claude/skills/codex-subagents/SKILL.md`:
// `proven` ships only what the registry verified, `selected` adds the routes
// the operator explicitly turned on, and `all` advertises every non-hidden
// route "regardless of whether it works".
//
// Only these lines promote, and only from an explicit choice the operator made
// and can see in `subagents status`. A machine-local probe still promotes
// nothing on its own. Diagnostic records are separate from this deliberate
// selection.
export function applyMultiAgentSettings(models, settings, hidden = new Set()) {
  const disabled = new Set(settings.disabled || []);
  const enabled = new Set(settings.enabled || []);
  const mode = settings.mode || "proven";
  return models.map((model) => {
    const slug = String(model.slug || "");
    // An explicit `off` beats every mode, including `all`.
    if (hidden.has(model.slug) || disabled.has(slug)) {
      return { ...model, multiAgentVersion: "v1" };
    }
    if (model.multiAgentVersion === "v2") return model;
    if (mode === "all" || (mode === "selected" && enabled.has(slug))) {
      return { ...model, multiAgentVersion: "v2", subagentSelectedByOperator: true };
    }
    return model;
  });
}

// Registry capability and explicit operator selection are the only inputs to
// publication. Diagnostic records never grant or revoke the native child role.
export function applyMultiAgentCapabilities(models, settings, { hidden = new Set() } = {}) {
  return applyMultiAgentSettings(models, settings || readMultiAgentSettings(), hidden);
}

// Models the user has not switched off as a subagent.
//
// Only the explicit "off" is honoured here. A model the settings never mention
// keeps the definition it has always had, so an install that has chosen
// nothing keeps every model callable by name the way it does today.
export function subagentEligibleModels(models, settings) {
  const disabled = new Set(settings?.disabled || []);
  return models.filter(
    (model) =>
      model.multiAgentVersion === "v2" && !disabled.has(String(model.slug)),
  );
}

// Compatibility helper for the original all-models switch.
export function applyAllMultiAgent(models, enabled) {
  return applyMultiAgentSettings(models, {
    version: 2,
    mode: enabled ? "all" : "proven",
    enabled: [],
    disabled: [],
  });
}

// Compatibility helper for the original shell switch.
export function writeAllMultiAgent(enabled) {
  setMultiAgentMode(enabled ? "all" : "proven");
  return enabled;
}
