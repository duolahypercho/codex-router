import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_PATH,
  DSH_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";

// The begin markers config-manager.mjs writes around every block it owns,
// including the legacy kimi-era pairs it still recognizes. config-manager.mjs
// is a command-line script, so the prefix is restated here rather than
// imported; the markers are a compatibility surface that lives in users'
// config files and cannot change without a migration anyway.
const managedMarkerPattern = /^# BEGIN (?:kimi-)?codex-(?:router|proxy)-/m;

function run(script, args = []) {
  execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function targetCli(command) {
  return `./bin/${command}`;
}

export function targetPickerName() {
  return TARGET === "dsh" ? "DeepSeek Harness" : "Codex";
}

/**
 * How the user gets the new model list in front of them.
 *
 * Codex loads its catalog once at startup, so it has to be fully quit and
 * reopened. The harness hot-reloads `settings.yaml` through
 * `dsh-settings-file`, so there is nothing to restart — saying "quit and
 * reopen" there would be busywork the product does not need.
 */
export function targetRestartHint() {
  return TARGET === "dsh"
    ? "DeepSeek Harness reloads its settings document on the next request."
    : `Fully quit and reopen ${targetPickerName()} to refresh the model picker.`;
}

/**
 * Republishes every *installed* client integration, not only the active target.
 *
 * The router plane is shared: enabling a provider, storing a key, or curating a
 * model changes the routable set for Codex and the harness alike. Refreshing
 * only whichever target the current command happens to run under is how one
 * client ends up advertising a model the other just gained or lost.
 */
/**
 * Which client integrations are currently published.
 *
 * The service, gateway, ports, and credentials are one shared plane -- see the
 * note on `ROUTER_PLANE_TARGET` in paths.mjs. Turning one client off is not a
 * reason to tear that plane down while another client is still pointed at it,
 * which is how disabling the harness used to stop Codex working too.
 */
export function installedTargets() {
  const installed = [];
  // Codex counts as installed while its config still carries a managed block.
  // The cached native catalog is deliberately retained across uninstalls, so
  // its presence says a catalog was once published, not that Codex is still
  // pointed at the plane -- keying on it left the service and its LaunchAgent
  // behind after the last integration was removed.
  if (codexIntegrationInstalled()) installed.push("codex");
  if (existsSync(DSH_CATALOG_PATH)) installed.push("dsh");
  return installed;
}

function codexIntegrationInstalled() {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    return managedMarkerPattern.test(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return false;
  }
}

export function refreshTargetPickerIfInstalled() {
  let refreshed = false;
  if (existsSync(NATIVE_CATALOG_PATH)) {
    run("catalog.mjs");
    refreshed = true;
  }
  // The snapshot in the router's own state directory is the marker, not the
  // user's settings document: it records that this router published there, and
  // it survives a user who edits or moves the document by hand.
  if (existsSync(DSH_CATALOG_PATH)) {
    run("dsh-config-manager.mjs", ["install"]);
    refreshed = true;
  }
  return refreshed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "installed-targets") {
    process.stdout.write(`${installedTargets().join(",")}\n`);
  } else {
    console.error("Usage: target-integration installed-targets");
    process.exit(2);
  }
}
