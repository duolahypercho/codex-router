import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_PATH,
  DSH_CATALOG_PATH,
  CURSOR_CATALOG_PATH,
  CLAUDE_CATALOG_PATH,
  GEMINI_CATALOG_PATH,
  OPENCLAW_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";

// The begin markers config-manager.mjs writes around every block it owns,
// including the legacy kimi-era pairs it still recognizes. config-manager.mjs
// is a command-line script, so the prefix is restated here rather than
// imported; the markers are a compatibility surface that lives in users'
// config files and cannot change without a migration anyway.
import { clientRestartNotice } from "./client-restart-notice.mjs";
import {
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
  runProcessTree,
} from "./process-tree.mjs";

const managedMarkerPattern = /^# BEGIN (?:kimi-)?codex-(?:router|proxy)-/m;
const DEFAULT_TARGET_PUBLICATION_MS = 5 * 60_000;
const MAX_TARGET_PUBLICATION_MS = 5 * 60_000;

function targetPublicationDeadline(deadline, environment = process.env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : environment;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: DEFAULT_TARGET_PUBLICATION_MS,
    maximumMs: MAX_TARGET_PUBLICATION_MS,
  });
}

export async function runTargetPublicationProcess(
  script,
  args = [],
  {
    signal,
    deadline,
    executable = process.execPath,
    sourceRoot = SOURCE_ROOT,
    environment = process.env,
    run = runProcessTree,
  } = {},
) {
  const operationDeadline = targetPublicationDeadline(deadline, environment);
  const result = await runOperationProcessTree(
    executable,
    [path.join(sourceRoot, "src", script), ...args],
    {
      cwd: sourceRoot,
      env: environment,
      signal,
      deadline: operationDeadline,
      run,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Client publication exited with status ${result.status}.`);
  }
}

export function targetCli(command) {
  return `./bin/${command}`;
}

const PICKER_NAMES = Object.freeze({
  dsh: "DeepSeek Harness",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  claude: "Claude Code",
  openclaw: "OpenClaw",
  codex: "Codex",
});

export function targetPickerName() {
  return PICKER_NAMES[TARGET] || PICKER_NAMES.codex;
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
  if (TARGET === "dsh") {
    return "DeepSeek Harness reloads its settings document on the next request.";
  }
  // Gemini CLI reads its `.env` once, at process start. A session already open
  // keeps the old values; the next `gemini` invocation picks the new ones up.
  // Telling somebody to quit a CLI they may not have running would be busywork.
  if (TARGET === "gemini") {
    return "Gemini CLI reads its environment at startup; the next `gemini` run picks this up.";
  }
  if (TARGET === "cursor") {
    return "Cursor Agent reads the endpoint at launch; fully quit and reopen Cursor App to reload its model settings.";
  }
  if (TARGET === "claude") {
    return "Claude Code reads the router environment at launch; the next `claude-router` run picks this up.";
  }
  if (TARGET === "openclaw") {
    return "OpenClaw reloads its configuration for the next agent run.";
  }
  return `Fully quit and reopen ${targetPickerName()} to refresh the model picker.`;
}

/**
 * Republishes every *installed* client integration, not only the active target.
 *
 * The router plane is shared: enabling a provider, storing a key, or curating a
 * model changes the routable set for Codex, the harness, and Gemini alike.
 * Refreshing only whichever target the current command happens to run under
 * is how one client ends up advertising a model the other just gained or lost.
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
  if (existsSync(GEMINI_CATALOG_PATH)) installed.push("gemini");
  if (existsSync(CURSOR_CATALOG_PATH)) installed.push("cursor");
  if (existsSync(CLAUDE_CATALOG_PATH)) installed.push("claude");
  if (existsSync(OPENCLAW_CATALOG_PATH)) installed.push("openclaw");
  return installed;
}

function codexIntegrationInstalled() {
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

export async function refreshTargetPickerIfInstalled({ signal, deadline } = {}) {
  // Every publisher inherits the operation's one absolute deadline and runs
  // in a separately terminable process tree. The initial check prevents an
  // already-expired operation from touching the first client; each child then
  // remains bounded even if it or one of its descendants wedges.
  const operationDeadline = targetPublicationDeadline(deadline);
  remainingOperationMs(operationDeadline, signal, {
    message: "The router operation deadline expired before client publication completed.",
  });
  let refreshed = false;
  // A managed Codex config is the integration marker. Keep the retained
  // native capture as a fallback for an uninstall/update transition, but do
  // not let a missing cache silently make a live Codex install the one client
  // that misses a shared picker mutation.
  if (codexIntegrationInstalled() || existsSync(NATIVE_CATALOG_PATH)) {
    await runTargetPublicationProcess("catalog.mjs", [], {
      signal,
      deadline: operationDeadline,
    });
    refreshed = true;
  }
  // The snapshot in the router's own state directory is the marker, not the
  // user's settings document: it records that this router published there, and
  // it survives a user who edits or moves the document by hand.
  if (existsSync(DSH_CATALOG_PATH)) {
    await runTargetPublicationProcess("dsh-config-manager.mjs", ["install"], {
      signal,
      deadline: operationDeadline,
    });
    refreshed = true;
  }
  // Gemini CLI is served its model list live off the router's own catalog, so
  // there is no list here to keep in step -- but the published default model is
  // a slug like any other, and a republish is what moves it off one the routable
  // set just lost.
  if (existsSync(GEMINI_CATALOG_PATH)) {
    await runTargetPublicationProcess("gemini-config-manager.mjs", ["install"], {
      signal,
      deadline: operationDeadline,
    });
    refreshed = true;
  }
  if (existsSync(CURSOR_CATALOG_PATH)) {
    // Cursor's SQLite settings are process-owned. A running app can overwrite
    // an external transaction on exit, so leave the existing publication in
    // place and let doctor report catalog drift until the user quits Cursor.
    const status = JSON.parse(
      execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", "cursor-config-manager.mjs"), "status"], {
        cwd: SOURCE_ROOT,
        env: process.env,
        encoding: "utf8",
      }),
    );
    if (!status.running) {
      await runTargetPublicationProcess("cursor-config-manager.mjs", ["install"], {
        signal,
        deadline: operationDeadline,
      });
    }
    refreshed = true;
  }
  if (existsSync(CLAUDE_CATALOG_PATH)) {
    await runTargetPublicationProcess("claude-code-config-manager.mjs", ["install"], {
      signal,
      deadline: operationDeadline,
    });
    refreshed = true;
  }
  if (existsSync(OPENCLAW_CATALOG_PATH)) {
    await runTargetPublicationProcess("openclaw-config-manager.mjs", ["install"], {
      signal,
      deadline: operationDeadline,
    });
    refreshed = true;
  }
  return refreshed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "installed-targets") {
    process.stdout.write(`${installedTargets().join(",")}\n`);
  } else if (process.argv[2] === "restart-notice") {
    // Prints nothing for a client that reloads on its own, so the installer can
    // call this unconditionally and stay silent where silence is correct.
    const notice = clientRestartNotice(TARGET);
    if (notice) process.stdout.write(`${notice}\n`);
  } else {
    console.error("Usage: target-integration installed-targets|restart-notice");
    process.exit(2);
  }
}
