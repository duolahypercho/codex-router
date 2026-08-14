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
import { DSH_CATALOG_PATH, STATE_DIR } from "./paths.mjs";

export const PRESENCE_ALWAYS = "always";
export const PRESENCE_FOLLOW_CODEX = "follow-codex";
export const PRESENCE_MODES = [PRESENCE_ALWAYS, PRESENCE_FOLLOW_CODEX];

export const PRESENCE_STATE_PATH =
  process.env.MODEL_ROUTER_PRESENCE_STATE || path.join(STATE_DIR, "presence.json");

// How the tray ties the router to the Codex/ChatGPT desktop apps. The tray owns
// the setting, but the Node side has to read it too: in follow mode a stopped
// service is the expected resting state, and doctor must not report that as a
// failure the way it reports a service that died on its own.
export function readPresenceMode() {
  if (!existsSync(PRESENCE_STATE_PATH)) return PRESENCE_ALWAYS;
  try {
    const parsed = JSON.parse(readFileSync(PRESENCE_STATE_PATH, "utf8"));
    if (parsed?.version !== 1) return PRESENCE_ALWAYS;
    return PRESENCE_MODES.includes(parsed.mode) ? parsed.mode : PRESENCE_ALWAYS;
  } catch {
    return PRESENCE_ALWAYS;
  }
}

// Follow mode watches two desktop bundle IDs. DeepSeek Harness is a CLI, so it
// has no bundle to watch and no launch notification to observe -- and it cannot
// be started lazily either: a harness turn that finds 4202 closed fails
// outright, while the stack behind that port takes up to 300s to warm. So a
// published harness route pins the router on. The stored mode is left alone, so
// unpublishing the route hands the user's own choice back.
export function harnessPublished() {
  return existsSync(DSH_CATALOG_PATH);
}

// What the tray and doctor must actually act on, as opposed to what the toggle
// says. Read this rather than the raw mode anywhere a service gets stopped.
export function effectivePresenceMode() {
  const mode = readPresenceMode();
  if (mode === PRESENCE_FOLLOW_CODEX && harnessPublished()) return PRESENCE_ALWAYS;
  return mode;
}

// True when the router is allowed to be down because the desktop apps are shut.
export function serviceFollowsHostApps() {
  return effectivePresenceMode() === PRESENCE_FOLLOW_CODEX;
}

export function presenceSnapshot() {
  return {
    mode: readPresenceMode(),
    effectiveMode: effectivePresenceMode(),
    harnessPublished: harnessPublished(),
    path: PRESENCE_STATE_PATH,
  };
}

export function setPresenceMode(mode) {
  const value = String(mode || "").trim();
  if (!PRESENCE_MODES.includes(value)) {
    throw new Error(`Presence mode must be one of: ${PRESENCE_MODES.join(", ")}.`);
  }

  const stateDir = path.dirname(PRESENCE_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${PRESENCE_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, mode: value }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, PRESENCE_STATE_PATH);
  protectPrivateFile(PRESENCE_STATE_PATH);
  return presenceSnapshot();
}
