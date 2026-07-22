import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { NATIVE_CATALOG_PATH, SOURCE_ROOT, TARGET } from "./paths.mjs";

function run(script, args = []) {
  execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function targetCli(command) {
  return TARGET === "cursor"
    ? `./bin/model-router cursor ${command}`
    : `./bin/${command}`;
}

export function targetPickerName() {
  return TARGET === "cursor" ? "Cursor" : "Codex";
}

export function refreshTargetPickerIfInstalled() {
  if (TARGET === "cursor") return false;
  if (!existsSync(NATIVE_CATALOG_PATH)) return false;
  run("catalog.mjs");
  return true;
}
