import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordStep, SOURCE_ROOT, stepStatus } from "./install-plan.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

// A failure here is never a credential problem, and callers must not fold it
// into one: `npm ci` empties node_modules before it refills it, so a run that
// dies partway leaves the checkout unable to start the router at all. The tag
// lets a caller that is deliberately lenient about credential prompts stay
// strict about this.
export function isNodeDependencyFailure(error) {
  return Boolean(error?.nodeDependencyInstall);
}

function dependencyFailure(detail, options = {}) {
  return Object.assign(new Error(`Node dependency installation failed: ${detail}`), {
    ...options,
    nodeDependencyInstall: true,
  });
}

export function ensureNodeDependencies({
  root = SOURCE_ROOT,
  env = process.env,
  platform = process.platform,
} = {}) {
  // Package managers assemble this tree themselves. Mutating their prefix with
  // npm would violate the same ownership boundary enforced by bin/install --
  // and only Homebrew is known to have assembled it already, so every other
  // manager gets that script's refusal instead of a silent skip.
  const manager = env.CODEX_ROUTER_PACKAGE_MANAGER;
  if (manager === "homebrew") return "managed";
  if (manager) {
    throw dependencyFailure(
      `Reinstall the codex-router package managed by ${manager} to rebuild Node dependencies.`,
    );
  }
  if (stepStatus("node-deps", { root, platform }) === "skip") return "skip";

  const npm = commandOnPath("npm", { platform });
  if (!npm) throw dependencyFailure("npm is required and is normally included with Node.js.");
  process.stdout.write("Installing Node dependencies needed for credential setup...\n");
  const invocation = spawnableCommand(npm, ["ci", "--omit=dev"], platform);
  const result = spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw dependencyFailure(result.error.message, { cause: result.error });
  if (result.status !== 0) {
    // A signalled npm reports a null status, and "exited with status null"
    // hides which signal ended it.
    throw dependencyFailure(
      result.signal
        ? `npm ci was terminated by ${result.signal}.`
        : `npm ci exited with status ${result.status}.`,
    );
  }
  recordStep("node-deps", { root });
  return "installed";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureNodeDependencies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
