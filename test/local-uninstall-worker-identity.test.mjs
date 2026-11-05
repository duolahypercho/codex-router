import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Run the real worker and cancellation functions with only in-memory state.
// Importing the worker would also load the host's model and credential paths.
const workerSource = readFileSync(new URL("../src/local-uninstall.mjs", import.meta.url), "utf8");
const workerMain = workerSource.slice(
  workerSource.indexOf("async function main()"),
  workerSource.indexOf("\nif (process.argv[1]"),
);
const downloadSource = readFileSync(new URL("../src/local-download.mjs", import.meta.url), "utf8");
const cancelFunction = downloadSource.slice(
  downloadSource.indexOf("export function cancelLocalDownload("),
  downloadSource.indexOf("\nexport function readLocalDownload("),
).replace("export function", "function");

function fixture(source = workerMain) {
  const pid = 1234;
  const tag = "synthetic:latest";
  let state = {
    version: 1, kind: "uninstall", tag, status: "uninstalling",
    workerPid: pid, workerIdentity: "start-1234", controllerPid: null,
  };
  const kills = [];
  const identities = [];
  let finishRemoval;
  const removal = new Promise((resolve) => { finishRemoval = resolve; });
  const readLocalDownload = () => structuredClone(state);
  const writeLocalDownload = (value) => { state = structuredClone(value); return value; };
  const main = vm.runInNewContext(`(${source})`, {
    Date,
    process: { pid, argv: ["synthetic-node", "worker", tag] },
    normalizeLocalModelTag: (value) => value,
    processStartIdentity: (value) => { identities.push(value); return "start-1234"; },
    readLocalDownload,
    writeLocalDownload,
    uninstallLocalModelTransaction: () => removal,
  });
  const cancel = vm.runInNewContext(`(${cancelFunction})`, {
    Date,
    process: { pid: 9999 },
    readLocalDownload,
    writeLocalDownload,
    isLocalOperationActive: (value) => ["downloading", "uninstalling"].includes(value?.status),
    canonicalLocalModelTag: (value) => value,
    normalizeLocalModelTag: (value) => value,
    spawnSync: () => { throw new Error("No host process may be spawned."); },
  });
  return {
    main, finishRemoval, kills, identities,
    read: readLocalDownload,
    cancel: (identity = "start-1234") => cancel(tag, {
      platform: "linux",
      identity: () => identity,
      kill: (value, signal) => kills.push({ pid: value, signal }),
    }),
  };
}

test("the uninstall worker keeps its own start identity and remains cancellable", async () => {
  const run = fixture();
  const work = run.main();
  assert.deepEqual(run.identities, [1234]);
  assert.equal(run.read().workerPid, 1234);
  assert.equal(run.read().workerIdentity, "start-1234");
  assert.equal(run.cancel().cancelled, true);
  assert.deepEqual(run.kills, [{ pid: 1234, signal: "SIGTERM" }]);
  run.finishRemoval({ cancelled: true });
  await work;
});

test("the old identity-dropping seed reproduces cancellation refusal", async () => {
  assert.match(workerMain, /^    workerIdentity,\r?$/m);
  const run = fixture(workerMain.replace(/^    workerIdentity,\r?\n/m, ""));
  const work = run.main();
  assert.equal(run.read().workerIdentity, undefined);
  assert.throws(run.cancel, /identity is unavailable or changed/);
  assert.deepEqual(run.kills, []);
  run.finishRemoval({ cancelled: true });
  await work;
});

test("a changed process identity still prevents stopping an unrelated process", async () => {
  const run = fixture();
  const work = run.main();
  assert.throws(() => run.cancel("different-start"), /identity is unavailable or changed/);
  assert.deepEqual(run.kills, []);
  run.finishRemoval({ cancelled: true });
  await work;
});
