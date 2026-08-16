import { PORTS, ROUTER_PLANE_TARGET, TARGET, loopback } from "./paths.mjs";

// The name the router reports on `/health`. It identifies the *service*, which
// is one process shared by every client integration, so it is keyed on the
// router plane rather than on whichever client this command was invoked for.
// Keying it on the client made a second integration look like a foreign
// process squatting on the router port.
const SERVICE_BY_TARGET = {
  [ROUTER_PLANE_TARGET]: "codex-router",
};
// Every client this router publishes to. The set only guards against a typo in
// a caller's `target` argument -- the health check itself is keyed on the plane
// above, because one process serves all of them. It has to be extended
// alongside `supportedTargets` in paths.mjs; a target missing here fails
// `doctor` and `wait-health` with "Unknown router target" long before anything
// about the integration itself is exercised.
const SUPPORTED_TARGETS = new Set(["codex", "dsh", "gemini"]);

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
  // A router that answers but reports a dependency down is a different failure
  // from a router that is not listening, and only the first one is survivable
  // (the gateway is restarted in place). Keep the last such payload so the
  // caller can say which of the two happened instead of "not ready".
  let lastPayload;
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
      } else if (payload.service === expectedService) {
        lastPayload = payload;
        const down = Array.isArray(payload.degraded) ? payload.degraded : [];
        lastError = down.length
          ? `it is listening but reports ${down.join(", ")} unreachable (HTTP ${response.status})`
          : `it is listening but answered HTTP ${response.status}`;
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

  return { ok: false, error: lastError, degradedPayload: lastPayload };
}
