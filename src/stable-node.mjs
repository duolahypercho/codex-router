import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

// Which Node binary to name in anything written down for later -- Codex's
// caller auth command, a launcher script, a service definition -- or spawned
// from a process that outlives an upgrade. `process.execPath` is the wrong
// answer on a Homebrew install: Node resolves it through `bin/node` to the
// versioned keg (`<prefix>/Cellar/node/26.9.0/bin/node`), and `brew upgrade
// node` deletes that keg. A recorded path then names nothing, and Codex fails
// to run its auth command on every routed turn until something rewrites it.
// The formula's `opt` link follows every upgrade, which is why the Homebrew
// formula for this router pins CODEX_ROUTER_NODE_BIN to exactly that path.
const HOMEBREW_KEG_NODE = /^(\/.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

// A regular file this user may execute. A directory or a data file named in
// CODEX_ROUTER_NODE_BIN exists, and recording it would fail on first use.
export function runnableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The stable `opt` spelling of a versioned Homebrew keg's Node, when that link
// exists; any other path is returned unchanged. The link belongs to the same
// formula, so a keg-only `node@22` stays on node@22 rather than on `node`.
export function homebrewStableNodePath(nodePath, { exists = runnableFile } = {}) {
  const match = HOMEBREW_KEG_NODE.exec(String(nodePath || ""));
  if (!match) return nodePath;
  const stable = `${match[1]}/opt/${match[2]}/bin/node`;
  return exists(stable) ? stable : nodePath;
}

// An explicit, existing CODEX_ROUTER_NODE_BIN wins; then this process's own
// Node unless it is an Electron host, whose binary would start a second app
// instead of running a script; then the usual install locations. Every
// candidate goes through homebrewStableNodePath, and a keg that is already
// gone still resolves to its formula's current Node.
export function stableNodeBinary({
  execPath = process.execPath,
  electron = Boolean(process.versions.electron),
  environment = process.env,
  exists = runnableFile,
} = {}) {
  const usable = (candidate) => {
    if (!candidate || !path.isAbsolute(candidate)) return undefined;
    const stable = homebrewStableNodePath(candidate, { exists });
    return exists(stable) ? stable : undefined;
  };
  const configured = usable(environment.CODEX_ROUTER_NODE_BIN);
  if (configured) return configured;
  if (!electron) {
    const own = usable(execPath);
    if (own) return own;
  }

  const executable = process.platform === "win32" ? "node.exe" : "node";
  const directories = new Set(
    String(environment.PATH || "").split(path.delimiter).filter(path.isAbsolute),
  );
  for (const directory of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    process.platform === "win32" && environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "nodejs")
      : undefined,
  ]) {
    if (directory) directories.add(directory);
  }
  for (const directory of directories) {
    const candidate = usable(path.join(directory, executable));
    if (candidate) return candidate;
  }
  throw new Error("Node.js is unavailable; install Node.js 22 or newer.");
}

// For a child started now rather than recorded for later: this process's own
// Node, as every such spawn used before -- a real binary, never a launcher or
// a version-manager shim -- with a keg mapped to its opt link, which is still
// there after an upgrade deleted the keg this process runs from. Only when
// that fails, or under an Electron host, is the wider search used, and failing
// that this process's own binary again, which the caller's
// ELECTRON_RUN_AS_NODE environment turns back into Node.
export function childNodeBinary({
  execPath = process.execPath,
  electron = Boolean(process.versions.electron),
  environment = process.env,
  exists = runnableFile,
} = {}) {
  if (!electron && path.isAbsolute(execPath)) {
    const own = homebrewStableNodePath(execPath, { exists });
    if (exists(own)) return own;
  }
  try {
    return stableNodeBinary({ execPath, electron, environment, exists });
  } catch {
    return execPath;
  }
}
