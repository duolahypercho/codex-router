import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const poolName = "port-pool.mjs";
const source = path.join(path.dirname(fileURLToPath(import.meta.url)), poolName);
const driver = `
import path from "node:path";
import { pathToFileURL } from "node:url";
const [directory, entry, count] = process.argv.slice(1);
process.argv[1] = path.join(directory, entry);
const { freePort } = await import(pathToFileURL(path.join(directory, ${JSON.stringify(poolName)})));
const ports = [];
for (let index = 0; index < Number(count); index++) ports.push(await freePort());
process.stdout.write(JSON.stringify(ports));
`;

function fixture(t, { ordinary = 60, reserved = 1, size = 256 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "port-capacity-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith("port-capacity-"));
    rmSync(directory, { recursive: true, force: true });
  });
  copyFileSync(source, path.join(directory, poolName));
  // Fixture consumer text must not make this driver a real pool consumer.
  const dependency = `import "./${poolName}";\n`;
  for (let index = 0; index < reserved; index++) {
    writeFileSync(path.join(directory, `aaa-large-${index}.test.mjs`), `// port-pool block-size: ${size}\n${dependency}`);
  }
  for (let index = 0; index < ordinary; index++) {
    writeFileSync(path.join(directory, `ordinary-${index}.test.mjs`), dependency);
  }
  return (entry, count) => spawnSync(process.execPath, ["--input-type=module", "-e", driver, directory, entry, String(count)], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
}

test("adding consumers cannot shrink a declared large block or overlap ordinary allocations", (t) => {
  for (const [ordinaryCount, needed] of [[60, 75], [230, 32]]) {
    const draw = fixture(t, { ordinary: ordinaryCount });
    const large = draw("aaa-large-0.test.mjs", 200);
    assert.equal(large.status, 0, large.stderr);
    const ordinary = draw("ordinary-0.test.mjs", needed);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    const ports = [...JSON.parse(large.stdout), ...JSON.parse(ordinary.stdout)];
    assert.equal(new Set(ports).size, 200 + needed);
    for (const port of ports) assert(port >= 5_000 && port < 32_768 && (port < 10_000 || port >= 30_000));
  }
});

test("invalid explicit capacity fails instead of escaping the bounded pool", (t) => {
  for (const size of [0, 257, -1, 32.5, "invalid", ""]) {
    const result = fixture(t, { size })("aaa-large-0.test.mjs", 1);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid test port block size/);
  }
});

test("oversubscribed declarations fail before falling back to ephemeral ports", (t) => {
  const result = fixture(t, { ordinary: 0, reserved: 31 })("aaa-large-0.test.mjs", 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no remaining disjoint blocks/);
});
