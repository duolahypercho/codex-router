import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

// `where.exe codex` on an npm global install lists the extensionless shell shim
// before the one Node can run:
//   ...\npm\codex       <- POSIX-style shim, listed first, NOT spawnable
//   ...\npm\codex.cmd   <- the batch shim that actually works
// existsSync() reports true for the first because Windows resolves it through
// PATHEXT, but execFileSync throws ENOENT on it without a shell. Choose an entry
// Node can execute instead of trusting the listed order.
const WINDOWS_SPAWNABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

export function preferSpawnablePath(paths, platform = process.platform) {
  const found = paths.map((value) => value.trim()).filter(Boolean);
  if (platform !== "win32") return found[0];
  for (const extension of WINDOWS_SPAWNABLE_EXTENSIONS) {
    const match = found.find((value) => value.toLowerCase().endsWith(extension));
    if (match) return match;
  }
  return found[0];
}

export function findCodexBinary() {
  const direct = candidates().find((candidate) => existsSync(candidate));
  if (direct) return direct;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    const output = execFileSync(finder, ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return preferSpawnablePath(output.split(/\r?\n/)) || undefined;
  } catch {
    return undefined;
  }
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

// A .cmd/.bat shim is a batch script, so Windows needs a shell to run it. The
// path is quoted because cmd.exe splits on spaces and Codex is routinely
// installed under a profile directory that contains them.
export function codexSpawnTarget(binary, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    return { command: `"${binary}"`, options: { shell: true } };
  }
  return { command: binary, options: {} };
}

export function runCodex(args, options = {}) {
  const { command, options: spawnOptions } = codexSpawnTarget(requireCodexBinary());
  return execFileSync(command, args, { ...spawnOptions, ...options });
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
  const { command, options } = codexSpawnTarget(binary);
  try {
    execFileSync(command, ["login", "status"], {
      ...options,
      timeout: 10_000,
      stdio: "ignore",
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
