import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "router-lock-release-errors-"));
const env = {
  MODEL_ROUTER_STATE_DIR: root,
  CODEX_HOME: path.join(root, "codex"),
  CODEX_ROUTER_NO_DISCOVERY: "0",
};
const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const { withLoginFreeRefreshLock } = await import("../src/login-free-refresh-lock.mjs");
const { withServiceOperationLock } = await import("../src/service-operation-lock.mjs");
const { withCallerKeyRotationLock } = await import("../src/caller-key-rotation-lock.mjs");
const { withProviderCatalogLock } = await import("../src/provider-catalog-lock.mjs");
const { withModelOverlayLock } = await import("../src/model-overlay-lock.mjs");
const { withCatalogPublicationLock } = await import("../src/catalog-publication-lock.mjs");
const { withProviderApiKeyPoolLock } = await import("../src/provider-api-key-pool.mjs");
const { withChatGPTAccountPoolLock } = await import("../src/chatgpt-account-pool.mjs");

const cases = [
  ["login-free refresh", withLoginFreeRefreshLock, "login-free-refresh-operation.lock", "lockReleaseError"],
  ["service operation", withServiceOperationLock, "service-operation.lock", "lockReleaseError"],
  ["caller-key rotation", withCallerKeyRotationLock, "caller-key-rotation.lock", "callerKeyRotationLockReleaseError"],
  ["provider catalog", withProviderCatalogLock, "provider-catalog-transaction.lock", "providerCatalogLockReleaseError"],
  ["model overlay", withModelOverlayLock, "model-overlay-transaction.lock", "modelOverlayLockReleaseError"],
  ["catalog publication", withCatalogPublicationLock, "catalog-publication.lock", "catalogLockReleaseError"],
  ["provider key pool", withProviderApiKeyPoolLock, "pool.json.pool-lock", "lockReleaseError"],
  ["ChatGPT account pool", withChatGPTAccountPoolLock, "pool.json.pool-lock.lock", "lockReleaseError"],
];

function assertRemovalError(error) {
  // A file inside the real lock directory makes the actual rmdir fail on
  // every platform, without mocking the helper or the third-party library.
  assert.ok(["ENOTEMPTY", "EEXIST"].includes(error.code), `Unexpected removal error: ${error.code}`);
  assert.equal(error.syscall, "rmdir");
}

for (const [name, withLock, directoryName, releaseErrorProperty] of cases) {
  test(`${name} reports real release failure and preserves a failed operation`, async () => {
    const stateDir = mkdtempSync(path.join(root, "case-"));
    const lockDirectory = path.join(stateDir, directoryName);
    const options = { stateDir, filePath: path.join(stateDir, "pool.json"), waitMs: 100, retryMs: 10 };
    for (const fails of [false, true]) {
      const operationError = new Error(`${name} mutation failed`);
      operationError.rollbackSafe = true;
      await assert.rejects(withLock(async () => {
        writeFileSync(path.join(lockDirectory, "removal-blocker"), "fixture");
        if (fails) throw operationError;
        return "mutation succeeded";
      }, options), (error) => {
        if (fails) {
          assert.equal(error, operationError);
          assert.equal(error.rollbackSafe, true);
          assertRemovalError(error[releaseErrorProperty]);
        } else {
          assertRemovalError(error.cause || error);
        }
        return true;
      });
      rmSync(lockDirectory, { recursive: true });
      assert.equal(await withLock(async () => "subsequent operation", options), "subsequent operation");
    }
  });
}
