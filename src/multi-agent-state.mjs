import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

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

// Local opt-in that controls which selected models are advertised as native
// v2 spawn-agent overrides. The checked-in registry stays conservative; this
// state only changes how the merged catalog for this machine is rendered.
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
  };
}

function writeSettings(settings) {
  const stateDir = path.dirname(MULTI_AGENT_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${MULTI_AGENT_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, MULTI_AGENT_STATE_PATH);
  protectPrivateFile(MULTI_AGENT_STATE_PATH);
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
  const value = String(slug || "").trim();
  if (!value) throw new Error("A model slug is required.");
  const current = readMultiAgentSettings();
  const enabledSet = new Set(current.enabled);
  const disabledSet = new Set(current.disabled);
  if (enabled) {
    enabledSet.add(value);
    disabledSet.delete(value);
  } else {
    enabledSet.delete(value);
    disabledSet.add(value);
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
  const enabled = new Set(settings.enabled || []);
  const disabled = new Set(settings.disabled || []);
  return models.map((model) => {
    if (hidden.has(model.slug)) {
      return { ...model, multiAgentVersion: "v1" };
    }
    if (disabled.has(model.slug)) {
      return { ...model, multiAgentVersion: "v1" };
    }
    if (settings.mode === "all") {
      return { ...model, multiAgentVersion: "v2" };
    }
    if (
      settings.mode === "selected" &&
      (enabled.has(model.slug) || model.multiAgentVersion === "v2")
    ) {
      return { ...model, multiAgentVersion: "v2" };
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
  return models.filter((model) => !disabled.has(String(model.slug)));
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
