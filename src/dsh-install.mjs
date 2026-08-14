import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { npmGlobalBinary, npmInstallGlobal, spawnEnvironment } from "./npm-global-install.mjs";
import { DSH_CATALOG_PATH } from "./paths.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

// Installing DeepSeek Harness itself, as opposed to publishing routed models
// into one that is already there. `dsh-config-manager.mjs` owns the second half
// and assumes the first; on a machine with no harness that assumption is a
// manual `npm install -g` the user has to find in the docs.
//
// The harness's own README documents `npx @deepseek-ai/dsh web`, which fetches
// the package on every run and leaves no `dsh` on PATH. A global install is the
// right shape here for two reasons: the user gets a command they can type
// again, and `presence-state.mjs` can see it -- an npx invocation is a
// transient process this router has no way to observe.
export const DSH_NPM_PACKAGE = "@deepseek-ai/dsh";
export const DSH_EXECUTABLE = "dsh";

// The harness's launcher is ESM-only and uses syntax that older runtimes reject
// at parse time, so a stale Node fails with a syntax error from inside
// node_modules rather than anything a user can act on. Check first and say so.
export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_MINOR = 19;

// npm has to reach the registry and unpack a large dependency tree.
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;

export function harnessCliPath() {
  const direct = commandOnPath(DSH_EXECUTABLE);
  if (direct) return direct;
  return npmGlobalBinary(DSH_EXECUTABLE);
}

export function harnessVersion(binary = harnessCliPath()) {
  if (!binary) return undefined;
  try {
    const command = spawnableCommand(binary, ["--version"]);
    const output = execFileSync(command.command, command.args, {
      ...command.options,
      encoding: "utf8",
      env: spawnEnvironment(),
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    // `--version` prints the bare version; take the first line that looks like
    // one rather than the whole of a launcher's banner.
    return (
      String(output || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^\d+\.\d+\.\d+/.test(line)) || undefined
    );
  } catch {
    return undefined;
  }
}

// Reported rather than enforced by npm: the package declares no `engines`, so
// nothing stops the install and the failure surfaces at first boot instead.
export function nodeMeetsHarnessMinimum(version = process.versions.node) {
  const [major, minor] = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  if (major !== MINIMUM_NODE_MAJOR) return major > MINIMUM_NODE_MAJOR;
  return Number.isFinite(minor) && minor >= MINIMUM_NODE_MINOR;
}

export async function harnessSnapshotWithWeb() {
  const base = harnessSnapshot();
  const { nativeSessionStatus } = await import("./codex-native-session.mjs");
  // Reported beside the harness because this is where its consequence shows:
  // native models publish only while the session is spendable, so a stale one
  // is why eight models quietly left the picker.
  const nativeSession = nativeSessionStatus();
  if (!base.installed) {
    return { ...base, nativeSession, web: { running: false, url: null } };
  }
  const { dshWebState } = await import("./dsh-web.mjs");
  return { ...base, nativeSession, web: await dshWebState() };
}

export function harnessSnapshot() {
  const binary = harnessCliPath();
  return {
    package: DSH_NPM_PACKAGE,
    installed: Boolean(binary),
    binary,
    version: harnessVersion(binary),
    published: existsSync(DSH_CATALOG_PATH),
    nodeVersion: process.versions.node,
    nodeSupported: nodeMeetsHarnessMinimum(),
    minimumNode: `${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}`,
  };
}

// Installing is separate from publishing on purpose. This function is allowed
// to be slow and to fail on the network; the publish that follows it touches
// the user's own documents and has to be able to run on its own, repeatedly,
// without reinstalling anything.
export function installHarness({ force = false } = {}) {
  if (!nodeMeetsHarnessMinimum()) {
    throw new Error(
      `DeepSeek Harness needs Node ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR} or newer; this router is running Node ${process.versions.node}. Upgrade Node, then install again.`,
    );
  }
  const existing = harnessCliPath();
  if (existing && !force) return { installed: true, binary: existing, changed: false };

  npmInstallGlobal(DSH_NPM_PACKAGE, {
    label: "DeepSeek Harness",
    timeoutMs: INSTALL_TIMEOUT_MS,
  });

  const binary = harnessCliPath();
  if (!binary) {
    // npm reported success, so the binary exists somewhere npm knows about and
    // this router does not. Name the search so it is fixable.
    throw new Error(
      `npm installed ${DSH_NPM_PACKAGE}, but no \`${DSH_EXECUTABLE}\` was found on PATH or in npm's global bin directory.`,
    );
  }
  return { installed: true, binary, changed: true };
}

// The one action a user actually wants: end up with a harness that can talk to
// this router. Install it if it is missing, then publish the routed models into
// its own documents.
//
// Ordered install-then-publish, and not wrapped in a rollback: a publish that
// fails leaves an installed harness, which is a strictly better place to be
// than where the user started and is exactly what a retry needs. Publishing is
// idempotent, so the retry is a re-run of this same call.
export async function setupHarness({ force = false, setDefaultModel = false } = {}) {
  const install = installHarness({ force });
  const { install: publishRoute } = await import("./dsh-config-manager.mjs");
  const published = publishRoute({ setDefaultModel });

  // Deliberately does not start the UI. Setup already installs a package and
  // writes another program's configuration; launching a server on top of that
  // makes one click three irreversible-looking things, and the last of them is
  // the one the user can trivially do themselves a moment later. Starting is
  // its own button, so a machine that only needed republishing does not get a
  // browser window it did not ask for.
  const { dshWebState } = await import("./dsh-web.mjs");

  return {
    binary: install.binary,
    version: harnessVersion(install.binary),
    installedNow: install.changed,
    published,
    web: await dshWebState(),
    // `published` is the routed count. Native GPT models ride the Codex session
    // this machine is signed in with, so they come and go with it -- reporting
    // the routed set beats a number that changes when nobody published
    // anything, and beats letting somebody count the picker and conclude the
    // publish dropped them.
    launch: `${DSH_EXECUTABLE} web`,
  };
}

// Turning the harness off, as opposed to uninstalling it. Removes this
// router's route from the harness's documents and stops a UI this router
// started -- and stops there. The CLI stays installed, the harness's own
// settings, profiles, sessions, and other providers are untouched, and the
// shared background service keeps running for whatever other client is still
// pointed at it.
export async function disconnectHarness({ stopWeb = true } = {}) {
  const { uninstall: unpublishRoute } = await import("./dsh-config-manager.mjs");
  let web;
  if (stopWeb) {
    const { stopDshWeb } = await import("./dsh-web.mjs");
    web = await stopDshWeb();
  }
  const removed = unpublishRoute();
  const { installedTargets } = await import("./target-integration.mjs");
  return {
    removed,
    web: web || null,
    // Named so the caller can say what survived rather than leaving somebody to
    // wonder whether they just took the router down.
    remainingTargets: installedTargets(),
    stillInstalled: Boolean(harnessCliPath()),
  };
}
