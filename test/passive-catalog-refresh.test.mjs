import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  createPassiveCatalogRefreshScheduler,
  passiveMirrorSummary,
  readPassiveCatalogRefreshState,
  recordPassiveCatalogRefreshFailure,
  recordPassiveCatalogRefreshSuccess,
  reservePassiveCatalogRefresh,
  runPassiveCatalogRefreshWorker,
} = await import("../src/passive-catalog-refresh.mjs");
const passiveCatalogRefreshModule = new URL(
  "../src/passive-catalog-refresh.mjs",
  import.meta.url,
).href;

function temporaryState() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "passive-catalog-refresh-test-"));
  return {
    directory,
    file: path.join(directory, "passive-catalog-refresh.json"),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const mirrorProviders = new Map([["private", {
  id: "private",
  protocol: "openai-responses",
  mirrorNativeModels: true,
}]]);

test("a durable reservation coalesces attempts and success starts a fresh cooldown", () => {
  const state = temporaryState();
  try {
    const first = reservePassiveCatalogRefresh({
      file: state.file,
      now: 1_000,
      failureBaseMs: 500,
    });
    assert.equal(first.reserved, true);
    assert.equal(first.state.nextEligibleAt, 1_500);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(state.file).mode & 0o777, 0o600);
    }

    const duplicate = reservePassiveCatalogRefresh({
      file: state.file,
      now: 1_100,
      failureBaseMs: 500,
    });
    assert.equal(duplicate.reserved, false);

    const success = recordPassiveCatalogRefreshSuccess(
      { changed: true, changedCount: 2 },
      { file: state.file, now: 1_200, intervalMs: 10_000 },
    );
    assert.equal(success.nextEligibleAt, 11_200);
    assert.equal(success.consecutiveFailures, 0);
    assert.equal(success.lastChanged, true);
    assert.equal(success.lastChangedCount, 2);
  } finally {
    state.close();
  }
});

test("concurrent processes share one durable refresh reservation", async () => {
  const state = temporaryState();
  const script = `
    import { reservePassiveCatalogRefresh } from ${JSON.stringify(passiveCatalogRefreshModule)};
    const result = reservePassiveCatalogRefresh({
      file: process.argv[1],
      now: 1_000,
      failureBaseMs: 60_000,
    });
    process.stdout.write(result.reserved ? "reserved" : "cooldown");
  `;
  try {
    const attempts = Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        script,
        state.file,
      ], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0) {
          reject(new Error(`reservation child exited ${code ?? signal}: ${stderr}`));
          return;
        }
        resolve(stdout);
      });
    }));
    const results = await Promise.all(attempts);
    assert.equal(results.filter((result) => result === "reserved").length, 1);
    assert.equal(results.filter((result) => result === "cooldown").length, 11);
  } finally {
    state.close();
  }
});

test("failures back off exponentially, cap, and never persist an error body", () => {
  const state = temporaryState();
  try {
    reservePassiveCatalogRefresh({ file: state.file, now: 1, failureBaseMs: 100 });
    const first = recordPassiveCatalogRefreshFailure({
      file: state.file,
      now: 100,
      failureBaseMs: 100,
      failureMaxMs: 250,
    });
    const second = recordPassiveCatalogRefreshFailure({
      file: state.file,
      now: 200,
      failureBaseMs: 100,
      failureMaxMs: 250,
    });
    const third = recordPassiveCatalogRefreshFailure({
      file: state.file,
      now: 300,
      failureBaseMs: 100,
      failureMaxMs: 250,
    });
    assert.equal(first.nextEligibleAt, 200);
    assert.equal(second.nextEligibleAt, 400);
    assert.equal(third.nextEligibleAt, 550);
    assert.equal(third.consecutiveFailures, 3);
    assert.doesNotMatch(readFileSync(state.file, "utf8"), /error|response|url|key/i);
  } finally {
    state.close();
  }
});

test("a corrupt or symlinked state is replaced before a second attempt can run", {
  skip: process.platform === "win32" ? "symlink permissions vary on Windows" : false,
}, () => {
  const state = temporaryState();
  try {
    const foreign = path.join(state.directory, "foreign.json");
    writeFileSync(foreign, '{"secret":"must-not-be-read"}\n', { mode: 0o600 });
    symlinkSync(foreign, state.file);
    assert.equal(readPassiveCatalogRefreshState({ file: state.file }), undefined);

    const first = reservePassiveCatalogRefresh({
      file: state.file,
      now: 10,
      failureBaseMs: 100,
    });
    const second = reservePassiveCatalogRefresh({
      file: state.file,
      now: 11,
      failureBaseMs: 100,
    });
    assert.equal(first.reserved, true);
    assert.equal(second.reserved, false);
    assert.equal(lstatSync(state.file).isSymbolicLink(), false);
    assert.equal(readFileSync(foreign, "utf8"), '{"secret":"must-not-be-read"}\n');
  } finally {
    state.close();
  }
});

test("idle scheduling cancels on traffic and coalesces an adversarial trigger burst", () => {
  let now = 10_000;
  let active = 0;
  let spawns = 0;
  const timers = [];
  const children = [];
  const scheduler = createPassiveCatalogRefreshScheduler({
    enabled: true,
    options: {
      disabled: false,
      intervalMs: 10_000,
      failureBaseMs: 1_000,
      failureMaxMs: 10_000,
      idleMs: 30,
    },
    now: () => now,
    activeRequests: () => active,
    readState: () => undefined,
    setTimer(callback, delay) {
      const timer = { callback, delay, canceled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.canceled = true; },
    spawnWorker() {
      spawns += 1;
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
  });

  assert.equal(scheduler.schedule(), true);
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(scheduler.schedule(), false);
  }
  scheduler.noteActivityStarted();
  assert.equal(timers[0].canceled, true);

  active = 1;
  scheduler.noteActivityFinished();
  assert.equal(timers.length, 1);
  active = 0;
  scheduler.noteActivityFinished();
  assert.equal(timers.length, 2);
  timers[1].callback();
  assert.equal(spawns, 1);
  for (let index = 0; index < 1_000; index += 1) scheduler.schedule();
  assert.equal(spawns, 1);

  children[0].emit("exit", 0);
  assert.equal(scheduler.schedule(), false, "a crashed worker receives an in-memory backoff");
  now += 1_001;
  assert.equal(scheduler.schedule(), true);
});

test("a durable cooldown written during the idle grace wins before spawn", () => {
  let timer;
  let reads = 0;
  let spawned = false;
  const scheduler = createPassiveCatalogRefreshScheduler({
    enabled: true,
    options: {
      disabled: false,
      intervalMs: 10_000,
      failureBaseMs: 1_000,
      failureMaxMs: 10_000,
      idleMs: 30,
    },
    now: () => 1_000,
    readState: () => (++reads === 1 ? undefined : {
      version: 1,
      nextEligibleAt: 9_000,
      consecutiveFailures: 0,
    }),
    setTimer(callback) {
      timer = { callback, unref() {} };
      return timer;
    },
    spawnWorker() { spawned = true; },
  });
  assert.equal(scheduler.schedule(), true);
  timer.callback();
  assert.equal(spawned, false);
});

test("the detached worker reserves before running and records only a bounded summary", () => {
  const calls = [];
  let summary;
  const result = runPassiveCatalogRefreshWorker({
    providers: mirrorProviders,
    options: {
      disabled: false,
      intervalMs: 10_000,
      failureBaseMs: 1_000,
      failureMaxMs: 10_000,
      idleMs: 30,
    },
    reserve: (options) => {
      calls.push(["reserve", options]);
      return { reserved: true };
    },
    runner: (_command, args, options) => {
      calls.push(["run", args, options]);
      return {
        status: 0,
        stdout: '{"providers":1,"added":["private/new"],"updated":[],"preserved":[],"changed":true}\n',
        stderr: "provider detail must not be persisted",
      };
    },
    recordSuccess: (value, options) => {
      summary = { value, options };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ran: true, ok: true, changed: true, changedCount: 1 });
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "run"]);
  assert.equal(calls[1][2].env.CODEX_ROUTER_PASSIVE_REFRESH_WORKER, "1");
  assert.deepEqual(summary.value, { changed: true, changedCount: 1 });
  assert.equal(summary.options.intervalMs, 10_000);
  assert.doesNotMatch(JSON.stringify(summary), /provider detail/);
});

test("worker failures record backoff without retaining stderr", () => {
  let failureOptions;
  let successCalled = false;
  const result = runPassiveCatalogRefreshWorker({
    providers: mirrorProviders,
    options: {
      disabled: false,
      intervalMs: 10_000,
      failureBaseMs: 1_000,
      failureMaxMs: 10_000,
      idleMs: 30,
    },
    reserve: () => ({ reserved: true }),
    runner: () => ({ status: 1, stdout: "", stderr: "secret upstream response" }),
    recordSuccess: () => { successCalled = true; },
    recordFailure: (options) => { failureOptions = options; },
  });
  assert.deepEqual(result, { ran: true, ok: false });
  assert.equal(successCalled, false);
  assert.deepEqual(failureOptions, { failureBaseMs: 1_000, failureMaxMs: 10_000 });
  assert.doesNotMatch(JSON.stringify(result), /secret|upstream/);
});

test("a synchronously throwing process launcher follows the same bounded failure path", () => {
  let failures = 0;
  const result = runPassiveCatalogRefreshWorker({
    providers: mirrorProviders,
    options: {
      disabled: false,
      intervalMs: 10_000,
      failureBaseMs: 1_000,
      failureMaxMs: 10_000,
      idleMs: 30,
    },
    reserve: () => ({ reserved: true }),
    runner: () => { throw new Error("launcher included sensitive detail"); },
    recordFailure: () => { failures += 1; },
  });
  assert.deepEqual(result, { ran: true, ok: false });
  assert.equal(failures, 1);
  assert.doesNotMatch(JSON.stringify(result), /sensitive|launcher/);
});

test("a disabled scheduler performs no state IO, timer, or spawn", () => {
  let touched = false;
  const scheduler = createPassiveCatalogRefreshScheduler({
    enabled: false,
    options: {
      disabled: false,
      intervalMs: 10_000,
      failureBaseMs: 1_000,
      failureMaxMs: 10_000,
      idleMs: 30,
    },
    readState: () => { touched = true; },
    setTimer: () => { touched = true; },
    spawnWorker: () => { touched = true; },
  });
  assert.equal(scheduler.schedule(), false);
  scheduler.noteActivityStarted();
  scheduler.noteActivityFinished();
  assert.equal(touched, false);
});

test("refresh output parsing ignores unrelated and malformed JSON lines", () => {
  assert.deepEqual(
    passiveMirrorSummary([
      "not json",
      '{"models":31}',
      "{broken",
      '{"providers":1,"added":[],"updated":["private/new"],"changed":true}',
    ].join("\n")),
    { changed: true, changedCount: 1 },
  );
});

test("the router lifecycle wires startup and idle triggers without a polling interval", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const schedulerSource = readFileSync(
    new URL("../src/passive-catalog-refresh.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /passiveCatalogRefresh\.noteActivityStarted\(\)/);
  assert.match(source, /passiveCatalogRefresh\.noteActivityFinished\(\)/);
  assert.match(source, /passiveCatalogRefresh\.schedule\(\)/);
  assert.match(source, /provider\.mirrorNativeModels === true && selected\.has\(provider\.id\)/);
  assert.doesNotMatch(schedulerSource, /setInterval\s*\(/);
});
