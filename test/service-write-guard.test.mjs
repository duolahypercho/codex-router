import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertServiceLabelIsolated,
  assertServiceWriteIsolated,
} from "../src/service-write-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("outside a test run the guard never interferes", () => {
  // Real installs are the whole point of this code path; the guard exists only
  // to stop the suite from performing one.
  assert.equal(
    assertServiceWriteIsolated("/Users/someone/Library/LaunchAgents/x.plist", {
      env: {},
      redirected: false,
    }),
    undefined,
  );
});

test("inside a test run an unredirected service write is refused", () => {
  assert.throws(
    () =>
      assertServiceWriteIsolated("/Users/someone/Library/LaunchAgents/x.plist", {
        env: { NODE_TEST_CONTEXT: "child-v8" },
        redirected: false,
        label: "LaunchAgent",
        override: "MODEL_ROUTER_LAUNCH_AGENTS_DIR",
      }),
    /Refusing to write the LaunchAgent[\s\S]*MODEL_ROUTER_LAUNCH_AGENTS_DIR/,
  );
});

test("a redirected write is allowed inside a test run", () => {
  assert.equal(
    assertServiceWriteIsolated("/tmp/fixture/x.plist", {
      env: { NODE_TEST_CONTEXT: "child-v8" },
      redirected: true,
    }),
    undefined,
  );
});

test("a test cannot invoke launchctl under the production service label", () => {
  assert.throws(
    () =>
      assertServiceLabelIsolated("io.github.codex-router", {
        env: { NODE_TEST_CONTEXT: "child-v8" },
      }),
    /Refusing to use the production launchd label/,
  );
  assert.equal(
    assertServiceLabelIsolated("io.github.codex-router.test.fixture", {
      env: { NODE_TEST_CONTEXT: "child-v8" },
    }),
    undefined,
  );
});

test("the macOS installer checks test-label isolation before launchctl branches", () => {
  // Do not spawn the installer with the real label: a regression in the guard
  // ordering would make this test reproduce the outage it is meant to catch.
  const source = readFileSync(path.join(root, "src", "service-macos.mjs"), "utf8");
  const check = source.indexOf("assertServiceLabelIsolated(SERVICE_LABEL)");
  const install = source.indexOf('} else if (command === "install")');
  const uninstall = source.indexOf('} else if (command === "uninstall")');
  assert.ok(check >= 0, "service commands must check their launchd label");
  assert.ok(check < install, "install must check before it can call bootout");
  assert.ok(check < uninstall, "uninstall must check before it can call bootout");
});

test("a redirected install is still able to write its fixture", () => {
  // The guard must not block the isolated installs the suite legitimately does,
  // or it would simply trade one broken behaviour for another.
  const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-router-guard-fixture-"));
  const agents = path.join(fixture, "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "service-macos.mjs"), "install"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          CODEX_HOME: path.join(fixture, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(fixture, "state"),
          CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
          CODEX_ROUTER_NODE_BIN: process.execPath,
          CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
          NODE_TEST_CONTEXT: "child-v8",
          CODEX_ROUTER_TEST_SERVICE_LABEL: "io.github.codex-router.test.fixture",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: agents,
        },
      },
    );
    assert.doesNotMatch(result.stderr || "", /Refusing to write the LaunchAgent/);
    assert.equal(
      existsSync(path.join(agents, "io.github.codex-router.test.fixture.plist")),
      true,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
