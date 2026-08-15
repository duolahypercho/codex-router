import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;

test("both dispatchers accept the stop command", () => {
  // Issue #224's lifecycle validation flow needs install/start/stop/uninstall
  // to be reachable from one CLI; stop existed only as `node src/service.mjs
  // stop` before. The dispatchers are asserted as text so this holds on every
  // platform without spawning the service.
  const posix = readFileSync(path.join(root, "bin", "model-router"), "utf8");
  assert.match(posix, /\|start\|stop\|/);
  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(windows, /"stop"/);
  assert.match(windows, /"stop"\s*\{\s*Invoke-RouterNode "src\\service\.mjs" @\("stop"\)/);
});

for (const args of [["--version"], ["codex", "--version"]]) {
  test(
    `model-router ${args.join(" ")} reports the package version`,
    { skip: process.platform === "win32" },
    () => {
      const result = spawnSync(path.join(root, "bin", "model-router"), args, {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), version);
    },
  );
}
