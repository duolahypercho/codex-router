import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readInstallManifest } from "./install-manifest.mjs";
import { SOURCE_ROOT, TARGET } from "./paths.mjs";

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", SOURCE_ROOT, ...args], {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function requireManagedCheckout() {
  if (!existsSync(path.join(SOURCE_ROOT, ".git"))) {
    throw new Error(
      "This release is not a Git checkout. Re-run the installation command to upgrade it.",
    );
  }
  const origin = git(["remote", "get-url", "origin"]);
  const configured = process.env.CODEX_ROUTER_REPOSITORY_URL;
  const allowed = new Set([
    configured,
    "https://github.com/duolahypercho/codex-router",
    "https://github.com/duolahypercho/codex-router.git",
    "git@github.com:duolahypercho/codex-router.git",
  ].filter(Boolean));
  if (!allowed.has(origin)) {
    throw new Error(`The origin remote is not a recognized Codex Router repository: ${origin}`);
  }
}

// Exported so the Windows bootstrap installer, which reimplements this refusal
// in PowerShell and cannot import it, can be tested against the same number.
export const DIRTY_PREVIEW_LIMIT = 10;

// Only tracked edits are at stake. A fast-forward merge never replaces an
// untracked file, and git refuses the rare collision on its own with a precise
// message, so counting untracked files as "local changes" only ever stranded
// people: one stray file in the checkout and every future update was refused,
// with nothing in the error to say which file or how to get past it.
export function localModifications() {
  return git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function localModificationsMessage(changes, sourceRoot = SOURCE_ROOT) {
  const preview = changes
    .slice(0, DIRTY_PREVIEW_LIMIT)
    .map((line) => `  ${line}`)
    .join("\n");
  const remainder = changes.length - DIRTY_PREVIEW_LIMIT;
  return [
    `The checkout has local changes to ${changes.length} tracked file${
      changes.length === 1 ? "" : "s"
    }; refusing to replace them during update:`,
    preview,
    ...(remainder > 0 ? [`  ...and ${remainder} more`] : []),
    "",
    `Keep them:    git -C ${sourceRoot} stash`,
    "Discard them: re-run the same command with --force",
  ].join("\n");
}

// Called only where the checkout is actually about to be rewritten, so a
// checkout with edits still answers "is an update available?" and still
// reinstalls at the same commit.
function requireReplaceableCheckout(force) {
  const changes = localModifications();
  if (changes.length === 0) return;
  if (!force) throw new Error(localModificationsMessage(changes));
  git(["reset", "--hard", "HEAD"], { inherit: true });
}

export function currentCheckoutInstaller(platform = process.platform, target = TARGET) {
  return platform === "win32"
    ? {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(SOURCE_ROOT, "install.ps1"),
          "-CheckoutInstall",
          "-Target",
          target,
        ],
      }
    : { command: path.join(SOURCE_ROOT, "bin", "install"), args: [] };
}

function installCurrentCheckout() {
  const installer = currentCheckoutInstaller();
  const result = spawnSync(installer.command, installer.args, {
    cwd: SOURCE_ROOT,
    stdio: "inherit",
    env: { ...process.env, MODEL_ROUTER_TARGET: TARGET },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Installer exited with status ${result.status}.`);
  }
}

function registeredTrayBundlePath() {
  try {
    const value = execFileSync(
      "defaults",
      [
        "read",
        "io.github.codex-router.tray",
        "ModelRouterTray.loginItemBundlePath",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function trayRefreshRequired({
  platform = process.platform,
  home = os.homedir(),
  sourceRoot = SOURCE_ROOT,
  registeredPath,
} = {}) {
  if (platform !== "darwin") return false;
  const registered = registeredPath ?? registeredTrayBundlePath();
  const candidates = [
    path.join(sourceRoot, "dist", "Model Router.app"),
    path.join(home, "Applications", "Model Router.app"),
  ];
  return (
    candidates.some((candidate) => existsSync(candidate)) ||
    Boolean(registered && existsSync(registered))
  );
}

// The tray is rebuilt from the same checkout that owns the router, so an
// update never leaves a stale companion binary behind. Best-effort: the router
// update itself succeeded, and a failed tray refresh must not roll it back.
function refreshTrayCompanion() {
  if (!trayRefreshRequired()) return;
  const launcher = path.join(SOURCE_ROOT, "bin", "model-router-tray");
  const result = spawnSync(launcher, [], { cwd: SOURCE_ROOT, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Menu-bar companion refresh did not finish: ${result.error.message}\n`);
  } else if (result.status !== 0) {
    process.stderr.write(`Menu-bar companion refresh exited with status ${result.status}.\n`);
  }
}

function revisionExists(revision) {
  try {
    git(["cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function restoreRevision(revision) {
  git(["switch", "--detach", revision], { inherit: true });
  installCurrentCheckout();
}

export function checkForUpdate() {
  requireManagedCheckout();
  git(["fetch", "--quiet", "origin", "main"]);
  const current = git(["rev-parse", "HEAD"]);
  const available = git(["rev-parse", "origin/main"]);
  return { current, available, updateAvailable: current !== available };
}

export function installationNeedsRefresh(manifest, revision) {
  return manifest?.current?.commit !== revision;
}

export function updateCheckout({ force = false } = {}) {
  const status = checkForUpdate();
  if (!status.updateAvailable) {
    if (!installationNeedsRefresh(readInstallManifest(), status.current)) {
      return { ...status, updated: false, reinstalled: false };
    }
    installCurrentCheckout();
    refreshTrayCompanion();
    return { ...status, updated: false, reinstalled: true };
  }
  requireReplaceableCheckout(force);
  let branch = git(["branch", "--show-current"]);
  if (!branch) {
    git(["switch", "main"], { inherit: true });
    branch = "main";
  }
  if (branch !== "main") {
    throw new Error("Updates require the managed checkout to be on its main branch.");
  }
  git(["update-ref", "refs/codex-router/rollback", status.current]);
  git(["merge", "--ff-only", status.available], { inherit: true });
  try {
    installCurrentCheckout();
    refreshTrayCompanion();
  } catch (error) {
    try {
      restoreRevision(status.current);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Update failed and automatic rollback also failed. The previous commit is ${status.current}.`,
      );
    }
    throw new Error(
      `Update failed; Codex Router was restored to ${status.current.slice(0, 12)}.`,
      { cause: error },
    );
  }
  return { ...status, updated: true, reinstalled: true };
}

export function rollbackCheckout({ force = false } = {}) {
  requireManagedCheckout();
  // A rollback checks out a different revision, so it overwrites tracked edits
  // exactly the way an update does.
  requireReplaceableCheckout(force);
  const current = git(["rev-parse", "HEAD"]);
  let target;
  try {
    target = git(["rev-parse", "refs/codex-router/rollback"]);
  } catch {
    target = readInstallManifest()?.history?.find((entry) => entry.commit)?.commit;
  }
  if (!target || !revisionExists(target)) {
    throw new Error("No locally cached working revision is available to roll back to.");
  }
  if (target === current) throw new Error("The rollback revision is already installed.");
  git(["update-ref", "refs/codex-router/rollback", current]);
  try {
    restoreRevision(target);
  } catch (error) {
    try {
      restoreRevision(current);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Rollback failed and the current revision could not be restored (${current}).`,
      );
    }
    throw error;
  }
  return { rolledBack: true, from: current, to: target };
}

const COMMANDS = {
  check: checkForUpdate,
  update: updateCheckout,
  rollback: rollbackCheckout,
};

// `check` must stay read-only: the tray and the CLI both use it to answer "is
// an update available?" without touching the installation.
export function resolveCommand(args) {
  return COMMANDS[args.find((argument) => !argument.startsWith("--")) || "update"];
}

// A bare `update --force` has to keep working, so the flag is stripped before
// the subcommand is read rather than being taken for one.
export function parseArguments(args) {
  return { command: resolveCommand(args), force: args.includes("--force") };
}

async function main() {
  const { command, force } = parseArguments(process.argv.slice(2));
  if (!command) {
    console.error("Usage: update.mjs check|update|rollback [--force]");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(command({ force }), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
