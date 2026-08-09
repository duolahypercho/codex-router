import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INITIAL_PROBE_DELAY_MS,
  INITIAL_PROBE_TIMEOUT_MS,
  MAX_PROBE_DELAY_MS,
  MAX_PROBE_TIMEOUT_MS,
  probeDelayMs,
  probeTimeoutMs,
} from "../src/health-backoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the first probes stay fast so a healthy service is seen immediately", () => {
  // Backing off must not make normal startup feel slower; the common case is
  // a service that is ready within a second.
  assert.equal(probeDelayMs(0), INITIAL_PROBE_DELAY_MS);
  assert.ok(probeDelayMs(1) < 500);
});

test("the delay grows and then holds at the cap", () => {
  assert.ok(probeDelayMs(2) > probeDelayMs(1));
  assert.ok(probeDelayMs(5) > probeDelayMs(3));
  assert.equal(probeDelayMs(50), MAX_PROBE_DELAY_MS);
  // Unbounded growth would overshoot the caller's timeout with one long sleep.
  assert.equal(probeDelayMs(1000), MAX_PROBE_DELAY_MS);
});

test("a nonsense attempt falls back to the initial delay", () => {
  // Never return NaN or a negative into setTimeout, which would busy-loop.
  assert.equal(probeDelayMs(Number.NaN), INITIAL_PROBE_DELAY_MS);
  assert.equal(probeDelayMs(-1), INITIAL_PROBE_DELAY_MS);
  assert.equal(probeDelayMs(Number.POSITIVE_INFINITY), MAX_PROBE_DELAY_MS);
});

test("a slow gateway boot costs far fewer probes than a flat interval", () => {
  // The gateway is allowed 300 seconds to cold start, and each probe is a
  // gateway access-log line. This is the whole reason for the change.
  const budgetMs = 300_000;
  let elapsed = 0;
  let probes = 0;
  while (elapsed < budgetMs) {
    elapsed += probeDelayMs(probes);
    probes += 1;
  }
  const flat = Math.ceil(budgetMs / INITIAL_PROBE_DELAY_MS);
  assert.ok(probes < flat / 5, `${probes} probes should be far below the flat ${flat}`);
});

test("startup polling uses the backoff rather than a fixed sleep", () => {
  // The loop moved out of start.mjs so it could be tested directly, but the
  // guard is the same: a leftover constant sleep would silently restore the
  // flat-interval flood.
  const probe = readFileSync(path.join(root, "src", "health-probe.mjs"), "utf8");
  assert.match(probe, /probeDelayMs\(attempt\)/);
  assert.doesNotMatch(probe, /setTimeout\(resolve, 200\)/);
  const start = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(start, /health-probe\.mjs/);
});

test("the first probe window is unchanged so early failures surface as fast as ever", () => {
  // Widening the window must not cost responsiveness at the start of the loop:
  // the first probe is the same 1 s it always was, so a crash or an interrupt
  // is still noticed within a second even before the exit-abort path.
  assert.equal(probeTimeoutMs(0), INITIAL_PROBE_TIMEOUT_MS);
  assert.equal(INITIAL_PROBE_TIMEOUT_MS, 1_000);
});

test("the probe window widens for a starved machine and then holds at the cap", () => {
  // A flat 1 s window is smaller than a live-but-starved service's response
  // time under fork-storm contention, which is what declared a healthy
  // forwarder dead.
  assert.ok(probeTimeoutMs(1) > probeTimeoutMs(0));
  assert.ok(probeTimeoutMs(4) > 3 * INITIAL_PROBE_TIMEOUT_MS);
  assert.equal(probeTimeoutMs(50), MAX_PROBE_TIMEOUT_MS);
  // Unbounded growth would let one probe swallow the whole budget, and the
  // loop would stop re-checking for a crashed child.
  assert.equal(probeTimeoutMs(1000), MAX_PROBE_TIMEOUT_MS);
  assert.ok(MAX_PROBE_TIMEOUT_MS < 30_000);
});

test("a nonsense probe window falls back to the initial timeout", () => {
  assert.equal(probeTimeoutMs(Number.NaN), INITIAL_PROBE_TIMEOUT_MS);
  assert.equal(probeTimeoutMs(-1), INITIAL_PROBE_TIMEOUT_MS);
  assert.equal(probeTimeoutMs(Number.POSITIVE_INFINITY), MAX_PROBE_TIMEOUT_MS);
});

test("a starved-but-healthy service fits several widening probes inside one budget", () => {
  // The forwarders get 30 s. With aborted probes retried immediately (an abort
  // is not evidence, and the window it already spent is backoff enough) the
  // budget must buy a window far wider than the 1.4 s that used to fail.
  let elapsed = 0;
  let attempt = 0;
  let widest = 0;
  while (elapsed < 30_000) {
    widest = probeTimeoutMs(attempt);
    elapsed += widest;
    attempt += 1;
  }
  assert.ok(widest >= 7_000, `widest window inside the budget was only ${widest} ms`);
});
