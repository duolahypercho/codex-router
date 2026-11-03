import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  MAX_BODY_BYTES,
  readRequestBody,
  readResponseBody,
} from "../src/http-utils.mjs";

test("request body handling permits large Codex histories up to 128 MiB", () => {
  assert.equal(MAX_BODY_BYTES, 128 * 1024 * 1024);
});

test("an oversized request is rejected without retaining or abandoning its tail", async () => {
  const request = Readable.from([Buffer.from("1234"), Buffer.from("5678")]);
  await assert.rejects(readRequestBody(request, { maxBytes: 4 }), (error) => {
    assert.equal(error.status, 413);
    assert.match(error.message, /4 bytes/);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request.readableEnded, true);
});

test("upstream response bytes are bounded while streaming and canceled on overflow", async () => {
  let canceled = false;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? "1234" : "5678"));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(readResponseBody(new Response(body), { maxBytes: 4 }), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, "ERR_UPSTREAM_RESPONSE_TOO_LARGE");
    return true;
  });
  assert.equal(canceled, true);
});

test("a canceled upstream body read releases the reader instead of waiting forever", async () => {
  let canceled = false;
  const body = new ReadableStream({
    pull() {},
    cancel() {
      canceled = true;
    },
  });
  const controller = new AbortController();
  const reading = readResponseBody(new Response(body), { signal: controller.signal });
  controller.abort();
  await assert.rejects(reading, (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(canceled, true);
});

test("a bounded peek rejects without waiting for the original tee branch", async () => {
  const original = new Response("synthetic diagnostic".repeat(64));
  const peek = original.clone();
  const outcome = readResponseBody(peek, { maxBytes: 16, awaitCancellation: false })
    .then(() => undefined, (error) => error);
  try {
    const result = await Promise.race([outcome, delay(100).then(() => "pending")]);
    assert.equal(result?.code, "ERR_UPSTREAM_RESPONSE_TOO_LARGE");
    assert.equal(await original.text(), "synthetic diagnostic".repeat(64));
  } finally {
    await original.body?.cancel().catch(() => {});
    await outcome;
  }
});

test("owned upstream reads still await their cancellation cleanup", async () => {
  let finishCancellation;
  let cancellationStarted = false;
  const cleanup = new Promise((resolve) => { finishCancellation = resolve; });
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17)); },
    cancel() { cancellationStarted = true; return cleanup; },
  });
  let settled = false;
  const reading = readResponseBody(new Response(body), { maxBytes: 16 })
    .catch((error) => { settled = true; return error; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellationStarted, true);
  assert.equal(settled, false);
  finishCancellation();
  assert.equal((await reading).code, "ERR_UPSTREAM_RESPONSE_TOO_LARGE");
});

test("an aborted peek also leaves completion to the original branch owner", async () => {
  let canceled = false;
  const original = new Response(new ReadableStream({
    pull() {},
    cancel() { canceled = true; },
  }));
  const controller = new AbortController();
  const outcome = readResponseBody(original.clone(), {
    signal: controller.signal, awaitCancellation: false,
  }).then(() => undefined, (error) => error);
  controller.abort();
  try {
    const result = await Promise.race([outcome, delay(100).then(() => "pending")]);
    assert.equal(result?.name, "AbortError");
    assert.equal(canceled, false);
  } finally {
    await original.body.cancel();
    await outcome;
  }
  assert.equal(canceled, true);
});
