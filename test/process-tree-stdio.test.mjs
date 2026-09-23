import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "../src/process-tree.mjs";

const windowsOnly = { skip: process.platform !== "win32", timeout: 45_000 };
const fixture = fileURLToPath(new URL("./fixtures/process-tree-stdio-owner.mjs", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(file), `result was not written: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

function backgroundOwner(scenario) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-stdio-"));
  const owner = spawn(process.execPath, [fixture, "owner", scenario, directory], {
    detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(owner, "close");
  // EPIPE is expected at this outer input when the owner exits early.
  owner.stdin.on("error", () => {});
  return {
    owner, directory, closed,
    async dispose() {
      owner.stdin.destroy();
      owner.stdout.resume();
      owner.stderr.resume();
      try {
        if (owner.exitCode === null && owner.signalCode === null) {
          await terminateProcessTree(owner);
        }
        await closed;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

test("Windows relayed binary output is drained before an immediate caller exit", windowsOnly, async () => {
  const run = backgroundOwner("output");
  try {
    await waitForFile(path.join(run.directory, "ready.json"));
    // Both readers are deliberately withheld beyond target startup.
    await delay(100);
    assert.equal(existsSync(path.join(run.directory, "result.json")), false);
    const stdout = collect(run.owner.stdout);
    const stderr = collect(run.owner.stderr);
    const [status, signal] = await run.closed;
    assert.equal(status, 7);
    assert.equal(signal, null);
    const expected = Buffer.alloc(3 * 1024 * 1024);
    for (let index = 0; index < expected.length; index++) expected[index] = index % 256;
    assert.equal(stdout().length, expected.length);
    assert.equal(stderr().length, expected.length);
    assert.equal(digest(stdout()), digest(expected));
    assert.equal(digest(stderr()), digest(expected));
    const completed = await waitForFile(path.join(run.directory, "result.json"));
    assert.equal(completed.result.stdout, "");
    assert.equal(completed.result.stderr, "");
  } finally {
    await run.dispose();
  }
});

for (const scenario of ["input", "early-close"]) {
  test(`Windows relayed stdin handles ${scenario}`, windowsOnly, async () => {
    const run = backgroundOwner(scenario);
    try {
      const stdout = collect(run.owner.stdout);
      const stderr = collect(run.owner.stderr);
      const input = Buffer.alloc((scenario === "input" ? 2 : 16) * 1024 * 1024, 97);
      if (scenario === "input") run.owner.stdin.end(input);
      else run.owner.stdin.write(input);
      const [status, signal] = await run.closed;
      assert.equal(status, 7, stderr().toString());
      assert.equal(signal, null);
      if (scenario === "input") {
        assert.deepEqual(JSON.parse(stdout()), { count: input.length, hash: digest(input) });
        assert.equal(stderr().toString().trim(), "input-complete");
      } else {
        assert.equal(stdout().toString().trim(), "input-not-needed");
        assert.equal(stderr().length, 0);
      }
      const completed = await waitForFile(path.join(run.directory, "result.json"));
      assert.equal(completed.stdinFlowing, false);
    } finally {
      await run.dispose();
    }
  });
}

test("Windows relayed output deadlines retire the target while downstream remains unread", windowsOnly, async () => {
  const run = backgroundOwner("stalled");
  try {
    const stderr = collect(run.owner.stderr);
    const target = await waitForFile(path.join(run.directory, "ready.json"));
    // No stdout reader is attached until rejection and target retirement
    // have been verified. A synchronous Windows fd write cannot pass this.
    const completed = await waitForFile(path.join(run.directory, "result.json"));
    assert.equal(completed.error, "router_operation_timeout");
    assert.equal(completed.stdinFlowing, false);
    assert.throws(() => process.kill(target.pid, 0), { code: "ESRCH" });
    // An outstanding OS write cannot be cancelled without closing the
    // caller's global fd. Its completion is allowed after the pipe is drained.
    run.owner.stdout.resume();
    const [status, signal] = await run.closed;
    assert.equal(status, 0, stderr().toString());
    assert.equal(signal, null);
    assert.equal(stderr().length, 0);
  } finally {
    await run.dispose();
  }
});
