import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import {
  CURSOR_CONFIG_STATE_PATH,
  PORTS,
  TARGET,
  loopback,
} from "./paths.mjs";
import { selectedListedModels } from "./provider-selection.mjs";

// Cursor exposes no additive, safely-editable config file — its model settings
// live in an application state database that we must not touch, or we would
// risk the user's existing Cursor experience. So this manager never edits
// Cursor: it only records the router-side enable/disable state and reports the
// values the user pastes into Cursor → Settings → Models. That keeps the
// integration reversible and leaves Cursor's own config untouched.

const STATE_VERSION = 1;
const command = process.argv[2] || "status";
const allowedCommands = new Set(["enable", "disable", "status"]);

if (TARGET !== "cursor") {
  throw new Error("cursor-config-manager.mjs requires MODEL_ROUTER_TARGET=cursor.");
}
if (!allowedCommands.has(command)) {
  console.error("Usage: cursor-config-manager.mjs enable|disable|status");
  process.exit(2);
}

function readState() {
  if (!existsSync(CURSOR_CONFIG_STATE_PATH)) {
    return { version: STATE_VERSION, enabled: false };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(CURSOR_CONFIG_STATE_PATH, "utf8"));
  } catch {
    throw new Error(`Invalid Cursor router state at ${CURSOR_CONFIG_STATE_PATH}.`);
  }
  if (state.version !== STATE_VERSION || typeof state.enabled !== "boolean") {
    throw new Error(`Invalid Cursor router state at ${CURSOR_CONFIG_STATE_PATH}.`);
  }
  return state;
}

function writeState(enabled) {
  mkdirSync(path.dirname(CURSOR_CONFIG_STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CURSOR_CONFIG_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: STATE_VERSION, enabled }, null, 2)}\n`,
    { mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, CURSOR_CONFIG_STATE_PATH);
}

// The caller key is intentionally excluded here so status output stays safe to
// log; cursor-setup.mjs is what reveals it to the user for the paste-in step.
function statusPayload(state) {
  return {
    target: "cursor",
    enabled: state.enabled,
    baseUrl: loopback(PORTS.router, "/v1"),
    models: selectedListedModels().map((model) => model.gatewayModel),
  };
}

if (command === "enable") {
  writeState(true);
} else if (command === "disable") {
  writeState(false);
}

process.stdout.write(`${JSON.stringify(statusPayload(readState()))}\n`);
