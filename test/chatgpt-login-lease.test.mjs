import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  CHATGPT_LOGIN_LEASE_MAX_AGE_MS,
  chatGPTLoginAuthChanged,
  chatGPTLoginLeaseCompletionCandidate,
  chatGPTLoginLeasePath,
  chatGPTLoginLeaseStatus,
  clearChatGPTLoginLease,
  createChatGPTLoginLease,
} from "../src/chatgpt-login-lease.mjs";
import {
  chatGPTSubscriptionAccountHome,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";
import { removeChatGPTProfileAccount } from "../src/chatgpt-profile-switch.mjs";
import { protectPrivateFile } from "../src/file-security.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-login-lease-"));
  const options = {
    filePath: path.join(root, "pool.json"),
    homesDir: path.join(root, "accounts"),
    primaryHome: path.join(root, "primary"),
    switchPath: path.join(root, "switch.json"),
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  };
  return { root, options };
}

test("core removal refuses a durable login owner after the GUI lifecycle is gone", async () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "owner-start-identity",
    now: 1_000,
  });
  await assert.rejects(
    removeChatGPTProfileAccount(account.id, {
      ...options,
      loginLeaseIdentity: () => "owner-start-identity",
      now: 2_000,
    }),
    /browser sign-in is in progress/i,
  );
  assert.ok(readChatGPTAccountPoolState(options.filePath).accounts[account.id]);
  assert.equal(existsSync(chatGPTSubscriptionAccountHome(account.id, options)), true);
  assert.equal(existsSync(chatGPTLoginLeasePath(account.id, options)), true);
});

test("a bounded stale login owner is cleaned before direct core removal", async () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "departed-owner",
    now: 1_000,
  });
  const result = await removeChatGPTProfileAccount(account.id, {
    ...options,
    loginLeaseIdentity: () => "replacement-owner",
    now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
  });
  assert.equal(result.removed.id, account.id);
  assert.equal(readChatGPTAccountPoolState(options.filePath).accounts[account.id], undefined);
  assert.equal(existsSync(chatGPTSubscriptionAccountHome(account.id, options)), false);
});

test("changed running auth becomes a recovery candidate while changed reservation stays fail-closed", () => {
  for (const phase of ["running", "reserved"]) {
    const { options } = fixture();
    const account = createChatGPTSubscriptionAccount(options);
    const authPath = path.join(chatGPTSubscriptionAccountHome(account.id, options), "auth.json");
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "old", account_id: "same" } }), { mode: 0o600 });
    const lease = createChatGPTLoginLease(account.id, 4242, {
      homesDir: options.homesDir,
      identity: () => "departed-owner",
      now: 1_000,
      phase,
    });
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "fresh", account_id: "same" } }), { mode: 0o600 });
    assert.equal(chatGPTLoginAuthChanged(account.id, lease, options), true);
    const status = chatGPTLoginLeaseStatus(account.id, {
      homesDir: options.homesDir,
      identity: () => "replacement-owner",
      now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
    });
    assert.equal(status.active, true);
    if (phase === "running") {
      assert.equal(status.completionPending, true);
      assert.deepEqual(chatGPTLoginLeaseCompletionCandidate(account.id, {
        homesDir: options.homesDir,
        identity: () => "replacement-owner",
        now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
      }), lease);
    } else {
      assert.equal(status.attentionRequired, true);
      assert.equal(chatGPTLoginLeaseCompletionCandidate(account.id, {
        homesDir: options.homesDir,
        identity: () => "replacement-owner",
        now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
      }), undefined);
    }
    assert.equal(clearChatGPTLoginLease(account.id, lease, options), true);
  }
});

test("an ended reservation with unchanged auth stays fail-closed for an unattached child", () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const lease = createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "departed-parent",
    now: 1_000,
    phase: "reserved",
  });
  const status = chatGPTLoginLeaseStatus(account.id, {
    homesDir: options.homesDir,
    identity: () => "replacement-process",
    now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
  });
  assert.equal(status.active, true);
  assert.equal(status.stale, true);
  assert.equal(status.attentionRequired, true);
  assert.equal(existsSync(chatGPTLoginLeasePath(account.id, options)), true);
  assert.equal(chatGPTLoginLeaseCompletionCandidate(account.id, {
    homesDir: options.homesDir,
    identity: () => "replacement-process",
    now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
  }), undefined);
  assert.equal(clearChatGPTLoginLease(account.id, lease, options), true);
});

test("age never clears a lease when process ownership is unknown", () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const lease = createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "owner",
    now: 1_000,
  });
  const status = chatGPTLoginLeaseStatus(account.id, {
    homesDir: options.homesDir,
    identity: () => undefined,
    now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
  });
  assert.equal(status.active, true);
  assert.equal(status.uncertain, true);
  assert.equal(status.attentionRequired, true);
  assert.equal(existsSync(chatGPTLoginLeasePath(account.id, options)), true);
  assert.equal(clearChatGPTLoginLease(account.id, lease, options), true);
});

test("exclusive durable ownership refuses a concurrent login and survives GUI restart", async () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const leaseModule = pathToFileURL(path.resolve("src/chatgpt-login-lease.mjs")).href;
  const ownerSource = `
    import { createChatGPTLoginLease } from ${JSON.stringify(leaseModule)};
    createChatGPTLoginLease(${JSON.stringify(account.id)}, process.pid, {
      homesDir: ${JSON.stringify(options.homesDir)}
    });
    process.stdout.write("ready\\n");
    setTimeout(() => {}, 30_000);
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerSource], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  owner.stdout.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("lease owner did not start")), 20_000);
    owner.once("error", reject);
    owner.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
    owner.once("close", (code) => reject(new Error(`lease owner exited early (${code})`)));
  });
  try {
    const contenderSource = `
      import { createChatGPTLoginLease } from ${JSON.stringify(leaseModule)};
      try {
        createChatGPTLoginLease(${JSON.stringify(account.id)}, process.pid, {
          homesDir: ${JSON.stringify(options.homesDir)}
        });
        process.stdout.write("claimed");
      } catch (error) {
        process.stdout.write(error.message);
      }
    `;
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e", contenderSource], {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(contender.status, 0, contender.stderr);
    assert.match(contender.stdout, /already in progress/i);
    await assert.rejects(
      removeChatGPTProfileAccount(account.id, options),
      /browser sign-in is in progress/i,
    );
  } finally {
    owner.kill("SIGKILL");
    await new Promise((resolve) => owner.once("close", resolve));
  }

  // The exact process probe proves the detached writer is absent and the v3
  // pre-auth digest proves it wrote nothing, so restart cleanup is immediate.
  const removed = await removeChatGPTProfileAccount(account.id, options);
  assert.equal(removed.removed.id, account.id);
});

test("an old cross-process cleanup cannot unlink a newly recreated live lease", async () => {
  const { root, options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const oldLease = createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "old-owner",
    now: 1_000,
  });
  const moduleUrl = pathToFileURL(path.resolve("src/chatgpt-login-lease.mjs")).href;
  const readyPath = path.join(root, "old-clear-ready");
  const goPath = path.join(root, "old-clear-go");
  const clearerSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { clearChatGPTLoginLease } from ${JSON.stringify(moduleUrl)};
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const result = clearChatGPTLoginLease(${JSON.stringify(account.id)}, ${JSON.stringify(oldLease)}, {
      homesDir: ${JSON.stringify(options.homesDir)},
      beforeRelocate: () => {
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        process.stdout.write("ready\\n");
        while (!existsSync(${JSON.stringify(goPath)})) Atomics.wait(sleeper, 0, 0, 10);
      }
    });
    process.stdout.write(JSON.stringify({ result }));
  `;
  const clearer = spawn(process.execPath, ["--input-type=module", "-e", clearerSource], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  clearer.stdout.setEncoding("utf8");
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("old cleanup did not pause")), 10_000);
    clearer.once("error", reject);
    clearer.once("close", (code) => reject(new Error(`old cleanup exited early (${code})`)));
    clearer.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  assert.equal(clearChatGPTLoginLease(account.id, oldLease, { homesDir: options.homesDir }), true);
  const newLease = createChatGPTLoginLease(account.id, 5252, {
    homesDir: options.homesDir,
    identity: () => "new-owner",
    now: 2_000,
  });
  writeFileSync(goPath, "go");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("old cleanup did not finish")), 10_000);
    clearer.once("error", reject);
    clearer.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`old cleanup failed (${code})`));
    });
  });
  assert.match(output, /"result":false/);
  assert.equal(clearChatGPTLoginLease(account.id, oldLease, { homesDir: options.homesDir }), false);
  assert.deepEqual(
    chatGPTLoginLeaseStatus(account.id, {
      homesDir: options.homesDir,
      identity: (pid) => pid === 5252 ? "new-owner" : undefined,
      now: 3_000,
    }),
    { active: true, stale: false, pid: 5252 },
  );
  assert.equal(clearChatGPTLoginLease(account.id, newLease, { homesDir: options.homesDir }), true);
});
