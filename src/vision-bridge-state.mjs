import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const VISION_BRIDGE_STATE_PATH =
  process.env.MODEL_ROUTER_VISION_BRIDGE_STATE ||
  path.join(STATE_DIR, "vision-bridge.json");

// What a machine that has never answered the question gets. Pasting a
// screenshot to a text-only model is the single thing operators expect to work
// without reading documentation, and everything the bridge needs to serve it is
// already installed. So the honest default is on.
//
// The default names a model rather than ranking for one. The ranking scored
// "cheapest" by testing slugs against /flash|haiku|mini|lite|small|turbo/, which
// matches none of the engines a typical install actually has -- they all tie and
// the winner falls out of alphabetical order. Calling that "the cheapest paid
// model" in the UI was a claim the code could not support, so the default is a
// named model at a named effort: transcribing a screenshot is mechanical work
// that the smallest reasoning setting handles.
//
// A default that is unavailable (no OpenAI login) still falls back to the
// ranking; `defaulted` is what tells the resolver this was nobody's decision.
// An engine the operator picked never falls back -- see resolveVisionEngine.
//
// This is deliberately *not* the fallback for a state file that exists and
// cannot be read -- see `disabledSettings()`.
export const DEFAULT_VISION_ENGINE = "gpt-5.6-luna";
export const DEFAULT_VISION_EFFORT = "low";

function defaultSettings() {
  return {
    version: 1,
    enabled: true,
    engine: DEFAULT_VISION_ENGINE,
    effort: DEFAULT_VISION_EFFORT,
    local: null,
    defaulted: true,
  };
}

// The conservative reading, used only when a state file is present but this
// build cannot make sense of it. A file on disk means the operator has been
// here; it is not evidence of consent, so it must not inherit a default that
// starts spending an engine's quota. Off is what every install had before the
// bridge existed, and `bin/control vision-bridge on` is one command away.
function disabledSettings() {
  return { version: 1, enabled: false, engine: null, effort: null, local: null };
}

// Transcribing a screenshot is mechanical work, so the engine's own default is
// usually the right spend. An operator who wants a dense dashboard read
// properly, or who wants the cheapest possible pass, can say so. `null` leaves
// the model's default alone, which is what every install had before.
// The whole ladder Codex knows, not one model's slice of it: which levels are
// really on offer is the engine's own declaration, checked where the request is
// built. This list only keeps a hand-edited state file from smuggling in a
// value no model could ever accept.
export const VISION_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function normalizeEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VISION_EFFORT_LEVELS.includes(effort) ? effort : null;
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

// The checked-in registry keeps declaring what each model itself can read; this
// state only records how the operator wants the router to stand in for the
// missing capability on this machine.
//
// Three cases, and the distinction between them is structural rather than a
// sentinel value:
//
//   no file      -- nobody has ever answered. Takes the current default.
//   readable     -- `enabled` is the operator's own answer and is taken
//                   verbatim, forever. A stored `false` is never re-enabled by
//                   a change of default; that is the whole point of writing it.
//   unreadable   -- a file exists, so somebody was here, but this build cannot
//                   tell what they chose. Falls back to off, not to the default.
//
// That is why the version stays 1. A bumped version would have to guess what a
// v1 `false` meant, and there is nothing to guess with: file presence already
// separates "never configured" from "configured off", and `visionBridgeConfigured()`
// has been the installer's gate on exactly that distinction since the bridge
// shipped. A migration could only replace a fact with an inference.
export function readVisionBridgeSettings() {
  if (!existsSync(VISION_BRIDGE_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(VISION_BRIDGE_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        engine: typeof parsed.engine === "string" && parsed.engine ? parsed.engine : null,
        effort: normalizeEffort(parsed.effort),
        local: normalizeLocal(parsed.local),
      };
    }
  } catch {
    // Falls through to the conservative reading below.
  }
  return disabledSettings();
}

function writeSettings(settings) {
  writePrivateJson(VISION_BRIDGE_STATE_PATH, settings, { directoryMode: 0o700 });
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

// Only the native and gateway paths carry this. A local engine speaks chat
// completions to Ollama or LM Studio, which has no reasoning-effort field.
export function setVisionBridgeEffort(effort) {
  const current = readVisionBridgeSettings();
  return writeSettings({ ...current, version: 1, effort: normalizeEffort(effort) });
}

// True once the operator has made any explicit choice. This is the structural
// line between "never configured", which takes the current default, and
// "configured", whose stored `enabled` is authoritative and outlives any change
// of default. Surfaces that would otherwise nag about an unconfigured install
// check this rather than inferring intent from the value.
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
