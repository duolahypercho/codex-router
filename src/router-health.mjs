import { PORTS, ROUTER_PLANE_TARGET, TARGET, loopback } from "./paths.mjs";

// The name the router reports on `/health`. It identifies the *service*, which
// is one process shared by every client integration, so it is keyed on the
// router plane rather than on whichever client this command was invoked for.
// Keying it on the client made a second integration look like a foreign
// process squatting on the router port.
const SERVICE_BY_TARGET = {
  [ROUTER_PLANE_TARGET]: "codex-router",
};
const SUPPORTED_TARGETS = new Set(["codex", "dsh"]);

export async function waitForRouterHealth({
  target = TARGET,
  url = loopback(PORTS.router, "/health"),
  timeoutMs = 30_000,
  requestTimeoutMs = 4_000,
  intervalMs = 250,
  fetchImpl = fetch,
} = {}) {
  if (!SUPPORTED_TARGETS.has(target)) throw new Error(`Unknown router target: ${target}`);
  const expectedService = SERVICE_BY_TARGET[ROUTER_PLANE_TARGET];

  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError = "service unavailable";
  do {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const body = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        lastError = "health response was not JSON";
      }
      if (response.ok && payload.service === expectedService) {
        return { ok: true, payload };
      }
      if (payload.service && payload.service !== expectedService) {
        lastError = `a different service (${payload.service}) is listening on the router port`;
      } else if (response.status) {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  } while (Date.now() <= deadline);

  return { ok: false, error: lastError };
}
