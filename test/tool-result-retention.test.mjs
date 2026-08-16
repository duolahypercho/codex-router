import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function handle(letter) {
  return letter.repeat(43);
}

function stageStore(files = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "retained-tool-results-"));
  const store = path.join(stateDir, "retained-tool-results");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(store, name), contents, { mode: 0o600 });
  }
  return { stateDir, store };
}

function purge(store, args, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "control.mjs"), "tool-result-aging", "purge", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR: store,
        ...extraEnv,
      },
    },
  );
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
}

function doctorCheck(stateDir, name) {
  const result = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: path.dirname(stateDir),
      CODEX_ROUTER_PORT: "46281",
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_TARGET: "codex",
    },
    timeout: 90_000,
  });
  const report = JSON.parse(result.stdout);
  return report.checks.find((check) => check.name === name);
}

test("usage reports an absent store as nothing retained rather than as a fault", async () => {
  const { retainedToolResultsUsage } = await import("../src/tool-result-retention.mjs");
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "retained-absent-"));
  try {
    const usage = retainedToolResultsUsage({
      directory: path.join(stateDir, "retained-tool-results"),
    });
    assert.equal(usage.exists, false);
    assert.equal(usage.results, 0);
    assert.equal(usage.bytes, 0);
    assert.equal(usage.oldestAgeMs, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("usage counts retained results, bytes, and the age of the oldest one", async () => {
  const { retainedToolResultsUsage } = await import("../src/tool-result-retention.mjs");
  const { stateDir, store } = stageStore({
    [`${handle("A")}.result`]: "a".repeat(4_000),
    [`${handle("B")}.result`]: "b".repeat(1_000),
    ".retention-key": "key",
  });
  try {
    const oldSeconds = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    utimesSync(path.join(store, `${handle("A")}.result`), oldSeconds, oldSeconds);
    const usage = retainedToolResultsUsage({ directory: store });
    assert.equal(usage.exists, true);
    assert.equal(usage.results, 2);
    // The key is part of the store's footprint even though it is not a result.
    assert.equal(usage.files, 3);
    assert.equal(usage.bytes, 5_003);
    assert.ok(usage.oldestAgeMs > 2.5 * 24 * 60 * 60 * 1000);
    assert.deepEqual(usage.foreign, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a purge without --yes reports what it would remove and removes nothing", () => {
  const { stateDir, store } = stageStore({
    [`${handle("A")}.result`]: "a".repeat(2_048),
    ".retention-key": "key",
  });
  try {
    const result = purge(store, []);
    assert.equal(result.status, 0);
    assert.equal(result.json.dryRun, true);
    assert.equal(result.json.removed, 2);
    assert.equal(result.json.reclaimedBytes, 2_051);
    assert.match(result.stderr, /Would remove 2 file\(s\)/);
    assert.match(result.stderr, /Re-run with --yes/);
    assert.equal(existsSync(path.join(store, `${handle("A")}.result`)), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--yes empties the store, reports the bytes reclaimed, and keeps the directory", () => {
  const { stateDir, store } = stageStore({
    [`${handle("A")}.result`]: "a".repeat(2_048),
    [`${handle("B")}.result`]: "b".repeat(1_024),
    ".retention-key": "key",
    [`.${handle("C")}.stage.${"0".repeat(32)}`]: "staged",
  });
  try {
    const result = purge(store, ["--yes"]);
    assert.equal(result.status, 0);
    assert.equal(result.json.dryRun, false);
    assert.equal(result.json.removed, 4);
    assert.equal(result.json.results, 2);
    assert.equal(result.json.reclaimedBytes, 2_048 + 1_024 + 3 + 6);
    assert.deepEqual(result.json.failed, []);
    assert.match(result.stderr, /Removed 4 file\(s\)/);
    assert.equal(existsSync(path.join(store, `${handle("A")}.result`)), false);
    assert.equal(existsSync(path.join(store, ".retention-key")), false);
    // The writer creates and hardens this directory; emptying it is the whole
    // job, and removing it under a concurrent write buys nothing.
    assert.equal(existsSync(store), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--dry-run outranks --yes so a wrapper that always consents can still preview", () => {
  const { stateDir, store } = stageStore({ [`${handle("A")}.result`]: "a".repeat(64) });
  try {
    const result = purge(store, ["--yes", "--dry-run"]);
    assert.equal(result.json.dryRun, true);
    assert.equal(existsSync(path.join(store, `${handle("A")}.result`)), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The store holds file contents and command output. A purge that reached one
// directory further than its own would be deleting the operator's data on the
// strength of a filename, so the refusal is proved rather than assumed.
test("purge deletes nothing it did not write and never follows a link out of the store", () => {
  const { stateDir, store } = stageStore({
    [`${handle("A")}.result`]: "a".repeat(512),
    "notes.txt": "not ours",
    "short.result": "wrong handle shape",
  });
  const outsider = path.join(stateDir, "outside-the-store.txt");
  writeFileSync(outsider, "must survive", { mode: 0o600 });
  mkdirSync(path.join(store, "nested"), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    symlinkSync(outsider, path.join(store, `${handle("D")}.result`));
  }
  try {
    const result = purge(store, ["--yes"]);
    assert.equal(result.status, 0);
    assert.equal(result.json.removed, 1);
    assert.equal(existsSync(outsider), true);
    assert.equal(readFileSync(outsider, "utf8"), "must survive");
    assert.equal(existsSync(path.join(store, "notes.txt")), true);
    assert.equal(existsSync(path.join(store, "short.result")), true);
    assert.equal(existsSync(path.join(store, "nested")), true);
    assert.ok(result.json.foreign.includes("notes.txt"));
    assert.ok(result.json.foreign.includes("nested"));
    if (process.platform !== "win32") {
      // The link itself is left alone too: refusing it is what proves nothing
      // resolved through it.
      assert.equal(existsSync(path.join(store, `${handle("D")}.result`)), true);
      assert.ok(result.json.foreign.includes(`${handle("D")}.result`));
    }
    assert.match(result.stderr, /did not write in place/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("purging an absent store says so and exits cleanly", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "retained-none-"));
  try {
    const result = purge(path.join(stateDir, "retained-tool-results"), ["--yes"]);
    assert.equal(result.status, 0);
    assert.equal(result.json.exists, false);
    assert.equal(result.json.removed, 0);
    assert.match(result.stderr, /nothing to purge/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unknown tool-result-aging action names purge in its usage", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "control.mjs"), "tool-result-aging", "nonsense"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /purge \[--yes\] \[--dry-run\]/);
});

test(
  "doctor reports the retained-result store's count, size, and oldest entry",
  { timeout: 120_000 },
  () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "retained-doctor-"));
    const stateDir = path.join(codexHome, "codex-router");
    const store = path.join(stateDir, "retained-tool-results");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(store, `${handle("A")}.result`), "a".repeat(3 * 1024 * 1024), {
      mode: 0o600,
    });
    writeFileSync(path.join(store, ".retention-key"), "key", { mode: 0o600 });
    const oldSeconds = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;
    utimesSync(path.join(store, `${handle("A")}.result`), oldSeconds, oldSeconds);
    try {
      const check = doctorCheck(stateDir, "Retained tool results");
      assert.ok(check, "doctor reports a retained-tool-results row");
      assert.equal(check.status, "ok");
      assert.match(check.detail, /1 retained result\(s\)/);
      assert.match(check.detail, /3\.0 MiB/);
      assert.match(check.detail, /oldest 5d old/);
      assert.ok(check.detail.includes(store));
      assert.match(check.fix, /tool-result-aging purge/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);

test(
  "doctor says nothing is retained on an install that has never compacted a result",
  { timeout: 120_000 },
  () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "retained-doctor-empty-"));
    const stateDir = path.join(codexHome, "codex-router");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try {
      const check = doctorCheck(stateDir, "Retained tool results");
      assert.ok(check, "the row exists even with no store, or the store stays undiscoverable");
      assert.equal(check.status, "ok");
      assert.match(check.detail, /nothing retained/);
      assert.ok(check.detail.includes(path.join(stateDir, "retained-tool-results")));
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);

test("a store parked at its file cap is reported as a warning, not as healthy", async () => {
  const { RETENTION_MAX_FILES, retainedToolResultsUsage } = await import(
    "../src/tool-result-retention.mjs"
  );
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "retained-capacity-"));
  const store = path.join(stateDir, "retained-tool-results");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  try {
    for (let index = 0; index < RETENTION_MAX_FILES; index += 1) {
      // Digits are inside the handle alphabet, so a zero-padded counter is a
      // unique name of exactly the shape the writer produces.
      writeFileSync(path.join(store, `${String(index).padStart(43, "0")}.result`), "x", {
        mode: 0o600,
      });
    }
    const usage = retainedToolResultsUsage({ directory: store });
    assert.equal(usage.results, RETENTION_MAX_FILES);
    assert.equal(usage.capacityReached, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
