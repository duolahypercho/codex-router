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
// start.mjs allows the LiteLLM gateway 300s to cold start, so the readiness
// wait has to cover at least that. A shorter wait reports failure while the
// service is still booting, and the installer's rollback then uninstalls the
// service and reverts the app config out from under a router that goes on to
// come up healthy seconds later.
const READINESS_TIMEOUT_MS = 300_000;

async function runServiceCommand() {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (!readinessCommands.has(command)) return 0;

  const health = await waitForRouterHealth({ timeoutMs: READINESS_TIMEOUT_MS });
  if (health.ok) return 0;
  console.error(
    `Router did not become healthy within ${READINESS_TIMEOUT_MS / 1_000} seconds: ${health.error}`,
  );
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
