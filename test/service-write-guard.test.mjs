import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertServiceWriteIsolated } from "../src/service-write-guard.mjs";

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

test("a redirected service path never reaches the real launchd domain", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-router-guard-redirect-"));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "service-macos.mjs"), "render"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: fixture,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    // The renderer shares the same boundary as install/uninstall. A redirected
    // path may be rendered, but the service manager must never bootstrap it.
    assert.match(result.stdout, /io\.github\.codex-router/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installing the macOS service from a test refuses instead of writing", () => {
  // The end-to-end shape of the accident this guards: a test spawns the real
  // service installer, which rewrites the developer's own LaunchAgent to point
  // at the checkout under test. HOME is redirected here so that even a guard
  // regression lands in the fixture rather than on this machine -- the
  // assertions below still fail loudly if the write goes through.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-guard-home-"));
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
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
          HOME: fakeHome,
          CODEX_HOME: path.join(fakeHome, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(fakeHome, "state"),
          CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
          CODEX_ROUTER_NODE_BIN: process.execPath,
          NODE_TEST_CONTEXT: "child-v8",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: "",
          CODEX_ROUTER_LAUNCH_AGENTS_DIR: "",
        },
      },
    );
    assert.notEqual(result.status, 0, "an unredirected install must not succeed");
    assert.match(result.stderr, /Refusing to write the LaunchAgent/);
    assert.equal(
      existsSync(path.join(agents, "io.github.codex-router.plist")),
      false,
      "the guard must refuse before anything is written",
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
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
          NODE_TEST_CONTEXT: "child-v8",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: agents,
        },
      },
    );
    assert.doesNotMatch(result.stderr || "", /Refusing to write the LaunchAgent/);
    assert.equal(existsSync(path.join(agents, "io.github.codex-router.plist")), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
