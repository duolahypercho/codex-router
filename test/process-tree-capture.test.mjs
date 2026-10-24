import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runProcessTree } from "../src/process-tree.mjs";

async function capture(stdout, stderr, options = {}) {
  const originalSpawn = childProcess.spawn;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: () => false,
  });
  try {
    childProcess.spawn = () => {
      queueMicrotask(() => {
        // PassThrough delivers every write separately, regardless of how the
        // OS would coalesce a real pipe. Interleave the two independent streams.
        for (let index = 0; index < Math.max(stdout.length, stderr.length); index++) {
          if (stdout[index]) child.stdout.write(stdout[index]);
          if (stderr[index]) child.stderr.write(stderr[index]);
        }
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 7;
        child.emit("close", 7, null);
      });
      return child;
    };
    syncBuiltinESMExports();
    return await runProcessTree("capture-fixture.exe", [], {
      // The mock emits the Job Object helper's close, avoiding real process
      // groups or a PowerShell dependency on any host platform.
      platform: "win32", deadline: Date.now() + 5_000, ...options,
    });
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

const bytes = (buffer) => Array.from(buffer, (byte) => Buffer.from([byte]));

for (const encoding of ["utf8", "utf16le"]) {
  test(`captured ${encoding} preserves fragmented characters independently on stdout and stderr`, async () => {
    const stdout = JSON.stringify({ path: "ışık/模型/😀", status: "tamam" });
    const stderr = "échec: 診断 🛠\n";
    assert.deepEqual(await capture(
      bytes(Buffer.from(stdout, encoding)), bytes(Buffer.from(stderr, encoding)), { encoding },
    ), { status: 7, signal: null, stdout, stderr });
  });
}

for (const encoding of ["base64", "hex", "latin1"]) {
  test(`captured ${encoding} represents the complete byte stream`, async () => {
    const stdout = Buffer.from([0, 255, 195, 169, 128, 10, 42]);
    const stderr = Buffer.from([1, 2, 3, 4, 5]);
    const result = await capture(bytes(stdout), bytes(stderr), { encoding });
    assert.equal(result.stdout, stdout.toString(encoding));
    assert.equal(result.stderr, stderr.toString(encoding));
  });
}

test("captured output flushes incomplete trailing sequences at EOF", async () => {
  const stdout = Buffer.from([0x61, 0xf0, 0x9f]);
  const stderr = Buffer.from([0x62, 0xe2]);
  const result = await capture(bytes(stdout), bytes(stderr));
  assert.equal(result.stdout, stdout.toString("utf8"));
  assert.equal(result.stderr, stderr.toString("utf8"));
});

test("the shared output limit counts raw bytes, including pending characters", async () => {
  const stdout = Buffer.from("😀");
  const stderr = Buffer.from("é");
  const result = await capture(bytes(stdout), bytes(stderr), { maxOutputBytes: 6 });
  assert.equal(result.stdout, "😀");
  assert.equal(result.stderr, "é");
  await assert.rejects(
    capture(bytes(stdout), bytes(stderr), { maxOutputBytes: 5 }),
    { code: "router_operation_output_limit" },
  );
});
