import assert from "node:assert/strict";
import test from "node:test";

import {
  createGrokInflightGate,
  DEFAULT_GROK_MAX_INFLIGHT,
  grokInflightLimit,
  responseWithInflightRelease,
} from "../src/grok-inflight.mjs";

test("the Grok inflight cap defaults to 6 and rejects unsafe values", () => {
  assert.equal(grokInflightLimit({}), DEFAULT_GROK_MAX_INFLIGHT);
  assert.equal(grokInflightLimit({ CODEX_ROUTER_GROK_MAX_INFLIGHT: "2" }), 2);
  assert.equal(grokInflightLimit({ CODEX_ROUTER_GROK_MAX_INFLIGHT: "64" }), 64);
  for (const value of ["", "0", "-1", "abc", "6.5", "65", " 7 "]) {
    const limit = value === " 7 " ? 7 : DEFAULT_GROK_MAX_INFLIGHT;
    assert.equal(grokInflightLimit({ CODEX_ROUTER_GROK_MAX_INFLIGHT: value }), limit, value);
  }
});

test("a single acquire does not wait and the slot past the cap does", async () => {
  const gate = createGrokInflightGate(1);
  const first = await gate.acquire();
  let secondStarted = false;
  const second = gate.acquire().then((release) => {
    secondStarted = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  first();
  const releaseSecond = await second;
  assert.equal(secondStarted, true);
  releaseSecond();
});

test("six holders pass and the seventh waits until one releases", async () => {
  const gate = createGrokInflightGate(6);
  const releases = [];
  for (let index = 0; index < 6; index += 1) releases.push(await gate.acquire());
  let seventh = false;
  const waiting = gate.acquire().then((release) => {
    seventh = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seventh, false);
  releases[0]();
  const releaseSeventh = await waiting;
  assert.equal(seventh, true);
  for (const release of releases.slice(1)) release();
  releaseSeventh();
});

test("abort while waiting does not take a slot", async () => {
  const gate = createGrokInflightGate(1);
  const held = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  controller.abort();
  await rejected;
  held();
  const next = await gate.acquire();
  next();
});

test("the inflight slot stays taken until the upstream body ends", async () => {
  const gate = createGrokInflightGate(1);
  let downstream = 0;
  const release = await gate.acquire();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a"));
    },
  });
  const response = responseWithInflightRelease(new Response(stream), release);
  const pending = gate.acquire().then((next) => {
    downstream += 1;
    return next;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downstream, 0);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  const next = await pending;
  assert.equal(downstream, 1);
  next();
});
