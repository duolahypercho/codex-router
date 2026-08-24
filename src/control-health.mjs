import { readFileSync } from "node:fs";

import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";

const OFFLINE_ACTIVITY = Object.freeze({ state: "offline", active: [], activeCount: 0 });

function offlineHealth(error) {
  return {
    ok: false,
    status: 0,
    error,
    activity: { ...OFFLINE_ACTIVITY },
  };
}

function safeService(service) {
  if (!service || typeof service !== "object") return undefined;
  return {
    reachable: service.reachable === true,
    ...(typeof service.enabled === "boolean" ? { enabled: service.enabled } : {}),
  };
}

// Read the protected health leaf and project it to the stable, credential-free
// contract shared by the CLI, tray, and Electron Control Center. Callers may
// provide fetch/read seams for deterministic tests; production keeps the
// capability and its URL inside the trusted Node/Electron main process.
export async function readControlHealth({
  fetchImpl = globalThis.fetch,
  readCallerSecret = () => readFileSync(CALLER_SECRET_PATH, "utf8"),
  routerPort = PORTS.router,
  timeoutMs = 3_000,
} = {}) {
  let callerSecret;
  try {
    callerSecret = assertCallerSecret(readCallerSecret().trim());
  } catch {
    return offlineHealth("The local router caller key is unavailable.");
  }

  try {
    const response = await fetchImpl(`${callerBaseUrl(routerPort, callerSecret)}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.json().catch(() => ({}));
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      ok: response.ok,
      status: response.status,
      ...(typeof body.service === "string" ? { service: body.service } : {}),
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.router === "string" ? { router: body.router } : {}),
      ...(Array.isArray(body.degraded) ? { degraded: body.degraded } : {}),
      ...(body.activity && typeof body.activity === "object" ? { activity: body.activity } : {}),
      ...(safeService(body.gateway) ? { gateway: safeService(body.gateway) } : {}),
      ...(safeService(body.oauth) ? { oauth: safeService(body.oauth) } : {}),
      ...(safeService(body.api) ? { api: safeService(body.api) } : {}),
      ...(safeService(body.grokOauth) ? { grokOauth: safeService(body.grokOauth) } : {}),
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    return offlineHealth(timedOut ? "Health check timed out." : "Router is unreachable.");
  }
}
