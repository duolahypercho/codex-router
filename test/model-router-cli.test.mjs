import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
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

test("doctor labels automatic failover counts as models rather than providers", () => {
  const doctor = readFileSync(path.join(root, "src", "doctor.mjs"), "utf8");
  assert.match(doctor, /failoverCounts\.subscription\} model\(s\) on your own providers/);
  assert.doesNotMatch(doctor, /failoverCounts\.subscription\} of your own providers/);
});

test("both dispatchers expose reviewed external skill management", () => {
  const posix = readFileSync(path.join(root, "bin", "model-router"), "utf8");
  assert.match(posix, /\|chatgpt-session\|skills\|/);
  assert.match(readFileSync(path.join(root, "bin", "skills"), "utf8"), /skills-install\.mjs/);
  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(windows, /"skills"/);
  assert.match(windows, /"skills"\s*\{\s*Invoke-RouterNode "src\\skills-install\.mjs" \$Arguments/);
  const doctor = readFileSync(path.join(root, "src", "doctor.mjs"), "utf8");
  assert.match(doctor, /process\.platform === "win32"/);
  assert.match(doctor, /\.\\\\model-router\.ps1 codex skills/);
  assert.match(doctor, /\.\/bin\/model-router codex skills/);
  assert.match(doctor, /approve-external/);
  assert.match(doctor, /revoke-external/);
});

test(
  "model-router rejects an incomplete skills command with a usage error",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(path.join(root, "bin", "model-router"), ["codex", "skills"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: skills-install\.mjs/);
  },
);

test(
  "model-router reports failed skill commands",
  { skip: process.platform === "win32" },
  () => {
    const failedInstall = spawnSync(
      path.join(root, "bin", "model-router"),
      ["codex", "skills", "install"],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: "/dev/null" },
      },
    );
    assert.equal(failedInstall.status, 2, failedInstall.stderr);
    assert.match(failedInstall.stderr, /skill install failed/);

    const home = mkdtempSync(path.join(os.tmpdir(), "codex-skills-cli-"));
    try {
      const env = { ...process.env, CODEX_HOME: home };
      const installed = spawnSync(
        path.join(root, "bin", "model-router"),
        ["codex", "skills", "install"],
        { encoding: "utf8", env },
      );
      assert.equal(installed.status, 0, installed.stderr);
      chmodSync(path.join(home, "skills"), 0o500);
      const failedUninstall = spawnSync(
        path.join(root, "bin", "model-router"),
        ["codex", "skills", "uninstall"],
        { encoding: "utf8", env },
      );
      assert.equal(failedUninstall.status, 2, failedUninstall.stderr);
      assert.match(failedUninstall.stderr, /skill uninstall failed/);
    } finally {
      chmodSync(path.join(home, "skills"), 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  },
);

for (const args of [["--version"], ["codex", "--version"], ["openclaw", "--version"]]) {
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


test("both dispatchers expose caller capability rotation", () => {
  const posix = readFileSync(path.join(root, "bin", "model-router"), "utf8");
  assert.match(posix, /\|caller-key\|/);
  assert.match(readFileSync(path.join(root, "bin", "caller-key"), "utf8"), /caller-key\.mjs/);

  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(windows, /"caller-key"/);
  assert.match(
    windows,
    /"caller-key"\s*\{\s*Invoke-RouterNode "src\\caller-key\.mjs" \$Arguments/,
  );
});
