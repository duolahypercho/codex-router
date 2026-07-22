import { PORTS, loopback } from "./paths.mjs";
import { waitForRouterHealth } from "./router-health.mjs";

const url = process.argv[2] || loopback(PORTS.router, "/health");
const timeoutMs = Number(process.argv[3] || 30_000);
const health = await waitForRouterHealth({ url, timeoutMs });
if (health.ok) {
  process.stdout.write(`${JSON.stringify(health.payload)}\n`);
  process.exit(0);
}
console.error(`Timed out waiting for ${url}: ${health.error}`);
process.exit(1);
