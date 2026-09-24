import { spawn } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT, TARGET } from "./paths.mjs";
import { routerNodeBinary } from "./node-runtime.mjs";
import { nextQuotaCooldownExpiry } from "./provider-cooldown.mjs";

const MIN_TIMER_MS = 250;
const MAX_TIMER_MS = 2_147_000_000;
let refreshChild;
let refreshQueued = false;
let resetTimer;

function disabled() {
  return process.env.CODEX_ROUTER_DISABLE_SUBAGENT_AVAILABILITY_SYNC === "1";
}

function armResetTimer(now = Date.now()) {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = undefined;
  const expiresAt = nextQuotaCooldownExpiry({ now });
  if (expiresAt === undefined) return;
  const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, expiresAt - now + 50));
  resetTimer = setTimeout(() => refreshSubagentAvailability(), delay);
  resetTimer.unref?.();
}

// Rebuild only the local catalog/managed agent definitions. This never changes
// the operator's subagent preference file and never contacts a model provider.
// Calls coalesce so a burst of concurrent quota failures produces one rebuild.
export function refreshSubagentAvailability() {
  if (disabled()) return;
  if (refreshChild) {
    refreshQueued = true;
    return;
  }
  refreshChild = spawn(routerNodeBinary(), [path.join(SOURCE_ROOT, "src", "catalog.mjs")], {
    cwd: SOURCE_ROOT,
    env: { ...process.env, MODEL_ROUTER_TARGET: TARGET },
    stdio: "ignore",
  });
  refreshChild.unref();
  refreshChild.once("exit", () => {
    refreshChild = undefined;
    if (refreshQueued) {
      refreshQueued = false;
      refreshSubagentAvailability();
      return;
    }
    armResetTimer();
  });
}

export function startSubagentAvailabilitySync() {
  if (disabled()) return;
  refreshSubagentAvailability();
}
