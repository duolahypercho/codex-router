import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installedTargetsFromStatus, runCallerKeyRotation } from "../src/caller-key.mjs";

const oldKey = "o".repeat(48);

test("caller-key rotation selects only complete managed integrations", () => {
  assert.throws(() => installedTargetsFromStatus({
    codex: { mode: "native" }, dsh: {},
    gemini: { installed: true, baseUrlManaged: true, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: false },
  }), /Gemini.*partial/i);
  assert.deepEqual(installedTargetsFromStatus({
    codex: { mode: "router", config_protected: true },
    dsh: { routeInstalled: true, credentialInstalled: true },
    gemini: { installed: true, baseUrlManaged: true, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: true },
  }), ["codex", "dsh", "gemini"]);
  assert.deepEqual(installedTargetsFromStatus({
    openclaw: {
      installed: true, providerInstalled: true, baseUrlManaged: true,
      configValid: true, configProtected: true,
    },
  }), ["openclaw"]);
  assert.throws(() => installedTargetsFromStatus({
    openclaw: { installed: true, providerInstalled: true, baseUrlManaged: false },
  }), /OpenClaw.*partial/i);
  assert.deepEqual(installedTargetsFromStatus({
    codex: { mode: "native" }, dsh: {}, gemini: {},
  }), []);
  assert.throws(() => installedTargetsFromStatus({
    codex: { mode: "native", managed_router_artifacts_present: true },
    dsh: {}, gemini: {},
  }), /Codex.*partial/i);
  assert.throws(() => installedTargetsFromStatus({
    codex: { mode: "native" }, dsh: {},
    gemini: { installed: false, baseUrlManaged: false, envExists: true, documentReadable: true, conflicts: [], managedBlockPresent: true },
  }), /Gemini.*partial/i);
  assert.throws(() => installedTargetsFromStatus({
    codex: { mode: "native" },
    dsh: { routeInstalled: false, credentialInstalled: true },
    gemini: {},
  }), /DeepSeek Harness.*partial/i);
});

test("caller-key rotation checks state ownership before any transaction work", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caller-key-cli-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${oldKey}\n`);
  const order = [];
  try {
    await runCallerKeyRotation({
      secretPath,
      assertOwnership: () => order.push("ownership"),
      withLock: async (run) => { order.push("lock"); return run(); },
      withMutationLocks: async (run) => run(),
      recoverPending: async () => order.push("recover"),
      readClientStatuses: async () => { order.push("clients"); return { codex: {}, dsh: {}, gemini: {} }; },
      readServiceStatus: async () => { order.push("service"); return { installed: false, state: "stopped" }; },
      beginJournal: async ({ previousSecretSha256 }) => ({ operationId: "a".repeat(32), phase: "prepared", targets: [], serviceWasRunning: false, previousSecretSha256 }),
      rotateSecret: async () => ({ previousSecret: oldKey, currentSecret: "n".repeat(48) }),
      updateJournal: async (state, phase) => ({ ...state, phase }),
      finalizeRotation: async () => order.push("finalize"),
      recoverAfterFailure: async () => {},
    });
    assert.deepEqual(order.slice(0, 5), ["ownership", "lock", "recover", "clients", "service"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
