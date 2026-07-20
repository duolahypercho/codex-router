import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CLAUDE_CONFIG_STATE_PATH,
  NATIVE_CATALOG_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";

function run(script, args = []) {
  execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function claudeIntegrationEnabled() {
  if (!existsSync(CLAUDE_CONFIG_STATE_PATH)) return false;
  let state;
  try {
    state = JSON.parse(readFileSync(CLAUDE_CONFIG_STATE_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid Claude router state at ${CLAUDE_CONFIG_STATE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (state?.version !== 1 || typeof state.enabled !== "boolean") {
    throw new Error(`Invalid Claude router state at ${CLAUDE_CONFIG_STATE_PATH}.`);
  }
  return state.enabled;
}

export function targetCli(command) {
  return TARGET === "claude"
    ? `./bin/model-router claude ${command}`
    : `./bin/${command}`;
}

export function targetPickerName() {
  return TARGET === "claude" ? "Claude Desktop" : "Codex";
}

export function refreshTargetPickerIfInstalled() {
  if (TARGET === "claude") {
    if (!claudeIntegrationEnabled()) return false;
    run("claude-config-manager.mjs", ["refresh"]);
    return true;
  }
  if (!existsSync(NATIVE_CATALOG_PATH)) return false;
  run("catalog.mjs");
  return true;
}
