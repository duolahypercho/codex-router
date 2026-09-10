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
  install(harness.npmPackage, { label: harness.displayName, timeoutMs: INSTALL_TIMEOUT_MS });
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
    } else {
      console.error("Usage: routed-harness-install status [HARNESS]|install HARNESS [--force]");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
