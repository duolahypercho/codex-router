import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = String.raw`
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";
const [root, entry] = process.argv.slice(1);
process.argv[1] = path.join(root, "test", entry);
const { freePort } = await import(pathToFileURL(path.join(root, "test", "port-pool.mjs")));
const ports = [];
for (let index = 0; index < 75; index += 1) ports.push(await freePort());
assert.equal(new Set(ports).size, 75);
// Use the production kernel bind helper with a concurrently owned fixture
// listener. An old 10000-19999 allocation denies this valid token lease.
const { startAntigravityOwnerServerForTests } = await import(pathToFileURL(path.join(root, "src", "antigravity-oauth-session.mjs")));
const fixture = createServer();
let lease;
await new Promise((resolve) => fixture.listen(ports[0], "127.0.0.1", resolve));
try {
  lease = await startAntigravityOwnerServerForTests({ host: "127.0.0.1", port: 10000 + ports[0] % 10000, exclusive: true });
} finally {
  if (lease) await new Promise((resolve) => lease.close(resolve));
  await new Promise((resolve) => fixture.close(resolve));
}
for (const port of ports) {
  assert.ok(port < 10000 || port >= 30000, "fixture port overlaps a POSIX credential lease: " + port);
  assert.ok(port >= 5000 && port < 32768, "fixture port overlaps managed/system or ephemeral ports");
}
process.stdout.write(JSON.stringify(ports));
`;

test("large integration files have disjoint ports outside POSIX credential leases", () => {
  const issued = [];
  for (const entry of ["gateway-restart.test.mjs", "routing.test.mjs"]) {
    const ports = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", driver, root, entry], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000,
    }));
    issued.push(...ports);
  }
  assert.equal(new Set(issued).size, issued.length, "different integration files share a port");
  assert.ok(issued.some((port) => port < 10000), "lower segment was not exercised");
  assert.ok(issued.some((port) => port >= 30000), "upper segment was not exercised");
});
