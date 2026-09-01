import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  npmGlobalBinary,
  npmInstallGlobal,
  npmPath,
  spawnEnvironment,
} from "./npm-global-install.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

export const OPENCLAW_NPM_PACKAGE = "openclaw@latest";
export const OPENCLAW_EXECUTABLE = "openclaw";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;

function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number.parseInt(part || "0", 10)) : undefined;
}

export function nodeMeetsOpenClawMinimum(version = process.versions.node) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor, patch] = parsed;
  if (major >= 26) return true;
  if (major === 25) return minor > 9 || (minor === 9 && patch >= 0);
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 23) return false;
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3);
  return false;
}

export function assertOpenClawNodeSupported(version = process.versions.node) {
  if (!nodeMeetsOpenClawMinimum(version)) {
    throw new Error(
      `OpenClaw needs Node 22.22.3+, 24.15+, 25.9+, or 26+; this router is running Node ${version}. Upgrade Node, then install again.`,
    );
  }
  return version;
}

export function npmSupportsOpenClawAllowScripts(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major >= 12 || (major === 11 && minor >= 16);
}

export function npmVersion(binary = npmPath()) {
  if (!binary) return undefined;
  try {
    const command = spawnableCommand(binary, ["--version"]);
    return String(execFileSync(command.command, command.args, {
      ...command.options,
      encoding: "utf8",
      env: spawnEnvironment(),
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })).trim().split(/\r?\n/, 1)[0] || undefined;
  } catch {
    return undefined;
  }
}

export function openclawCliPath() {
  const configured = process.env.OPENCLAW_BIN;
  if (configured && existsSync(configured)) return configured;
  return commandOnPath(OPENCLAW_EXECUTABLE) || npmGlobalBinary(OPENCLAW_EXECUTABLE);
}

export function openclawVersion(binary = openclawCliPath()) {
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
    return String(output || "").split(/\r?\n/).map((line) => line.trim())
      .find((line) => /\d+\.\d+\.\d+/.test(line)) || undefined;
  } catch {
    return undefined;
  }
}

export function openclawSnapshot() {
  const binary = openclawCliPath();
  return {
    package: OPENCLAW_NPM_PACKAGE,
    installed: Boolean(binary),
    binary,
    version: openclawVersion(binary),
    nodeVersion: process.versions.node,
    nodeSupported: nodeMeetsOpenClawMinimum(),
  };
}

export function installOpenClaw({
  force = false,
  find = openclawCliPath,
  install = npmInstallGlobal,
  nodeVersion = process.versions.node,
  detectedNpmVersion,
} = {}) {
  assertOpenClawNodeSupported(nodeVersion);
  const existing = find();
  if (existing && !force) return { installed: true, binary: existing, changed: false };

  const effectiveNpmVersion = detectedNpmVersion ?? npmVersion();

  install(OPENCLAW_NPM_PACKAGE, {
    label: "OpenClaw",
    timeoutMs: INSTALL_TIMEOUT_MS,
    extraArgs: npmSupportsOpenClawAllowScripts(effectiveNpmVersion)
      ? ["--allow-scripts=openclaw"]
      : [],
  });
  const binary = find();
  if (!binary) {
    throw new Error(
      `npm installed ${OPENCLAW_NPM_PACKAGE}, but no \`${OPENCLAW_EXECUTABLE}\` was found on PATH or in npm's global bin directory.`,
    );
  }
  return { installed: true, binary, changed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  try {
    const value = command === "install"
      ? installOpenClaw({ force: process.argv.includes("--force") })
      : command === "status"
        ? openclawSnapshot()
        : command === "preflight"
          ? { nodeVersion: assertOpenClawNodeSupported(), nodeSupported: true }
        : undefined;
    if (!value) {
      console.error("Usage: openclaw-install install [--force]|status|preflight");
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
