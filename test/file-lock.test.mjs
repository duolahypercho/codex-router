import assert from "node:assert/strict";
import test from "node:test";

import lockfile from "proper-lockfile";

import { acquireFileLock, runWithLockRelease } from "../src/file-lock.mjs";

const INITIAL_TIME = 1_700_000_000_000;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const fsError = (code) => Object.assign(new Error(`Synthetic filesystem ${code}`), { code });

// Exercise the actual dependency with its public fs option and a fake clock.
// By default stat captures its result at dispatch: delayed delivery must not
// disguise the cached-result race by reading a newer lease at completion.
function fixture(t, { statAtDispatch = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: INITIAL_TIME });
  const directories = new Map();
  const pending = [];
  let removalError;
  let onRemovalDispatch;
  let writes = 0;
  let removals = 0;
  const dispatch = (kind, file, complete) => pending.push({ kind, file, complete });
  const statResult = (file) => directories.has(file)
    ? [null, { mtime: new Date(directories.get(file)) }]
    : [fsError("ENOENT")];
  const fs = {
    mkdir(file, callback) {
      dispatch("mkdir", file, () => {
        if (directories.has(file)) return callback(fsError("EEXIST"));
        directories.set(file, Date.now());
        callback(null);
      });
    },
    stat(file, callback) {
      const captured = statAtDispatch ? statResult(file) : undefined;
      dispatch("stat", file, () => callback(...(captured || statResult(file))));
    },
    utimes(file, _atime, mtime, callback) {
      writes += 1;
      dispatch("utimes", file, () => {
        if (!directories.has(file)) return callback(fsError("ENOENT"));
        directories.set(file, mtime.getTime());
        callback(null);
      });
    },
    rmdir(file, callback) {
      removals += 1;
      onRemovalDispatch?.();
      dispatch("rmdir", file, () => {
        if (removalError) return callback(removalError);
        if (!directories.delete(file)) return callback(fsError("ENOENT"));
        callback(null);
      });
    },
    rmdirSync(file) { directories.delete(file); },
    realpath(file, callback) { callback(null, file); },
  };
  const target = "/synthetic/router-operation";
  const lockPath = `${target}.lock`;
  const options = { fs, realpath: false, lockfilePath: lockPath, stale: 2_000, update: 1_000, retries: 0 };
  function take(kind) {
    const index = pending.findIndex((item) => item.kind === kind);
    assert.ok(index >= 0, `No pending ${kind} callback`);
    return pending.splice(index, 1)[0];
  }
  function complete(kind) { take(kind).complete(); }
  function flush() {
    while (pending.length) complete(pending[0].kind);
  }
  async function acquire(api = acquireFileLock, override = {}) {
    const acquiring = api(target, { ...options, ...override });
    await nextTurn();
    flush();
    return acquiring;
  }
  return { fs, options, target, lockPath, directories, pending, take, complete, flush, acquire,
    get writes() { return writes; }, get removals() { return removals; },
    failRemoval(error) { removalError = error; },
    onRemoval(callback) { onRemovalDispatch = callback; } };
}

test("the unmodified dependency reproduces a stat compromise after successful release", async (t) => {
  // Here the filesystem executes stat after rmdir, then delivers ENOENT.
  const env = fixture(t, { statAtDispatch: false });
  const release = await env.acquire(lockfile.lock);
  t.mock.timers.tick(1_000);
  const lateStat = env.take("stat");
  const releasing = release();
  env.complete("rmdir");
  await releasing;
  assert.equal(env.directories.has(env.lockPath), false);
  assert.throws(() => lateStat.complete(), { code: "ECOMPROMISED" });
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("a released lease ignores late ENOENT without delaying the official release", async (t) => {
  const env = fixture(t, { statAtDispatch: false });
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  const lateStat = env.take("stat");
  const releasing = release();
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["rmdir"]);
  env.complete("rmdir");
  await releasing;
  assert.doesNotThrow(() => lateStat.complete());
  assert.equal(env.writes, 1, "late stat must not start a heartbeat write");
  t.mock.timers.tick(60_000);
  assert.equal(env.pending.length, 0);
  await assert.rejects(release(), { code: "ERELEASED" });
});

for (const stale of [2_000, 5_000]) {
  test(`a cached stat after release cannot write into a reacquired ${stale}ms lease`, async (t) => {
    const env = fixture(t);
    const release = await env.acquire(acquireFileLock, { stale });
    t.mock.timers.tick(1_000);
    const lateStat = env.take("stat");
    const releasing = release();
    env.complete("rmdir");
    await releasing;
    t.mock.timers.tick(stale + 1_000);

    const nextRelease = await env.acquire(acquireFileLock, { stale });
    const acquiredMtime = env.directories.get(env.lockPath);
    const writes = env.writes;
    const removals = env.removals;
    assert.doesNotThrow(() => lateStat.complete());
    assert.equal(env.writes, writes, "released stat must not dispatch utimes");
    assert.equal(env.removals, removals, "released stat must not remove the new owner's directory");
    assert.equal(env.directories.get(env.lockPath), acquiredMtime);
    await assert.rejects(release(), { code: "ERELEASED" });

    t.mock.timers.tick(1_000);
    env.complete("stat");
    env.complete("utimes");
    const nextReleasing = nextRelease();
    env.complete("rmdir");
    await nextReleasing;
    assert.equal(env.pending.length, 0);
  });
}

test("the stat guard is set before a reentrant rmdir dispatch", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  const lateStat = env.take("stat");
  env.onRemoval(() => lateStat.complete());
  const releasing = release();
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["rmdir"]);
  assert.equal(env.writes, 1, "reentrant cached stat must not dispatch utimes");
  env.complete("rmdir");
  await releasing;
});

test("concurrent releases preserve the first official result and reject the second", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  const first = release();
  const second = assert.rejects(release(), { code: "ERELEASED" });
  assert.equal(env.removals, 1, "the captured lease is inactive before rmdir completes");
  t.mock.timers.tick(60_000);
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["rmdir"], "release synchronously cancels the heartbeat");
  env.complete("rmdir");
  await first;
  await second;
});

test("a failed official release still deactivates late stat callbacks and retains its error", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  const lateStat = env.take("stat");
  const removalError = fsError("EACCES");
  env.failRemoval(removalError);
  const releasing = assert.rejects(release(), (error) => error === removalError);
  env.complete("rmdir");
  await releasing;
  assert.doesNotThrow(() => lateStat.complete());
  assert.equal(env.directories.has(env.lockPath), true);
  assert.equal(env.writes, 1);
  await assert.rejects(release(), { code: "ERELEASED" });
  t.mock.timers.tick(60_000);
  assert.equal(env.pending.length, 0);
});

for (const mode of ["removed", "changed-mtime"]) {
  test(`an active ${mode} lease still throws`, async (t) => {
    const env = fixture(t);
    const release = await env.acquire();
    if (mode === "removed") env.directories.delete(env.lockPath);
    else env.directories.set(env.lockPath, env.directories.get(env.lockPath) + 7);
    t.mock.timers.tick(1_000);
    assert.throws(() => env.complete("stat"), { code: "ECOMPROMISED" });
    await assert.rejects(release(), { code: "ERELEASED" });
    assert.equal(env.pending.length, 0);
  });
}

test("an active utimes error retains the dependency's compromise handling", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  env.complete("stat");
  env.directories.delete(env.lockPath);
  assert.throws(() => env.complete("utimes"), { code: "ECOMPROMISED" });
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("an already-dispatched utimes callback retains the dependency's released guard", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  env.complete("stat");
  const lateWrite = env.take("utimes");
  const releasing = release();
  env.complete("rmdir");
  await releasing;
  // The syscall was already dispatched; this verifies callback behavior only,
  // without claiming to fence that syscall from a reacquired directory.
  assert.doesNotThrow(() => lateWrite.complete());
  assert.equal(env.pending.length, 0);
});

test("a caller's active compromise handler is preserved", async (t) => {
  const env = fixture(t);
  const errors = [];
  const release = await env.acquire(acquireFileLock, { onCompromised: (error) => errors.push(error) });
  env.directories.delete(env.lockPath);
  t.mock.timers.tick(1_000);
  env.complete("stat");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "ECOMPROMISED");
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("synchronous filesystem callbacks and throws retain their behavior", async (t) => {
  const env = fixture(t);
  for (const method of ["stat", "utimes"]) {
    const dispatch = env.fs[method];
    env.fs[method] = (...args) => {
      dispatch(...args);
      env.complete(method);
    };
  }
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  assert.equal(env.pending.length, 0);
  const dispatchError = fsError("EIO");
  env.fs.stat = () => { throw dispatchError; };
  assert.throws(() => t.mock.timers.tick(1_000), (error) => error === dispatchError);
  const releasing = release();
  env.complete("rmdir");
  await releasing;
});

test("a synchronous compromised stat callback still throws", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  const dispatch = env.fs.stat;
  env.fs.stat = (...args) => {
    dispatch(...args);
    env.complete("stat");
  };
  env.directories.delete(env.lockPath);
  assert.throws(() => t.mock.timers.tick(1_000), { code: "ECOMPROMISED" });
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("real release failures remain visible and retain the original operation error", async (t) => {
  const env = fixture(t);
  const removalError = fsError("EACCES");
  for (const operationError of [undefined, new Error("operation failed"), Object.freeze(new Error("frozen operation failed")), null]) {
    const release = await env.acquire();
    env.failRemoval(removalError);
    const hasOperationError = operationError !== undefined;
    const operation = runWithLockRelease(async () => {
      if (hasOperationError) throw operationError;
      return "completed";
    }, release);
    const rejected = assert.rejects(operation, (error) => error === (hasOperationError ? operationError : removalError));
    await nextTurn();
    env.complete("rmdir");
    await rejected;
    assert.equal(env.directories.has(env.lockPath), true);
    if (operationError && !Object.isFrozen(operationError)) assert.equal(operationError.lockReleaseError, removalError);
    env.directories.delete(env.lockPath);
    env.failRemoval(undefined);
  }
});

for (const method of ["mkdir", "stat"]) {
  test(`an acquisition ${method} error retains its code and does not start a lease`, async (t) => {
    const env = fixture(t);
    const acquisitionError = fsError("EACCES");
    env.fs[method] = (...args) => args.at(-1)(acquisitionError);
    const acquiring = assert.rejects(acquireFileLock(env.target, env.options), (error) => error === acquisitionError);
    await nextTurn();
    env.flush();
    await acquiring;
    t.mock.timers.tick(60_000);
    assert.equal(env.pending.length, 0);
    assert.equal(env.directories.size, 0);
  });
}
