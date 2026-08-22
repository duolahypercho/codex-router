import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordStep, SOURCE_ROOT, stepStatus } from "./install-plan.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

export function ensureNodeDependencies({
  root = SOURCE_ROOT,
  env = process.env,
  platform = process.platform,
} = {}) {
  // Package managers assemble this tree themselves. Mutating their prefix with
  // npm would violate the same ownership boundary enforced by bin/install.
  if (env.CODEX_ROUTER_PACKAGE_MANAGER) return "managed";
  if (stepStatus("node-deps", { root, platform }) === "skip") return "skip";

  const npm = commandOnPath("npm", { platform });
  if (!npm) throw new Error("npm is required and is normally included with Node.js.");
  process.stdout.write("Installing Node dependencies needed for credential setup...\n");
  const invocation = spawnableCommand(npm, ["ci", "--omit=dev"], platform);
  const result = spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm dependency installation exited with status ${result.status}.`);
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
