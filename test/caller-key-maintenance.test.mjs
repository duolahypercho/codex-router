import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";

const cli = await import("../src/caller-key.mjs").catch(() => ({}));
const journal = await import("../src/caller-key-rotation-journal.mjs").catch(() => ({}));
const lock = await import("../src/caller-key-rotation-lock.mjs").catch(() => ({}));
const rotation = await import("../src/caller-key-rotation.mjs").catch(() => ({}));
const serviceLock = await import("../src/service-operation-lock.mjs").catch(() => ({}));

const oldKey = "o".repeat(48);
const newKey = "n".repeat(48);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function listResponse(status, body = { object: "list", data: [] }) {
  return { status, json: async () => body };
}

test("managed target detection refuses partial client state", () => {
  assert.equal(typeof cli.installedTargetsFromStatus, "function");
  assert.deepEqual(cli.installedTargetsFromStatus({
    codex: { mode: "router", config_protected: true },
    dsh: { routeInstalled: true, credentialInstalled: true },
    gemini: { installed: true, baseUrlManaged: true, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: true },
  }), ["codex", "dsh", "gemini"]);
  assert.deepEqual(cli.installedTargetsFromStatus({
    openclaw: {
      installed: true, providerInstalled: true, baseUrlManaged: true,
      configValid: true, configProtected: true,
    },
  }), ["openclaw"]);
  assert.throws(() => cli.installedTargetsFromStatus({
    openclaw: { installed: true, providerInstalled: false },
  }), /OpenClaw.*partial/i);
  assert.throws(() => cli.installedTargetsFromStatus({
    codex: { mode: "native" },
    dsh: { routeInstalled: true, credentialInstalled: false },
    gemini: {},
  }), /DeepSeek Harness.*partial/i);
  assert.throws(() => cli.installedTargetsFromStatus({
    codex: { mode: "native" }, dsh: {},
    gemini: { installed: true, baseUrlManaged: false, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: true },
  }), /Gemini.*partial/i);
  assert.throws(() => cli.installedTargetsFromStatus({
    codex: { mode: "native", managed_router_artifacts_present: true }, dsh: {}, gemini: {},
  }), /Codex.*partial/i);
  assert.throws(() => cli.installedTargetsFromStatus({
    codex: { mode: "native" }, dsh: {},
    gemini: { installed: false, baseUrlManaged: false, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: true },
  }), /Gemini.*partial/i);
});

test("caller verification requires a valid 200 model list and exact stale 401", async () => {
  assert.equal(typeof cli.verifyCallerRotation, "function");
  let calls = 0;
  await cli.verifyCallerRotation({ previousSecret: oldKey, currentSecret: newKey, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? listResponse(200) : listResponse(401, {});
  }});
  await assert.rejects(cli.verifyCallerRotation({
    previousSecret: oldKey, currentSecret: newKey,
    fetchImpl: async (url) => url.includes(newKey) ? listResponse(200) : listResponse(403, {}),
  }), /previous caller capability was not rejected with 401/i);
  await assert.rejects(cli.verifyCallerRotation({
    previousSecret: oldKey, currentSecret: newKey,
    fetchImpl: async (url) => url.includes(newKey) ? listResponse(200, { ok: true }) : listResponse(401, {}),
  }), /valid model list/i);
});

test("rotation preserves a stopped installed service and uses capability-only client refresh", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caller-key-stopped-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(typeof cli.runCallerKeyRotation, "function");
  const calls = [];
  const result = await cli.runCallerKeyRotation({
    secretPath,
    assertOwnership: () => {},
    withLock: async (run) => run(),
    withMutationLocks: async (run) => run(),
    recoverPending: async () => {},
    readClientStatuses: async () => ({
      codex: { mode: "router", config_protected: true },
      dsh: { routeInstalled: true, credentialInstalled: true },
      gemini: { installed: true, baseUrlManaged: true, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: true },
    }),
    readServiceStatus: async () => ({ installed: true, state: "stopped" }),
    runNode: async (script, args) => calls.push([script, ...args]),
    rotateSecret: async () => ({ previousSecret: oldKey, currentSecret: newKey }),
    beginJournal: async () => ({ operationId: "1".repeat(32), phase: "prepared", targets: ["codex", "dsh", "gemini"], serviceWasRunning: false }),
    updateJournal: async (state, phase) => ({ ...state, phase }),
    finalizeRotation: async () => calls.push(["finalize"]),
    recoverAfterFailure: async () => {},
  });
  assert.deepEqual(calls, [
    ["src/config-manager.mjs", "caller-capability-refresh"],
    ["src/dsh-config-manager.mjs", "caller-capability-refresh"],
    ["src/gemini-config-manager.mjs", "caller-capability-refresh"],
    ["finalize"],
  ]);
  assert.equal(result.serviceRestarted, false);
});

test("systemd active service is stopped before swap, then started and verified", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caller-key-running-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const order = [];
  await cli.runCallerKeyRotation({
    secretPath,
    assertOwnership: () => {}, withLock: async (run) => run(), withMutationLocks: async (run) => run(), recoverPending: async () => {},
    readClientStatuses: async () => ({ codex: { mode: "router", config_protected: true }, dsh: {}, gemini: {} }),
    readServiceStatus: async () => ({ installed: true, loaded: true, state: "active" }),
    runNode: async (script, args) => order.push(`${script}:${args.join(" ")}`),
    runServiceMutation: async (command) => order.push(`src/service.mjs:${command}`),
    rotateSecret: async () => { order.push("swap"); return { previousSecret: oldKey, currentSecret: newKey }; },
    beginJournal: async () => ({ operationId: "2".repeat(32), phase: "prepared", targets: ["codex"], serviceWasRunning: true }),
    updateJournal: async (state, phase) => ({ ...state, phase }),
    verifyServiceKeys: async () => order.push("verify"),
    finalizeRotation: async () => order.push("finalize"), recoverAfterFailure: async () => {},
  });
  assert.deepEqual(order, [
    "src/service.mjs:stop", "swap", "src/config-manager.mjs:caller-capability-refresh",
    "src/service.mjs:start", "verify", "finalize",
  ]);
});

test("an uninstalled service is never treated as running", () => {
  for (const status of [
    { installed: false, loaded: true, state: "active" },
    { installed: false, loaded: true, state: "running" },
  ]) {
    assert.equal(cli.managedServiceIsRunning(status), false);
  }
});

test("rotation holds service lifecycle ownership through a stopped-service transaction", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caller-key-service-lock-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let contenderEntered = false;
  let contender;
  const result = await cli.runCallerKeyRotation({
    secretPath,
    assertOwnership: () => {},
    withLock: async (run) => run(),
    withMutationLocks: async (run) => run(),
    withServiceLock: async (run) => serviceLock.withServiceOperationLock(run, {
      stateDir: directory, waitMs: 2_000, retryMs: 20, staleMs: 5_000,
    }),
    recoverPending: async () => {},
    readClientStatuses: async () => ({ codex: { mode: "router", config_protected: true }, dsh: {}, gemini: {} }),
    readServiceStatus: async () => ({ installed: true, state: "stopped" }),
    runNode: async () => {},
    rotateSecret: async () => {
      contender = serviceLock.withServiceOperationLock(async () => { contenderEntered = true; }, {
        stateDir: directory, waitMs: 2_000, retryMs: 20, staleMs: 5_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(contenderEntered, false, "concurrent service start must wait until rotation finalizes");
      return { previousSecret: oldKey, currentSecret: newKey };
    },
    beginJournal: async () => ({ operationId: "3".repeat(32), phase: "prepared", targets: ["codex"], serviceWasRunning: false }),
    updateJournal: async (state, phase) => ({ ...state, phase }),
    finalizeRotation: async () => {},
    recoverAfterFailure: async () => {},
  });
  assert.equal(result.serviceRestarted, false);
  await contender;
  assert.equal(contenderEntered, true);
});

test("caller rotation lock serializes competing operations", async () => {
  assert.equal(typeof lock.withCallerKeyRotationLock, "function");
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-lock-"));
  let releaseFirst;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    const first = lock.withCallerKeyRotationLock(async () => held, { stateDir, waitMs: 0, retryMs: 20, staleMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(lock.withCallerKeyRotationLock(async () => {}, { stateDir, waitMs: 40, retryMs: 20, staleMs: 5000 }), /rotation.*running/i);
    releaseFirst();
    await first;
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("rotation journal is private, contains no capability, and round-trips phases", () => {
  assert.equal(typeof journal.beginCallerKeyRotationJournal, "function");
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-journal-"));
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  try {
    const started = journal.beginCallerKeyRotationJournal({
      targets: ["codex", "gemini"], serviceWasRunning: true,
      operationId: "a".repeat(32), previousSecretSha256: "b".repeat(64), journalPath,
    });
    assert.equal(started.phase, "prepared");
    assert.equal(privateFileIsProtected(journalPath), true);
    const raw = readFileSync(journalPath, "utf8");
    assert.doesNotMatch(raw, new RegExp(oldKey));
    assert.throws(
      () => journal.updateCallerKeyRotationJournal(started, "verified", { journalPath }),
      /invalid caller capability rotation phase transition/i,
    );
    assert.throws(
      () => journal.updateCallerKeyRotationJournal(started, "secret-swapped", { journalPath }),
      /invalid caller capability rotation journal update/i,
    );
    const updated = journal.updateCallerKeyRotationJournal(started, "secret-swapped", { journalPath, patch: { currentSecretSha256: "c".repeat(64) } });
    assert.equal(updated.phase, "secret-swapped");
    assert.equal(journal.readCallerKeyRotationJournal({ journalPath }).phase, "secret-swapped");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("pending secret-swapped rotation restores the prior generation and refreshes clients", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-recover-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    let state = journal.beginCallerKeyRotationJournal({
      targets: ["codex", "gemini"], serviceWasRunning: false,
      operationId: "c".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    const swapped = rotation.swapCallerCapability({
      secretPath, operationId: state.operationId,
      generateSecret: () => newKey, protect: () => {},
    });
    state = journal.updateCallerKeyRotationJournal(state, "secret-swapped", {
      journalPath, patch: { currentSecretSha256: digest(swapped.currentSecret) },
    });
    const calls = [];
    const result = await cli.recoverPendingCallerKeyRotation({
      secretPath,
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      readServiceStatus: async () => ({ installed: true, state: "stopped" }),
      runNode: async (script, args) => calls.push([script, ...args]),
      secretIsProtected: () => true,
      clearJournal: ({ operationId }) => journal.clearCallerKeyRotationJournal({ operationId, journalPath }),
    });
    assert.deepEqual(result, { recovered: true, committed: false });
    assert.equal(readFileSync(secretPath, "utf8").trim(), oldKey);
    assert.deepEqual(calls, [
      ["src/config-manager.mjs", "caller-capability-refresh"],
      ["src/gemini-config-manager.mjs", "caller-capability-refresh"],
    ]);
    assert.equal(existsSync(rotation.callerCapabilityBackupPath(secretPath, state.operationId)), false);
    assert.equal(existsSync(journalPath), false);

    const repeated = await cli.recoverPendingCallerKeyRotation({
      secretPath,
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
    });
    assert.deepEqual(repeated, { recovered: false });
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("recovery restarts a launchd job loaded in a non-running transitional state", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-recover-prestarted-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    let state = journal.beginCallerKeyRotationJournal({
      targets: ["codex"], serviceWasRunning: false,
      operationId: "7".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    const swapped = rotation.swapCallerCapability({
      secretPath, operationId: state.operationId,
      generateSecret: () => newKey, protect: () => {},
    });
    state = journal.updateCallerKeyRotationJournal(state, "secret-swapped", {
      journalPath, patch: { currentSecretSha256: digest(swapped.currentSecret) },
    });
    const serviceMutations = [];
    const verifications = [];
    const result = await cli.recoverPendingCallerKeyRotation({
      secretPath,
      withServiceLock: async (run) => run(),
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      readServiceStatus: async () => ({ installed: true, loaded: true, state: "waiting" }),
      runNode: async () => {},
      runServiceMutation: async (command) => serviceMutations.push(command),
      verifyServiceKeys: async (keys) => verifications.push(keys),
      secretIsProtected: () => true,
      clearJournal: ({ operationId }) => journal.clearCallerKeyRotationJournal({ operationId, journalPath }),
    });
    assert.deepEqual(result, { recovered: true, committed: false });
    assert.deepEqual(serviceMutations, ["stop", "start"]);
    assert.deepEqual(verifications, [{ previousSecret: newKey, currentSecret: oldKey }]);
    assert.equal(readFileSync(secretPath, "utf8").trim(), oldKey);
    assert.equal(existsSync(journalPath), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recovery holds service lifecycle ownership while restoring a stopped-service generation", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-recover-service-lock-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    journal.beginCallerKeyRotationJournal({
      targets: ["codex"], serviceWasRunning: false,
      operationId: "9".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    let contenderEntered = false;
    let contender;
    const result = await cli.recoverPendingCallerKeyRotation({
      secretPath,
      withServiceLock: async (run) => serviceLock.withServiceOperationLock(run, {
        stateDir, waitMs: 2_000, retryMs: 20, staleMs: 5_000,
      }),
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      readServiceStatus: async () => ({ installed: true, state: "stopped" }),
      runNode: async () => {
        if (!contender) {
          contender = serviceLock.withServiceOperationLock(async () => { contenderEntered = true; }, {
            stateDir, waitMs: 2_000, retryMs: 20, staleMs: 5_000,
          });
          await new Promise((resolve) => setTimeout(resolve, 80));
          assert.equal(contenderEntered, false, "concurrent service start must wait until recovery finalizes");
        }
      },
      secretIsProtected: () => true,
      clearJournal: ({ operationId }) => journal.clearCallerKeyRotationJournal({ operationId, journalPath }),
    });
    assert.deepEqual(result, { recovered: true, committed: false });
    await contender;
    assert.equal(contenderEntered, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("verified rotation recovery commits the new generation without republishing", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-verified-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    let state = journal.beginCallerKeyRotationJournal({
      targets: ["codex"], serviceWasRunning: true,
      operationId: "d".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    const swapped = rotation.swapCallerCapability({
      secretPath, operationId: state.operationId,
      generateSecret: () => newKey, protect: () => {},
    });
    state = journal.updateCallerKeyRotationJournal(state, "secret-swapped", {
      journalPath, patch: { currentSecretSha256: digest(swapped.currentSecret) },
    });
    state = journal.updateCallerKeyRotationJournal(state, "clients-refreshed", { journalPath });
    state = journal.updateCallerKeyRotationJournal(state, "service-started", { journalPath });
    state = journal.updateCallerKeyRotationJournal(state, "verified", { journalPath });
    const calls = [];
    const result = await cli.recoverPendingCallerKeyRotation({
      secretPath,
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      runNode: async (...args) => calls.push(args),
      secretIsProtected: () => true,
      clearJournal: ({ operationId }) => journal.clearCallerKeyRotationJournal({ operationId, journalPath }),
    });
    assert.deepEqual(result, { recovered: true, committed: true });
    assert.equal(readFileSync(secretPath, "utf8").trim(), newKey);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(rotation.callerCapabilityBackupPath(secretPath, state.operationId)), false);
    assert.equal(existsSync(journalPath), false);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("recovery never clears a journal for an unprotected live rollback capability", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-recover-private-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    journal.beginCallerKeyRotationJournal({
      targets: [], serviceWasRunning: false,
      operationId: "e".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    const serviceMutations = [];
    await assert.rejects(cli.recoverPendingCallerKeyRotation({
      secretPath,
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      readServiceStatus: async () => ({ installed: true, state: "running" }),
      runServiceMutation: async (command) => serviceMutations.push(command),
      secretIsProtected: () => false,
      clearJournal: ({ operationId }) => journal.clearCallerKeyRotationJournal({ operationId, journalPath }),
    }), /not private/i);
    assert.deepEqual(serviceMutations, []);
    assert.equal(existsSync(journalPath), true);
    assert.equal(readFileSync(secretPath, "utf8").trim(), oldKey);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("verified recovery preserves rollback material when live capability privacy is unproven", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-verified-private-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    let state = journal.beginCallerKeyRotationJournal({
      targets: ["codex"], serviceWasRunning: false,
      operationId: "f".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    const swapped = rotation.swapCallerCapability({
      secretPath, operationId: state.operationId,
      generateSecret: () => newKey, protect: () => {},
    });
    state = journal.updateCallerKeyRotationJournal(state, "secret-swapped", {
      journalPath, patch: { currentSecretSha256: digest(swapped.currentSecret) },
    });
    state = journal.updateCallerKeyRotationJournal(state, "clients-refreshed", { journalPath });
    state = journal.updateCallerKeyRotationJournal(state, "service-started", { journalPath });
    state = journal.updateCallerKeyRotationJournal(state, "verified", { journalPath });
    await assert.rejects(cli.recoverPendingCallerKeyRotation({
      secretPath,
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      secretIsProtected: () => false,
      clearJournal: ({ operationId }) => journal.clearCallerKeyRotationJournal({ operationId, journalPath }),
    }), /not private/i);
    assert.equal(readFileSync(secretPath, "utf8").trim(), newKey);
    assert.equal(existsSync(rotation.callerCapabilityBackupPath(secretPath, state.operationId)), true);
    assert.equal(existsSync(journalPath), true);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("recovery refuses an unprotected rollback generation and preserves the journal", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "caller-key-unprotected-backup-"));
  const secretPath = path.join(stateDir, "caller-secret");
  const journalPath = path.join(stateDir, "caller-key-rotation.json");
  writeFileSync(secretPath, `${oldKey}\n`, { mode: 0o600 });
  try {
    let state = journal.beginCallerKeyRotationJournal({
      targets: ["codex"], serviceWasRunning: false,
      operationId: "9".repeat(32), previousSecretSha256: digest(oldKey), journalPath,
    });
    const swapped = rotation.swapCallerCapability({
      secretPath, operationId: state.operationId, generateSecret: () => newKey, protect: () => {},
    });
    state = journal.updateCallerKeyRotationJournal(state, "secret-swapped", {
      journalPath, patch: { currentSecretSha256: digest(swapped.currentSecret) },
    });
    const backup = rotation.callerCapabilityBackupPath(secretPath, state.operationId);
    const serviceMutations = [];
    await assert.rejects(cli.recoverPendingCallerKeyRotation({
      secretPath,
      readJournal: () => journal.readCallerKeyRotationJournal({ journalPath }),
      readServiceStatus: async () => ({ installed: true, state: "running" }),
      runServiceMutation: async (command) => serviceMutations.push(command),
      secretIsProtected: (target) => target !== backup,
    }), /rollback generation is not private/i);
    assert.deepEqual(serviceMutations, []);
    assert.equal(readFileSync(secretPath, "utf8").trim(), newKey);
    assert.equal(existsSync(backup), true);
    assert.equal(journal.readCallerKeyRotationJournal({ journalPath }).phase, "secret-swapped");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
