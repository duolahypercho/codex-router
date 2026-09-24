import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runProcessTree } from "../src/process-tree.mjs";

async function withForwardedWrite(writeImpl, check) {
  const streams = [process.stdin, process.stdout, process.stderr];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  const originalSpawn = childProcess.spawn;
  const originalWrite = fs.write;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
  });
  try {
    streams.forEach((stream) => Object.defineProperty(stream, "isTTY", { configurable: true, value: undefined }));
    childProcess.spawn = () => {
      queueMicrotask(() => {
        child.stdout.end(Buffer.from([0, 255, 195, 169, 128, 10]));
        child.stderr.end();
        child.stdin.destroy();
        child.exitCode = 7;
        child.emit("close", 7, null);
      });
      return child;
    };
    fs.write = writeImpl;
    syncBuiltinESMExports();
    await check((timeoutMs = 1_000) => runProcessTree("worker.exe", [], {
      platform: "win32", stdio: "inherit", deadline: Date.now() + timeoutMs,
    }));
  } finally {
    childProcess.spawn = originalSpawn;
    fs.write = originalWrite;
    syncBuiltinESMExports();
    streams.forEach((stream, index) => {
      if (descriptors[index]) Object.defineProperty(stream, "isTTY", descriptors[index]);
      else delete stream.isTTY;
    });
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("forwarded binary output is completed across partial asynchronous writes", async () => {
  const chunks = [];
  await withForwardedWrite((fd, buffer, offset, length, position, callback) => {
    assert.equal(fd, process.stdout.fd);
    assert.equal(position, null);
    const written = Math.min(length, 2);
    chunks.push(Buffer.from(buffer.subarray(offset, offset + written)));
    setTimeout(() => callback(null, written), 5);
  }, async (run) => {
    assert.deepEqual(await run(), { status: 7, signal: null, stdout: "", stderr: "" });
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 195, 169, 128, 10]));
    assert.equal(chunks.length, 3);
  });
});

test("zero-progress forwarded writes are rejected", async () => {
  await withForwardedWrite((_fd, _buffer, _offset, _length, _position, callback) => {
    setImmediate(() => callback(null, 0));
  }, async (run) => {
    await assert.rejects(run(), /zero bytes were written/);
  });
});

for (const lateError of [false, true]) {
  test(`a deadline survives child close and a pending output write (late error: ${lateError})`, async () => {
    let finishWrite;
    let writes = 0;
    const keepAlive = setTimeout(() => {}, 2_000);
    const listeners = process.stdout.listenerCount("error");
    try {
      await withForwardedWrite((_fd, _buffer, _offset, _length, _position, callback) => {
        writes += 1;
        finishWrite = callback;
      }, async (run) => {
        await assert.rejects(run(100), { code: "router_operation_timeout" });
        assert.equal(typeof finishWrite, "function");
        // A late partial write must not start another write after cancellation.
        // A late OS error is delivered through its callback without an unhandled
        // rejection after the operation has already been rejected.
        finishWrite(lateError ? Object.assign(new Error("output pipe closed"), { code: "EPIPE" }) : null, 1);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(writes, 1);
      });
      assert.equal(process.stdout.listenerCount("error"), listeners);
    } finally {
      clearTimeout(keepAlive);
    }
  });
}
