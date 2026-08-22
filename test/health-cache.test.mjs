import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HEALTH_TTL_MS,
  DEFAULT_MAX_STALE_MS,
  createHealthCache,
} from "../src/health-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The clock is injected so these assert the caching rule itself rather than
// waiting real seconds for a TTL to lapse.
function fixedClock(start = 0) {
  const clock = { t: start };
  clock.now = () => clock.t;
  return clock;
}

// A background refresh settles a few microtasks after the stale answer is
// handed back. Let it land before moving the clock, so these assert the cache
// state a later poll actually sees rather than a half-updated entry.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a burst of polls inside the window costs one probe", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  let probes = 0;
  const probe = () => {
    probes += 1;
    return { reachable: true };
  };

  const results = await Promise.all([
    cached("gateway", probe),
    cached("gateway", probe),
    cached("gateway", probe),
  ]);
  // This is the whole point: the companion polls continuously and every poll
  // used to reach the gateway, whose access log was the bulk of a 191 MB file.
  assert.equal(probes, 1);
  for (const result of results) assert.deepEqual(result, { reachable: true });
});

test("the answer is refreshed once the window lapses", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  let probes = 0;
  const probe = () => ({ reachable: (probes += 1) === 1 });

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 2_999;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  // A service that goes down must not stay "reachable" indefinitely; the TTL
  // is the entire bound on how stale the tray's status can be.
  clock.t = 3_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: false });
  assert.equal(probes, 2);
});

test("services are cached independently", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  const seen = [];
  const probe = (name) => () => {
    seen.push(name);
    return { reachable: true };
  };

  await Promise.all([
    cached("gateway", probe("gateway")),
    cached("api", probe("api")),
    cached("oauth", probe("oauth")),
  ]);
  // One shared key would have let the gateway's answer stand in for the API
  // forwarder's, reporting a dead service as healthy.
  assert.deepEqual(seen.sort(), ["api", "gateway", "oauth"]);
});

test("a thrown probe is not cached as an answer", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes === 1) throw new Error("connection refused");
    return { reachable: true };
  };

  await assert.rejects(() => cached("gateway", probe), /connection refused/);
  // Still inside the window: a cached rejection would keep the service marked
  // broken for the full TTL even though the next probe would have succeeded.
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  assert.equal(probes, 2);
});

test("the default window is short enough for a live status display", () => {
  // The tray presents this as current service state. A long TTL turns it into
  // a stale claim, so the default is capped at a few seconds by intent.
  assert.ok(DEFAULT_HEALTH_TTL_MS > 0);
  assert.ok(DEFAULT_HEALTH_TTL_MS <= 5_000);
});

test("the router probes through the cache, not around it", () => {
  const router = readFileSync(path.join(root, "src", "router.mjs"), "utf8");
  // healthPayload calls serviceHealth three times per request; if that ever
  // goes straight to the network again the probe flood comes back silently.
  assert.match(router, /const healthCache = createHealthCache\(\{\s*staleWhileRevalidate:\s*true\s*\}\)/);
  assert.match(router, /function serviceHealth\(url\)\s*\{\s*return healthCache\(url,/);
  assert.match(router, /loopbackProbeFetch\(/);
});

test("stale-while-revalidate returns the last answer without waiting on a slow refresh", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({
    ttlMs: 3_000,
    now: clock.now,
    staleWhileRevalidate: true,
  });
  let probes = 0;
  let finishRefresh;
  const hanging = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const probe = () => {
    probes += 1;
    if (probes === 1) return { reachable: true };
    return hanging.then(() => ({ reachable: false }));
  };

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 3_000;
  const started = Date.now();
  const stale = await cached("gateway", probe);
  assert.ok(Date.now() - started < 50);
  assert.deepEqual(stale, { reachable: true });
  assert.equal(probes, 2);
  finishRefresh();
});

test("stale-while-revalidate keeps serving the last answer when the refresh throws", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({
    ttlMs: 3_000,
    now: clock.now,
    staleWhileRevalidate: true,
  });
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes === 1) return { reachable: true };
    throw new Error("connection refused");
  };

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 3_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  assert.equal(probes, 2);
});

test("stale-while-revalidate waits once the snapshot exceeds the max stale age", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({
    ttlMs: 3_000,
    maxStaleMs: 15_000,
    now: clock.now,
    staleWhileRevalidate: true,
  });
  let probes = 0;
  let finishRefresh;
  const hanging = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const probe = () => {
    probes += 1;
    if (probes === 1) return { reachable: true };
    return hanging.then(() => ({ reachable: false }));
  };

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 15_001;
  let settled;
  const pending = cached("gateway", probe).then((value) => {
    settled = value;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, undefined);
  assert.equal(probes, 2);
  finishRefresh();
  assert.deepEqual(await pending, { reachable: false });
});

test("the default max stale age is longer than the companion TTL and still bounded", () => {
  assert.ok(DEFAULT_MAX_STALE_MS > DEFAULT_HEALTH_TTL_MS);
  assert.ok(DEFAULT_MAX_STALE_MS <= 30_000);
});

// The error branch used to return the last value whenever one existed, with no
// age check and without moving `lastValueAt`. A gateway that died and kept
// refusing connections therefore reported "reachable" for as long as the router
// process lived, which is exactly the lie `maxStaleMs` exists to prevent.
test("a refresh that keeps throwing stops serving the snapshot past the max stale age", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({
    ttlMs: 3_000,
    maxStaleMs: 15_000,
    now: clock.now,
    staleWhileRevalidate: true,
  });
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes === 1) return { reachable: true };
    throw new Error("connection refused");
  };

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  // Inside the bound the last answer legitimately stands in for the failure.
  clock.t = 3_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  await settle();

  clock.t = 15_001;
  await assert.rejects(() => cached("gateway", probe), /connection refused/);
  // And it must not reappear on the next poll: a failed probe does not make
  // the snapshot it fell back to any younger.
  clock.t = 20_000;
  await assert.rejects(() => cached("gateway", probe), /connection refused/);
  assert.equal(probes, 4);
});

// The failed refresh marks its entry fresh so a burst of polls during an
// outage still costs one probe per TTL. That freshness must not become a
// second way to serve the snapshot: the value's own age is the only bound.
test("a failed refresh does not replay its snapshot inside the next TTL window", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({
    ttlMs: 3_000,
    maxStaleMs: 15_000,
    now: clock.now,
    staleWhileRevalidate: true,
  });
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes === 1) return { reachable: true };
    throw new Error("connection refused");
  };

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 14_900;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  await settle();
  assert.equal(probes, 2);
  // 200ms later the entry is still inside its TTL, but the value it holds is
  // 15.1s old -- past `maxStaleMs`, so the caller must wait for a live probe.
  clock.t = 15_100;
  await assert.rejects(() => cached("gateway", probe), /connection refused/);
  assert.equal(probes, 3);
});

// Repeated polls during an outage must still collapse: the throttle survives
// the age bound, it is only the answer that expires.
test("failed refreshes inside the bound are still throttled to one probe per window", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({
    ttlMs: 3_000,
    maxStaleMs: 15_000,
    now: clock.now,
    staleWhileRevalidate: true,
  });
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes === 1) return { reachable: true };
    throw new Error("connection refused");
  };

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 3_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  await settle();
  clock.t = 4_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 5_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  assert.equal(probes, 2);
});
