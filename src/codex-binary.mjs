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
      // explicit `.cmd`/`.exe` entries it also returns so callers get a
      // directly executable path.
      return (
        found.find((candidate) => candidate.toLowerCase().endsWith(".cmd")) ||
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

export function codexIsAuthenticated() {
  const binary = findCodexBinary();
  if (!binary) return false;
  const options = { timeout: 10_000, stdio: "ignore" };
  try {
    // On Windows, npm-installed CLIs resolve to a `.cmd` shim, which Node
    // cannot spawn without a shell (throws ENOENT/EINVAL, silently
    // misreporting the user as logged out and dropping native OpenAI models
    // from the merged catalog). Mirror the shell:true handling already used
    // by catalog.execCodex().
    if (process.platform === "win32" && binary.toLowerCase().endsWith(".cmd")) {
      execFileSync(binary, ["login", "status"], { ...options, shell: true });
    } else {
      execFileSync(binary, ["login", "status"], options);
    }
    return true;
  } catch {
    return false;
  }
}
