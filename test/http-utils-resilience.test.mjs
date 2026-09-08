import assert from "node:assert/strict";
import { Readable } from "node:stream";
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
