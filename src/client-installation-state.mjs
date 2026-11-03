// Read-only installation identity shared by publication, service retirement
// and presence. This module never imports the control or publisher stacks.
import { existsSync, readFileSync } from "node:fs";
import {
  CONFIG_PATH, DSH_CATALOG_PATH, GEMINI_CATALOG_PATH, CURSOR_CATALOG_PATH,
  CURSOR_LAUNCHER_PATH, CLAUDE_CATALOG_PATH, OPENCLAW_CATALOG_PATH,
  ROUTED_HARNESS_CATALOG_PATHS,
} from "./paths.mjs";
import { routedHarnesses } from "./routed-harness-catalog.mjs";

export const CURSOR_LAUNCHER_MARKER = "codex-router-cursor-launcher";
const managedMarkerPattern = /^# BEGIN (?:kimi-)?codex-(?:router|proxy)-/m;

function cursorAgentLauncherInstalled() {
  try { return readFileSync(CURSOR_LAUNCHER_PATH, "utf8").includes(CURSOR_LAUNCHER_MARKER); }
  catch { return false; }
}

export function installedTargets() {
  const installed = [];
  // Codex counts as installed while its config still carries a managed block.
  // The cached native catalog is deliberately retained across uninstalls, so
  // its presence says a catalog was once published, not that Codex is still
  // pointed at the plane -- keying on it left the service and its LaunchAgent
  // behind after the last integration was removed.
  if (codexIntegrationInstalled()) installed.push("codex");
  if (existsSync(DSH_CATALOG_PATH)) installed.push("dsh");
  if (existsSync(GEMINI_CATALOG_PATH)) installed.push("gemini");
  if (existsSync(CURSOR_CATALOG_PATH) || cursorAgentLauncherInstalled()) installed.push("cursor");
  if (existsSync(CLAUDE_CATALOG_PATH)) installed.push("claude");
  if (existsSync(OPENCLAW_CATALOG_PATH)) installed.push("openclaw");
  // The document-configured harnesses (opencode, pi, omp, Command Code,
  // Hermes) are published clients like any other, so a live publication keeps
  // the shared plane alive for them too. They are not `MODEL_ROUTER_TARGET`
  // values -- nothing installs *as* one of them -- but `bin/disable` retires
  // the service only once this list is empty, and forgetting them here is how
  // turning Codex off would stop opencode working.
  for (const harness of routedHarnesses()) {
    if (existsSync(ROUTED_HARNESS_CATALOG_PATHS[harness.id])) installed.push(harness.id);
  }
  return installed;
}

export function codexIntegrationInstalled() {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    return managedMarkerPattern.test(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // The file exists and cannot be read — Codex mid-write, an AV lock, a
    // permission hiccup. This answer feeds retire-the-service-if-unused, so
    // "cannot tell" must count as installed: tearing down the shared service
    // because a read flaked is the unrecoverable direction, while keeping it
    // alive one cycle longer costs nothing.
    return true;
  }
}
