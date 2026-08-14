import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

// Installing a third-party CLI globally through npm, and finding the binary
// afterwards. Extracted from provider-onboarding.mjs when the harness needed
// the same three steps: a second copy would have drifted on exactly the details
// that took a debugging session to get right the first time -- the PATH the
// spawn inherits, where npm actually drops binaries per platform, and which
// line of npm's output is the one worth showing somebody.

// Node's own directory has to be on PATH for the npm shim to find the runtime
// it re-execs. A launchd/systemd service inherits neither a login shell's PATH
// nor a terminal's.
export function spawnEnvironment() {
  const nodeDir = path.dirname(process.execPath);
  const existing = process.env.PATH || "";
  if (existing.split(path.delimiter).includes(nodeDir)) return process.env;
  return { ...process.env, PATH: existing ? `${nodeDir}${path.delimiter}${existing}` : nodeDir };
}

export function npmPath() {
  // Not the finder's first line: on Windows that is the extensionless npm
  // shim, and every caller here goes on to spawn what it gets back.
  const discovered = commandOnPath("npm");
  if (discovered) return discovered;
  const candidates = [
    path.join(os.homedir(), ".npm-global", "bin", "npm"),
    path.join(os.homedir(), ".local", "bin", "npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

// Resolved at most once per process: the tray refreshes its snapshots on a
// timer, and an npm spawn per unconfigured CLI per refresh would be felt.
// `undefined` is a real answer here, so the miss is cached too.
let npmGlobalBinDir;
export function readNpmGlobalBinDir() {
  const npm = npmPath();
  if (!npm) return undefined;
  try {
    const npmPrefix = spawnableCommand(npm, ["prefix", "-g"]);
    const prefix = execFileSync(npmPrefix.command, npmPrefix.args, {
      ...npmPrefix.options,
      encoding: "utf8",
      env: spawnEnvironment(),
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (!prefix) return undefined;
    // npm drops binaries straight into the prefix on Windows and into
    // prefix/bin everywhere else.
    return process.platform === "win32" ? prefix : path.join(prefix, "bin");
  } catch {
    return undefined;
  }
}

export function npmGlobalBinary(executable) {
  if (npmGlobalBinDir === undefined) {
    npmGlobalBinDir = readNpmGlobalBinDir() ?? "";
  }
  if (!npmGlobalBinDir) return undefined;
  const candidate = path.join(npmGlobalBinDir, executable);
  return existsSync(candidate) ? candidate : undefined;
}

// npm prints its diagnosis over several lines and ends with log-file paths
// that mean nothing in a tray dialog; the last real line is the useful one.
export function installFailureDetail(result) {
  if (result.error) return result.error.message;
  const lines = `${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.replace(/^npm (error|ERR!)\s*/i, "").trim())
    .filter((line) => line && !/^[A-Za-z]?:?[\\/].*\.log$/.test(line));
  const detail = lines[lines.length - 1];
  return detail ? `npm said: ${detail}` : `npm exited with status ${result.status}.`;
}

// Throws with the reason rather than the fact: "EACCES on /usr/local/lib" and
// "network unreachable" need opposite fixes, and a bare "could not install"
// sent the last one of these into a debugging session.
export function npmInstallGlobal(npmPackage, { label = npmPackage, timeoutMs } = {}) {
  const npm = npmPath();
  if (!npm) throw new Error("Node.js and npm are required to install this CLI.");
  const install = spawnableCommand(npm, ["install", "-g", npmPackage]);
  const result = spawnSync(install.command, install.args, {
    ...install.options,
    windowsHide: true,
    encoding: "utf8",
    env: spawnEnvironment(),
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not install ${label}. ${installFailureDetail(result)}`.trim());
  }
  // A fresh install lands in a directory this process may have already probed
  // and cached as empty, so forget the answer rather than report the binary
  // missing straight after installing it.
  npmGlobalBinDir = undefined;
}
