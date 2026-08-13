import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandOnPath, preferSpawnablePath, spawnableCommand } from "./spawnable-command.mjs";

export { preferSpawnablePath, spawnableCommand };

// The ChatGPT/Codex desktop app bundles its CLI under a version-hashed
// directory, e.g. %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe. That hash
// changes on every app update, so scan for the newest installed version
// instead of pinning a single path.
function desktopAppBundledCodex() {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(binDir)) return undefined;
  try {
    return readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binDir, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

function candidates() {
  const localAppData = process.env.LOCALAPPDATA;
  return [
    process.env.CODEX_BIN,
    process.env.CODEX_INSTALL_DIR &&
      path.join(
        process.env.CODEX_INSTALL_DIR,
        process.platform === "win32" ? "codex.exe" : "codex",
      ),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    localAppData && path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "app", "bin", "codex.exe"),
    desktopAppBundledCodex(),
    path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex"),
  ].filter(Boolean);
}

export function findCodexBinary() {
  const direct = candidates().find((candidate) => existsSync(candidate));
  if (direct) return direct;
  // Never the raw first line of the finder: on Windows that is the
  // extensionless npm shim, which Node cannot spawn. See spawnable-command.mjs.
  return commandOnPath("codex");
}

export function requireCodexBinary() {
  const binary = findCodexBinary();
  if (!binary) {
    throw new Error(
      "The Codex binary was not found. Install Codex or set CODEX_BIN to its CLI binary.",
    );
  }
  return binary;
}

export function runCodex(args, options = {}) {
  const target = spawnableCommand(requireCodexBinary(), args);
  return execFileSync(target.command, target.args, {
    windowsHide: true,
    ...target.options,
    ...options,
  });
}

// The version tells catalog code whether a cached native capture came from
// the currently installed build. Undefined means "could not ask", which
// callers must treat as unknown rather than as a mismatch.
export function codexVersion() {
  try {
    const output = runCodex(["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Failing to *run* Codex is not evidence that the user is signed out. The two
// used to be indistinguishable, so one Windows spawn error silently stripped
// every native model from the catalog. Report the reason so callers can refuse
// to act on an unknown instead of treating it as a definite "logged out".
export function codexAuthStatus() {
  const binary = findCodexBinary();
  if (!binary) return { authenticated: false, reason: "codex-not-found" };
  const target = spawnableCommand(binary, ["login", "status"]);
  try {
    execFileSync(target.command, target.args, {
      ...target.options,
      timeout: 10_000,
      stdio: "ignore",
      windowsHide: true,
    });
    return { authenticated: true, reason: "authenticated", binary };
  } catch (error) {
    // A numeric status means Codex ran and reported a signed-out session.
    // Anything else (ENOENT, EACCES, timeout) means the probe never completed.
    const probeFailed = typeof error?.status !== "number";
    return {
      authenticated: false,
      reason: probeFailed ? "probe-failed" : "signed-out",
      binary,
      ...(probeFailed && error?.code ? { code: error.code } : {}),
    };
  }
}

export function codexIsAuthenticated() {
  return codexAuthStatus().authenticated;
}
