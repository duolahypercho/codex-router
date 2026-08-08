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

export const VISION_BRIDGE_STATE_PATH =
  process.env.MODEL_ROUTER_VISION_BRIDGE_STATE ||
  path.join(STATE_DIR, "vision-bridge.json");

function defaultSettings() {
  return { version: 1, enabled: false, engine: null, local: null };
}

function normalizeLocal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  if (!model && !baseUrl) return null;
  const local = {};
  if (model) local.model = model;
  if (baseUrl) local.baseUrl = baseUrl;
  return local;
}

// Local opt-in that lets text-only models receive pasted images as described
// text. The checked-in registry keeps declaring what each model itself can
// read; this state only records that the operator wants the router to stand in
// for the missing capability on this machine.
export function readVisionBridgeSettings() {
  if (!existsSync(VISION_BRIDGE_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(VISION_BRIDGE_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        engine: typeof parsed.engine === "string" && parsed.engine ? parsed.engine : null,
        local: normalizeLocal(parsed.local),
      };
    }
  } catch {
    // Corrupt state falls back to off, which is the behavior every install had
    // before the bridge existed.
  }
  return defaultSettings();
}

function writeSettings(settings) {
  const stateDir = path.dirname(VISION_BRIDGE_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${VISION_BRIDGE_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, VISION_BRIDGE_STATE_PATH);
  protectPrivateFile(VISION_BRIDGE_STATE_PATH);
  return settings;
}

export function setVisionBridgeEnabled(enabled) {
  const current = readVisionBridgeSettings();
  return writeSettings({ ...current, version: 1, enabled: enabled === true });
}

// A tiny local vision model (Ollama, LM Studio, llama.cpp) is the free, private,
// offline engine for an install whose paid providers are all text-only. It is
// never used automatically -- an unreachable localhost would fail every paste --
// so storing it also pins the bridge to it.
export function setVisionBridgeLocal({ model, baseUrl } = {}) {
  const current = readVisionBridgeSettings();
  const local = normalizeLocal({ model, baseUrl });
  return writeSettings({ ...current, version: 1, engine: "local", local });
}

// A pinned engine survives catalog rebuilds, so an operator who chose a cheap
// describer keeps it even after a faster-ranked model shows up in the picker.
// `null` hands the choice back to the automatic ranking.
export function setVisionBridgeEngine(slug) {
  const value = slug === null || slug === undefined ? null : String(slug).trim();
  const current = readVisionBridgeSettings();
  return writeSettings({ ...current, version: 1, engine: value || null });
}

// True once the operator has made any explicit choice. Install-time auto-enable
// checks this so re-running the installer never overrides someone who turned
// the bridge off on purpose.
export function visionBridgeConfigured() {
  return existsSync(VISION_BRIDGE_STATE_PATH);
}

export function visionBridgeSnapshot() {
  return {
    ...readVisionBridgeSettings(),
    configured: visionBridgeConfigured(),
    path: VISION_BRIDGE_STATE_PATH,
  };
}
