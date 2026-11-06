import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Execute the actual server owner without importing the browser test suite or
// needing a browser installation. A launch refusal must fail promptly, not
// leave an open localhost listener holding the test worker alive.
for (const suite of ["renderer", "generation-outcome-renderer"]) {
  test(`${suite} server closes when browser launch rejects before try/finally`, (t) => {
    const source = readFileSync(new URL(`../apps/control-center/test/${suite}.test.mjs`, import.meta.url), "utf8");
    const start = source.search(/^(?:async )?function serveRenderer\(\) \{/m);
    const end = source.indexOf("const chromiumPath =", start);
    assert.ok(start >= 0 && end > start, "locate the actual renderer server owner");
    const directory = mkdtempSync(path.join(os.tmpdir(), "renderer-cleanup-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, "launch-rejection.test.mjs");
    writeFileSync(fixture, `
      import assert from "node:assert/strict";
      import http from "node:http";
      import path from "node:path";
      import { existsSync, readFileSync } from "node:fs";
      import test from "node:test";
      const dist = ${JSON.stringify(directory)};
      ${source.slice(start, end)}
      test("synthetic browser launch refusal", async () => {
        await serveRenderer();
        throw new Error("synthetic browser launch rejected");
      });
    `);
    const childEnvironment = { ...process.env, NODE_OPTIONS: "" };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      "--test", "--experimental-test-isolation=none", "--test-reporter=tap", fixture,
    ], { encoding: "utf8", timeout: 5_000, env: childEnvironment });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, "the synthetic launch must fail without hanging");
    assert.match(result.stdout, /synthetic browser launch rejected/);
    assert.match(result.stdout, /# tests 1/);
  });
}
