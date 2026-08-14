import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

// macOS supervises the tray through launchd and Windows through Task
// Scheduler. Linux is still launched directly by bin/model-router-tray, so its
// commands succeed as no-ops rather than failing an install.
const SUPERVISORS = {
  darwin: "tray-service-macos.mjs",
  win32: "tray-service-windows.mjs",
};

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;

const command = process.argv[2] || "status";

const supervisor = SUPERVISORS[platform];
if (!supervisor) {
  // Still exit 0 -- an install must not fail over a companion this platform
  // does not supervise -- but say so. A bare {"supported":false} on stdout was
  // read as success by anyone running `control tray enable` and waiting for a
  // tray that was never going to appear.
  if (command !== "status") {
    process.stderr.write(
      `The tray is not supervised on ${platform}; launch it with ./bin/model-router-tray.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ installed: false, supported: false })}\n`);
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [path.join(SOURCE_ROOT, "src", supervisor), ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
