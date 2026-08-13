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
import { toolResultAgingTotals } from "./usage-events.mjs";

export const TOOL_RESULT_AGING_STATE_PATH =
  process.env.MODEL_ROUTER_TOOL_RESULT_AGING_STATE ||
  path.join(STATE_DIR, "tool-result-aging.json");

// Routed aging defaults on; native aging defaults off. The native path is
// deliberately conservative (near-byte-identical forwarding to OpenAI), so
// compacting it is an explicit operator opt-in rather than a default.
function defaultSettings() {
  return { version: 1, enabled: true, nativeEnabled: false, defaulted: true };
}

function disabledSettings() {
  return { version: 1, enabled: false, nativeEnabled: false };
}

export function readToolResultAgingSettings() {
  if (!existsSync(TOOL_RESULT_AGING_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(TOOL_RESULT_AGING_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        // Absent on files written before the native flag existed; absence is
        // the off default, never an error.
        nativeEnabled: parsed.nativeEnabled === true,
      };
    }
  } catch {
    // A malformed explicit choice must not silently change routed context.
  }
  return disabledSettings();
}

function writeSettings(settings) {
  const stateDir = path.dirname(TOOL_RESULT_AGING_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${TOOL_RESULT_AGING_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, TOOL_RESULT_AGING_STATE_PATH);
  protectPrivateFile(TOOL_RESULT_AGING_STATE_PATH);
  return settings;
}

export function setToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: enabled === true,
    nativeEnabled: current.nativeEnabled === true,
  });
}

export function setNativeToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: current.enabled === true,
    nativeEnabled: enabled === true,
  });
}

export function toolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().enabled;
}

// The environment kill switch silences both paths: it exists to stop the
// router rewriting request context at all, not one flavor of it.
export function nativeToolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().nativeEnabled === true;
}

export function toolResultAgingSnapshot() {
  const settings = readToolResultAgingSettings();
  const environmentOverride = process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0";
  return {
    ...settings,
    enabled: environmentOverride ? false : settings.enabled,
    configured: existsSync(TOOL_RESULT_AGING_STATE_PATH),
    environmentOverride,
    path: TOOL_RESULT_AGING_STATE_PATH,
    // Cumulative savings derived from recorded usage events, so every status
    // surface (CLI, desktop, tray) can show what the feature actually bought.
    stats: toolResultAgingTotals(),
  };
}
