// Finding and installing the five routed harness CLIs.
//
// The discipline is the one `dsh-install.mjs` set, and it is repeated here
// rather than assumed: installing a third-party package over the network is
// something a user asked for in as many words, never a consequence of
// something else. Nothing in this file runs from `apply`, `enable`, or a
// repair path — only from the explicit setup action on that client's row.
//
// The npm mechanics themselves live in `npm-global-install.mjs`, one copy for
// this and for the provider CLIs, because the details that took a debugging
// session to get right (the PATH a spawn inherits, where npm drops binaries
// per platform, which line of npm's output is worth showing) are exactly what
// drifts between copies.
//
// Hermes Agent and omp have no install this router can run: Hermes ships a
// shell script the user pipes into their shell, and omp runs on Bun and
// installs from its own script, Homebrew, or Bun. This router does not run
// remote installers on somebody's behalf, so those rows report the CLI as
// missing and link to the official instructions instead of offering a button.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  npmGlobalBinary,
  npmInstallGlobal,
  spawnEnvironment,
} from "./npm-global-install.mjs";
import { assertRoutedHarness, routedHarnesses } from "./routed-harness-catalog.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;

/**
 * Where this harness's CLI is, or undefined.
 *
 * An explicit `<HARNESS>_BIN` wins so a desktop app — which does not inherit
 * the login shell's PATH — can hand over the executable it already validated
 * rather than asking a narrower child to rediscover it. Otherwise PATH, then
 * npm's global bin directory, which is where a just-installed package lands on
 * a machine whose PATH has not been reloaded yet.
 */
export function routedHarnessCliPath(id, { environment = process.env } = {}) {
  const harness = assertRoutedHarness(id);
  const configured = harness.binEnv ? environment[harness.binEnv] : undefined;
  if (configured && existsSync(configured)) return configured;
  for (const executable of harness.executables) {
    const found = commandOnPath(executable) || npmGlobalBinary(executable);
    if (found) return found;
  }
  return undefined;
}

/** The version string this CLI reports, or undefined when it will not say. */
export function routedHarnessVersion(id, binary = routedHarnessCliPath(id)) {
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
    return String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /\d+\.\d+/.test(line)) || undefined;
  } catch {
    return undefined;
  }
}

function versionParts(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : undefined;
}

/**
 * Whether this CLI reports a version below the one that reads what the router
 * publishes. A version the CLI will not report is not called outdated: that is
 * an unknown, and refusing a working client over it would be the worse error.
 */
export function routedHarnessOutdated(id, version) {
  const minimum = versionParts(assertRoutedHarness(id).minimumVersion);
  const actual = versionParts(version);
  if (!minimum || !actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] < minimum[index];
  }
  return false;
}

/** Whether this router can install this harness itself. */
export function routedHarnessInstallable(id) {
  return Boolean(assertRoutedHarness(id).npmPackage);
}

/**
 * Whether this router can move this harness to its latest release.
 *
 * Broader than `routedHarnessInstallable`: Hermes has no package to reinstall
 * but does maintain its own checkout, so it can be updated without ever having
 * been installable from here.
 */
export function routedHarnessUpdatable(id) {
  const harness = assertRoutedHarness(id);
  return Boolean(harness.updateCommand || harness.npmPackage);
}

/** Detection only: never installs, never writes, safe to call on page load. */
export function routedHarnessSnapshot(id, { environment = process.env } = {}) {
  const harness = assertRoutedHarness(id);
  const binary = routedHarnessCliPath(id, { environment });
  const version = routedHarnessVersion(id, binary) || null;
  return {
    id: harness.id,
    displayName: harness.displayName,
    package: harness.npmPackage || null,
    installable: routedHarnessInstallable(id),
    installed: Boolean(binary),
    binary: binary || null,
    version,
    minimumVersion: harness.minimumVersion || null,
    outdated: routedHarnessOutdated(id, version),
    updatable: routedHarnessUpdatable(id),
    // What an update would actually run, so a row can say so before it is
    // clicked and a support bundle records it afterwards.
    updateVia: harness.updateCommand
      ? `${harness.executables[0]} ${harness.updateCommand.join(" ")}`
      : harness.npmPackage
        ? `npm install -g ${harness.npmPackage}`
        : null,
    manualInstall: harness.manualInstall ? [...harness.manualInstall] : null,
  };
}

/**
 * Installs the harness CLI globally when it is missing, and updates one too old
 * to read the document the router publishes into.
 *
 * Global, not `npx`: an `npx` process refetches per run, leaves no executable
 * behind, and is invisible to `presence-state.mjs`, which has to be able to see
 * a client to keep the router up for it.
 */
export function installRoutedHarness(id, {
  force = false,
  find = routedHarnessCliPath,
  version = routedHarnessVersion,
  install = npmInstallGlobal,
} = {}) {
  const harness = assertRoutedHarness(id);
  const existing = find(id);
  const outdated = Boolean(existing && harness.minimumVersion) && routedHarnessOutdated(id, version(id, existing));
  if (existing && !force && !outdated) return { installed: true, binary: existing, changed: false };
  if (!harness.npmPackage) {
    throw new Error(
      `${harness.displayName} is not installed and does not publish a package this router can install. ` +
        `Install it from ${harness.siteUrl}, then publish again.`,
    );
  }
  install(harness.npmPackage, {
    label: harness.displayName,
    timeoutMs: INSTALL_TIMEOUT_MS,
    ...(harness.npmInstallArgs ? { extraArgs: [...harness.npmInstallArgs] } : {}),
  });
  const binary = find(id);
  if (!binary) {
    throw new Error(
      `npm installed ${harness.npmPackage}, but no \`${harness.executables[0]}\` was found on PATH ` +
        "or in npm's global bin directory.",
    );
  }
  if (harness.minimumVersion && routedHarnessOutdated(id, version(id, binary))) {
    // npm updated its copy, but an older install elsewhere still wins on PATH.
    throw new Error(
      `${harness.displayName} at ${binary} is still older than ${harness.minimumVersion}, the first release ` +
        "that reads the provider this router publishes. Update or remove that install, then publish again.",
    );
  }
  return { installed: true, binary, changed: true, ...(outdated ? { upgraded: true } : {}) };
}

/**
 * Moves one harness CLI to its latest release.
 *
 * Prefers the client's *own* updater over `npm install -g`. A CLI installed by
 * Homebrew or a `curl | sh` script is not an npm package, and reinstalling it
 * as one leaves two copies whose winner is decided by PATH order — the class of
 * bug where the row reports the new version and the shell keeps running the old
 * one. `opencode upgrade`, `pi update --self`, `cmd update`, and `hermes
 * update` each know how their own copy was installed; npm is the fallback for a
 * client that publishes a package but ships no updater.
 *
 * Like installing, this is never a side effect of publishing: it runs only from
 * `control client-update` and the Harness row's own button.
 */
export function updateRoutedHarness(id, {
  find = routedHarnessCliPath,
  version = routedHarnessVersion,
  install = npmInstallGlobal,
  run = execFileSync,
} = {}) {
  const harness = assertRoutedHarness(id);
  const binary = find(id);
  const from = binary ? version(id, binary) || null : null;

  if (binary && harness.updateCommand) {
    const command = spawnableCommand(binary, [...harness.updateCommand]);
    try {
      run(command.command, command.args, {
        ...command.options,
        encoding: "utf8",
        env: spawnEnvironment(),
        timeout: INSTALL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || "").trim();
      throw new Error(
        `\`${harness.executables[0]} ${harness.updateCommand.join(" ")}\` failed.${detail ? ` ${detail.slice(-2_000)}` : ""}`,
      );
    }
  } else if (harness.npmPackage) {
    install(harness.npmPackage, {
      label: harness.displayName,
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(harness.npmInstallArgs ? { extraArgs: [...harness.npmInstallArgs] } : {}),
    });
  } else {
    throw new Error(
      `${harness.displayName} has no updater this router can run. Update it with: ` +
        `${(harness.manualInstall || [harness.siteUrl]).join("  |  ")}`,
    );
  }

  const updated = find(id);
  const to = updated ? version(id, updated) || null : null;
  return {
    harness: harness.id,
    binary: updated || null,
    from,
    to,
    // A client that reports no version at all cannot be said to have changed.
    // Saying "updated" on that evidence is the claim this router must not make.
    changed: Boolean(from && to && from !== to),
    versionReported: Boolean(to),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command = "status", id] = process.argv;
  try {
    if (command === "status" && !id) {
      process.stdout.write(
        `${JSON.stringify(routedHarnesses().map((harness) => routedHarnessSnapshot(harness.id)), null, 2)}\n`,
      );
    } else if (command === "status") {
      process.stdout.write(`${JSON.stringify(routedHarnessSnapshot(id), null, 2)}\n`);
    } else if (command === "install" && id) {
      process.stdout.write(
        `${JSON.stringify(installRoutedHarness(id, { force: process.argv.includes("--force") }), null, 2)}\n`,
      );
    } else if (command === "update" && id) {
      process.stdout.write(`${JSON.stringify(updateRoutedHarness(id), null, 2)}\n`);
    } else {
      console.error("Usage: routed-harness-install status [HARNESS]|install HARNESS [--force]|update HARNESS");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
