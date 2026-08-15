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

// Local selection controls which proven models remain available as subagents.
// Capability comes only from the registry's native collaboration proof; local
// state must never manufacture a v2 claim for an unverified model.
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
    // Machine-local capability verdicts, keyed by slug: checking /
    // experimental / proven / failed (with the failure reason). This is what
    // lets a surface explain *why* an enabled model is or is not offered as
    // a subagent instead of leaving it a silent no-show.
    proofs: subagentProofSnapshot(),
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
  };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

export function replaceMultiAgentState({ mode, enabled = [], disabled = [] }) {
  if (!SUBAGENT_MODES.includes(mode)) {
    throw new Error(`Unknown subagent mode "${mode}". Choose: ${SUBAGENT_MODES.join(", ")}`);
  }
  const next = {
    version: 2,
    mode,
    enabled: [...new Set(enabled)].sort(),
    disabled: [...new Set(disabled)].sort(),
  };
  writeSettings(next);
  return subagentSettingsSnapshot();
}

export function applyMultiAgentSettings(models, settings, hidden = new Set()) {
  const disabled = new Set(settings.disabled || []);
  return models.map((model) => {
    if (hidden.has(model.slug)) {
      return { ...model, multiAgentVersion: "v1" };
    }
    if (disabled.has(model.slug)) {
      return { ...model, multiAgentVersion: "v1" };
    }
    return model;
  });
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
