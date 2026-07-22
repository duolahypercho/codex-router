import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const script = {
  darwin: "service-macos.mjs",
  linux: "service-linux.mjs",
  win32: "service-windows.mjs",
}[platform];

if (!script) {
  throw new Error(`Unsupported background-service platform: ${platform}`);
}

const command = process.argv[2] || "status";
const mutatingCommands = new Set(["install", "uninstall", "start", "stop", "restart"]);
const readinessCommands = new Set(["install", "start", "restart"]);

async function runServiceCommand() {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (!readinessCommands.has(command)) return 0;

  const health = await waitForRouterHealth();
  if (health.ok) return 0;
  console.error(`Router did not become healthy within 30 seconds: ${health.error}`);
  return 1;
}

try {
  const status = mutatingCommands.has(command)
    ? await withServiceOperationLock(runServiceCommand)
    : await runServiceCommand();
  process.exit(status);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
