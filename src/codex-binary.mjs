import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isShimFile, resolveRealCodex } from "./codex-shim.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { commandOnPath, preferSpawnablePath, spawnableCommand } from "./spawnable-command.mjs";

export { preferSpawnablePath, spawnableCommand };

const LINUX_DESKTOP_APP_ROOTS = ["/opt/codex-desktop"];

export function linuxDesktopAppBundledCodex({
  platform = process.platform,
  roots = LINUX_DESKTOP_APP_ROOTS,
} = {}) {
  if (platform !== "linux") return undefined;
  return roots
    .map((root) => path.join(root, "resources", "codex"))
    .find((candidate) => existsSync(candidate) && !isShimFile(candidate));
}

// The ChatGPT/Codex desktop app bundles its CLI under a version-hashed
// directory, e.g. %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe. That hash
// changes on every app update, so scan for the newest installed version
// instead of pinning a single path.
function desktopAppBundledCodex({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (platform !== "win32") return undefined;
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

export function codexCandidatePaths({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  home = os.homedir(),
  linuxDesktopRoots,
} = {}) {
  return [
    process.env.CODEX_BIN,
    process.env.CODEX_INSTALL_DIR &&
      path.join(
        process.env.CODEX_INSTALL_DIR,
        platform === "win32" ? "codex.exe" : "codex",
      ),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    linuxDesktopAppBundledCodex({ platform, roots: linuxDesktopRoots }),
    "/usr/local/bin/codex",
    localAppData && path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "app", "bin", "codex.exe"),
    desktopAppBundledCodex({ platform, localAppData }),
    path.join(home, ".local", "bin", platform === "win32" ? "codex.exe" : "codex"),
  ].filter(Boolean);
}

function candidates() {
  return codexCandidatePaths();
}

// The router must never resolve `codex` to the shim it installs in front of it.
//
// The shim's job is to guarantee the router is listening before Codex starts,
// so it runs `control service start` when it finds the router down. Reaching it
// from inside the router turns that into a loop: the tray polls
// `control account` every 30 seconds, that spawns Codex through this function,
// and the shim revives the router the tray just stopped -- forever.
//
// Both resolution paths need the filter, not just PATH. `~/.local/bin` is a
// candidate below *and* a directory `chooseShimDirectory` may install into,
// because it restricts itself to the home directory.
export function findCodexBinary() {
  const direct = candidates().find(
    (candidate) => existsSync(candidate) && !isShimFile(candidate),
  );
  if (direct) return direct;
  // Never the raw first line of the finder: on Windows that is the
  // extensionless npm shim, which Node cannot spawn. See spawnable-command.mjs.
  const found = commandOnPath("codex");
  if (found && !isShimFile(found)) return found;
  // The finder landed on our own shim, so walk past it to the real Codex the
  // shim itself execs. When there is none, report none: handing back the shim
  // would rebuild the loop this filter exists to break.
  return resolveRealCodex()?.file;
}

export function codexBinaryFingerprint(binary = findCodexBinary()) {
  if (!binary) return undefined;
  try {
    const stats = statSync(binary);
    return createHash("sha256")
      .update(JSON.stringify({
        path: path.resolve(binary),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
      }))
      .digest("hex");
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

export function runCodex(args, options = {}) {
  const target = spawnableCommand(requireCodexBinary(), args);
  return execFileSync(target.command, target.args, {
    windowsHide: true,
    ...target.options,
    ...options,
  });
}

// The version is one compatibility signal for native catalog reuse, but
// Desktop can replace its version-hashed runtime binary without changing this
// string. codexBinaryFingerprint() supplies the complementary build identity.
// Undefined means "could not ask", which callers treat as unknown rather than
// as a mismatch.
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
  // `codex login status` is a credential probe, so --no-discovery skips the
  // spawn entirely. The distinct reason keeps this apart from "probe-failed":
  // the catalog treats it like a deliberate signed-out answer (publish no
  // native models) instead of refusing to rebuild.
  if (discoveryDisabled()) {
    return { authenticated: false, reason: "discovery-disabled" };
  }
  const binary = findCodexBinary();
  if (!binary) return { authenticated: false, reason: "codex-not-found" };
  try {
    // Inside the try: a path this module refuses to hand to a shell is a probe
    // that could not run, which is the "unknown" this function exists to
    // report -- not an exception for every caller to learn to expect.
    const target = spawnableCommand(binary, ["login", "status"]);
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
