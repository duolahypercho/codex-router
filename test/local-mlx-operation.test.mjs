import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-mlx-operation-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_LOCAL_MLX_OPERATION_STATE = path.join(stateDir, "mlx-operation.json");
process.env.MODEL_ROUTER_LOCAL_MLX_OPERATION_CLAIM = path.join(stateDir, "mlx-operation.claim");

const {
  LOCAL_MLX_INSTALLERS,
  ensureLocalMlxPrerequisites,
} = await import("../src/local-mlx.mjs");
const {
  LOCAL_MLX_OPERATION_PATH,
  cancelLocalMlxOperation,
  localMlxUiSnapshot,
  readLocalMlxOperation,
  startLocalMlxOperation,
  writeLocalMlxOperation,
  localMlxHostSupport,
} = await import("../src/local-mlx-operation.mjs");
const { writeLocalDownload } = await import("../src/local-download.mjs");

test("missing prerequisites are installed only from the two official sources", async () => {
  const fetched = [];
  const runs = [];
  let lmsReady = false;
  let uvxReady = false;
  const result = await ensureLocalMlxPrerequisites({
    yes: true,
    platform: "darwin",
    lmsPath: null,
    uvxPath: null,
    tmpdir: stateDir,
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, text: async () => "#!/bin/sh\nexit 0\n" };
    },
    run: async (command, args) => {
      runs.push({ command, args });
      if (runs.length === 1) lmsReady = true;
      else uvxReady = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    findLmsImpl: () => lmsReady ? "/private/lms" : undefined,
    findUvxImpl: () => uvxReady ? "/private/uvx" : undefined,
  });
  assert.deepEqual(fetched, [LOCAL_MLX_INSTALLERS.lms.unix, LOCAL_MLX_INSTALLERS.uvx.unix]);
  assert.equal(result.lmsPath, "/private/lms");
  assert.equal(result.uvxPath, "/private/uvx");
  assert.deepEqual(result.installed.map((row) => row.tool), ["lms", "uvx"]);
  assert.ok(runs.every((row) => row.command === "/bin/bash"));
  assert.ok(!runs.flatMap((row) => row.args).some((arg) => /token|credential/i.test(arg)));
});

test("prerequisite installation requires explicit consent", async () => {
  await assert.rejects(
    ensureLocalMlxPrerequisites({ yes: false, lmsPath: null, uvxPath: null }),
    /Pass --yes/,
  );
});

test("UI snapshot has stable metadata, prerequisite sources, and no executable paths", async () => {
  writeLocalMlxOperation({
    version: 1,
    status: "done",
    detail: "Installed and published to Codex",
    percent: 100,
    startedAt: 1,
    updatedAt: 2,
    workerPid: null,
    controllerPid: null,
  });
  const snapshot = await localMlxUiSnapshot({
    platform: "darwin",
    arch: "arm64",
    lmsPath: "/secret/home/bin/lms",
    uvxPath: "/secret/home/bin/uvx",
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    published: false,
  });
  assert.equal(snapshot.model.slug, "lmstudio/qwen38-27b-uncensored-mlx");
  assert.deepEqual(snapshot.host, { supported: true, platform: "darwin", arch: "arm64" });
  assert.equal(snapshot.model.precision, "4-bit");
  assert.equal(snapshot.prerequisites.lms.source, LOCAL_MLX_INSTALLERS.lms.unix);
  assert.equal(snapshot.prerequisites.uvx.source, LOCAL_MLX_INSTALLERS.uvx.unix);
  assert.match(snapshot.prerequisites.lms.installHint, /automatically after consent/);
  assert.equal(snapshot.operation.status, "done");
  assert.doesNotMatch(JSON.stringify(snapshot), /secret\/home/);
});

test("start is detached, private, and idempotent while the worker is active", () => {
  writeLocalMlxOperation({ version: 1, status: "idle", updatedAt: Date.now() });
  let unrefed = false;
  const first = startLocalMlxOperation({
    yes: true,
    platform: "darwin",
    arch: "arm64",
    spawnImpl: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(path.basename(args[0]), "local-mlx-operation.mjs");
      assert.equal(args.at(-1), "worker");
      assert.equal(options.detached, true);
      assert.equal(options.stdio, "ignore");
      return { pid: process.pid, unref: () => { unrefed = true; } };
    },
  });
  assert.equal(first.started, true);
  assert.equal(unrefed, true);
  const mode = statSync(LOCAL_MLX_OPERATION_PATH).mode;
  if (process.platform === "win32") {
    // Windows reports permissive synthetic group bits for NTFS files. The
    // owner-readable/writable contract is the portable part of this check.
    assert.equal(mode & 0o600, 0o600);
  } else {
    assert.equal(mode & 0o777, 0o600);
  }

  const second = startLocalMlxOperation({
    yes: true,
    platform: "darwin",
    arch: "arm64",
    spawnImpl: () => { throw new Error("must not spawn twice"); },
  });
  assert.equal(second.started, false);
  assert.equal(second.existing, true);
});

test("host support is limited to Apple silicon macOS and blocks before spawning", async () => {
  assert.deepEqual(localMlxHostSupport({ platform: "darwin", arch: "arm64" }), {
    supported: true,
    platform: "darwin",
    arch: "arm64",
  });
  const unsupported = localMlxHostSupport({ platform: "linux", arch: "arm64" });
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /macOS on Apple silicon/);
  assert.equal(localMlxHostSupport({ platform: "darwin", arch: "x64" }).supported, false);
  const snapshot = await localMlxUiSnapshot({
    platform: "linux",
    arch: "arm64",
    lmsPath: null,
    uvxPath: null,
    fetchImpl: async () => { throw new Error("offline"); },
    published: false,
  });
  assert.equal(snapshot.host.supported, false);
  assert.equal(snapshot.host.platform, "linux");
  assert.match(snapshot.host.reason, /macOS on Apple silicon/);

  writeLocalMlxOperation({ version: 1, status: "idle", detail: "unchanged", updatedAt: 7 });
  let spawned = false;
  assert.throws(
    () => startLocalMlxOperation({
      yes: true,
      platform: "linux",
      arch: "arm64",
      spawnImpl: () => { spawned = true; },
    }),
    /requires macOS on Apple silicon/,
  );
  assert.equal(spawned, false);
  assert.equal(readLocalMlxOperation({ persist: false }).detail, "unchanged");
});

test("MLX install refuses while an Ollama model operation is active", () => {
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "qwen3:4b",
    status: "downloading",
    detail: "Downloading",
    percent: 40,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: process.pid,
  });
  let spawned = false;
  assert.throws(
    () => startLocalMlxOperation({
      yes: true,
      platform: "darwin",
      arch: "arm64",
      spawnImpl: () => { spawned = true; },
    }),
    /qwen3:4b is already downloading/,
  );
  assert.equal(spawned, false);
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "qwen3:4b",
    status: "cancelled",
    updatedAt: Date.now(),
  });
});

test("MLX re-checks Ollama state only after acquiring the shared start gate", () => {
  writeLocalMlxOperation({ version: 1, status: "idle", updatedAt: Date.now() });
  let gateHeld = false;
  let released = false;
  let spawned = false;
  assert.throws(
    () => startLocalMlxOperation({
      yes: true,
      platform: "darwin",
      arch: "arm64",
      claimGlobalOperation: () => {
        gateHeld = true;
        return {
          acquired: true,
          release() { gateHeld = false; released = true; },
        };
      },
      readLocalOperation: () => {
        assert.equal(gateHeld, true);
        return { status: "downloading", tag: "qwen3:4b" };
      },
      spawnImpl: () => { spawned = true; },
    }),
    /qwen3:4b is already downloading/,
  );
  assert.equal(spawned, false);
  assert.equal(released, true);
});

test("Ollama controllers re-check MLX under the shared claim before seeding state", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "control.mjs"), "utf8");
  const installStart = source.indexOf('if (action === "install" || action === "install-and-use")');
  const installEnd = source.indexOf('if (action === "finalize-uninstall")', installStart);
  const install = source.slice(installStart, installEnd);
  assert.ok(install.indexOf("const claim = claimLocalOperation") < install.indexOf("readLocalMlxOperation()"));
  assert.ok(install.indexOf("readLocalMlxOperation()") < install.indexOf('writePhase("Checking model'));

  const uninstallStart = source.indexOf('if (action === "uninstall")', installEnd);
  const uninstallEnd = source.indexOf('} else if (action === "set")', uninstallStart);
  const uninstall = source.slice(uninstallStart, uninstallEnd);
  assert.ok(uninstall.indexOf("const claim = claimLocalOperation") < uninstall.indexOf("readLocalMlxOperation()"));
  assert.ok(uninstall.indexOf("readLocalMlxOperation()") < uninstall.indexOf("writeLocalDownload({"));
});

test("cancellation records a terminal safe state", () => {
  writeLocalMlxOperation({
    version: 1,
    status: "preparing",
    detail: "Starting",
    percent: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: process.pid,
    controllerPid: null,
  });
  const current = readLocalMlxOperation({ persist: false });
  assert.equal(current.status, "preparing");
  const result = cancelLocalMlxOperation();
  assert.equal(result.cancelled, true);
  assert.equal(result.state.status, "cancelled");
  assert.equal(readLocalMlxOperation().workerPid, null);
});

test("a refused stop keeps the operation active instead of reporting false cancellation", () => {
  writeLocalMlxOperation({
    version: 1,
    status: "downloading",
    detail: "Downloading",
    percent: 5,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: 424242,
    controllerPid: null,
  });
  const kill = (_pid, signal) => {
    if (signal === 0) return;
    const error = new Error("not permitted");
    error.code = "EPERM";
    throw error;
  };
  assert.throws(() => cancelLocalMlxOperation({ kill, platform: "linux" }), /not permitted/);
  assert.equal(readLocalMlxOperation({ kill, persist: false }).status, "downloading");
});

test("cancellation stops the detached worker process group before recording success", () => {
  writeLocalMlxOperation({
    version: 1,
    status: "downloading",
    detail: "Downloading",
    percent: 5,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: 525252,
    controllerPid: null,
  });
  const calls = [];
  const kill = (pid, signal) => { calls.push({ pid, signal }); };
  const result = cancelLocalMlxOperation({ kill, platform: "linux" });
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, [
    { pid: 525252, signal: 0 },
    { pid: -525252, signal: "SIGTERM" },
  ]);
  assert.equal(readLocalMlxOperation().status, "cancelled");
});

test("Windows cancellation stops the whole detached worker tree", () => {
  writeLocalMlxOperation({
    version: 1,
    status: "downloading",
    detail: "Downloading",
    percent: 5,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: 525253,
    controllerPid: null,
  });
  const result = cancelLocalMlxOperation({
    platform: "win32",
    kill: () => {},
    spawnSyncImpl: (command, args, options) => {
      assert.equal(command, "taskkill");
      assert.deepEqual(args, ["/PID", "525253", "/T", "/F"]);
      assert.equal(options.windowsHide, true);
      return { status: 0 };
    },
  });
  assert.equal(result.cancelled, true);
  assert.equal(readLocalMlxOperation().status, "cancelled");
});

test("control exposes the read-only MLX status contract and enforces consent", () => {
  const env = {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_LOCAL_MLX_OPERATION_STATE: LOCAL_MLX_OPERATION_PATH,
    MODEL_ROUTER_LOCAL_MLX_OPERATION_CLAIM: path.join(stateDir, "control-claim"),
  };
  const status = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "src", "control.mjs"), "local-models", "mlx-status"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.model.id, "qwen38-27b-uncensored-mlx");
  assert.ok(payload.prerequisites.lms.source.startsWith("https://lmstudio.ai/"));
  assert.ok(payload.runtime);

  const listed = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "src", "control.mjs"), "local-models", "list", "--json"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).mlx.model.id, "qwen38-27b-uncensored-mlx");

  const refused = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "src", "control.mjs"), "local-models", "mlx-install"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Pass --yes/);
});

test("Ollama install and uninstall refuse while the MLX worker is active", () => {
  writeLocalMlxOperation({
    version: 1,
    status: "downloading",
    detail: "Downloading the 4-bit MLX weights",
    percent: 5,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: process.pid,
    controllerPid: null,
  });
  const env = {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_LOCAL_MLX_OPERATION_STATE: LOCAL_MLX_OPERATION_PATH,
    MODEL_ROUTER_LOCAL_MLX_OPERATION_CLAIM: path.join(stateDir, "control-exclusion-claim"),
  };
  for (const args of [
    ["local-models", "install", "qwen3:4b"],
    ["local-models", "uninstall", "qwen3:4b", "--yes"],
  ]) {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "src", "control.mjs"), ...args], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /curated MLX model is already downloading/);
  }
  writeLocalMlxOperation({
    version: 1,
    status: "cancelled",
    detail: "test complete",
    updatedAt: Date.now(),
    workerPid: null,
    controllerPid: null,
  });
});
