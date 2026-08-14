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
import { commandOnPath } from "./spawnable-command.mjs";

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

// Follow mode watches two desktop bundle identifiers, and that is the whole of
// what it can watch: `NSRunningApplication` enumerates app bundles, so a client
// run from a shell registers nothing at all. Neither can such a client be
// started on demand -- a turn that finds 127.0.0.1:4202 closed fails at once,
// while the stack behind that port takes up to 300s to warm, so lazy start does
// not exist at request latency. A client the tray cannot see therefore pins the
// router on.
//
// Two of them qualify, for the same reason by two different signals.

// The harness, by its published route. `dsh` is a CLI, and the route existing
// means it is configured to reach this router.
export function harnessPublished() {
  return existsSync(DSH_CATALOG_PATH);
}

// Codex, by being typeable at a shell prompt. The desktop app registers a
// bundle the tray watches; `codex` on PATH is a terminal session it cannot.
// Detection deliberately errs toward finding one: a false positive costs a
// dormant toggle, a false negative costs a user their next request.
//
// Memoized against PATH itself rather than unconditionally -- this shells out
// to which/where, and the answer only changes when PATH does.
let terminalCodexCache = { path: undefined, found: false };
export function terminalCodexInstalled() {
  const current = process.env.PATH || "";
  if (terminalCodexCache.path !== current) {
    terminalCodexCache = { path: current, found: Boolean(commandOnPath("codex")) };
  }
  return terminalCodexCache.found;
}

// What the tray and doctor must actually act on, as opposed to what the toggle
// says. Read this rather than the raw mode anywhere a service gets stopped.
export function effectivePresenceMode() {
  const mode = readPresenceMode();
  if (mode !== PRESENCE_FOLLOW_CODEX) return mode;
  if (harnessPublished() || terminalCodexInstalled()) return PRESENCE_ALWAYS;
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
    terminalCodex: terminalCodexInstalled(),
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
