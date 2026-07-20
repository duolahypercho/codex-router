import { PORTS, TARGET, loopback } from "./paths.mjs";

const url = process.argv[2] || loopback(PORTS.router, "/health");
const timeoutMs = Number(process.argv[3] || 30_000);
const deadline = Date.now() + timeoutMs;
let lastError = "service unavailable";
const expectedService = TARGET === "claude" ? "claude-router" : "codex-router";

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (response.ok) {
      const body = await response.text();
      const payload = JSON.parse(body);
      if (payload.service === expectedService) {
        process.stdout.write(`${body}\n`);
        process.exit(0);
      }
      lastError = "a different service is listening on the router port";
    } else {
      lastError = `HTTP ${response.status}`;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.error(`Timed out waiting for ${url}: ${lastError}`);
process.exit(1);
