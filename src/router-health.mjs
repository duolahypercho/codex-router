import { PORTS, TARGET, loopback } from "./paths.mjs";

const SERVICE_BY_TARGET = {
  codex: "codex-router",
  cursor: "cursor-router",
};

export async function waitForRouterHealth({
  target = TARGET,
  url = loopback(PORTS.router, "/health"),
  timeoutMs = 30_000,
  requestTimeoutMs = 1_000,
  intervalMs = 250,
  fetchImpl = fetch,
} = {}) {
  const expectedService = SERVICE_BY_TARGET[target];
  if (!expectedService) throw new Error(`Unknown router target: ${target}`);

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
