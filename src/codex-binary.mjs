import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
    path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex"),
  ].filter(Boolean);
}

export function findCodexBinary() {
  const direct = candidates().find((candidate) => existsSync(candidate));
  if (direct) return direct;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    const found = execFileSync(finder, ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\r?\n/).filter(Boolean);
    if (process.platform === "win32") {
      // `where codex` lists the extensionless npm shim first (e.g.
      // `...\npm\codex`), which Node cannot spawn directly. Prefer the
      // explicit `.cmd`/`.bat`/`.exe` entries it also returns so callers get
      // a directly executable path.
      return (
        found.find((candidate) => /\.(cmd|bat)$/i.test(candidate)) ||
        found.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ||
        found[0]
      );
    }
    return found[0];
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

// On Windows, npm-installed CLIs resolve to a `.cmd`/`.bat` shim, which Node
// cannot spawn without a shell (throws ENOENT/EINVAL). Centralize that handling
// here so every codex invocation goes through one path. `findCodexBinary()`
// already prefers the explicit shim, so callers can pass the resolved binary
// through without re-checking the extension.
export function runCodex(args, options = {}) {
  const binary = requireCodexBinary();
  const merged = { ...options };
  const needsShell =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  if (needsShell && merged.shell === undefined) {
    merged.shell = true;
  }
  // With shell:true, Node concatenates file+args without quoting, so a path
  // containing spaces (e.g. C:\Users\John Smith\...) would split into two
  // tokens and fail. Quote the command; cmd.exe /d /s /c strips the outer
  // quotes correctly, and this branch is Windows-only.
  return execFileSync(merged.shell ? `"${binary}"` : binary, args, merged);
}

export function codexIsAuthenticated() {
  const binary = findCodexBinary();
  if (!binary) return false;
  try {
    runCodex(["login", "status"], { timeout: 10_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
