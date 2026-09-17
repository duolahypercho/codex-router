import assert from "node:assert/strict";
import test from "node:test";

import { freePort } from "./port-pool.mjs";

// The routing suite shares one machine with the live router service, which
// owns the production loopback block (gateway 4200, oauth 4201, router 4202,
// api 4203, grok-oauth 4208, devin-cli 4210, antigravity 4212) and whose
// spawned children draw from the OS ephemeral range when they need their own
// sockets. test/port-pool.mjs keeps every test-drawn port inside its dedicated
// non-ephemeral window for exactly this reason; these tests pin that contract
// so a future refactor cannot quietly hand a test a port the live service --
// or an unrelated process -- already holds.

// Fetch blocks several lower ports even when a TCP listener can bind them.
const POOL_FLOOR = 7_000;
// One below Linux's default ephemeral floor of 32768.
const POOL_CEILING = 32_767;
const PRODUCTION_DEFAULTS = new Set([4200, 4201, 4202, 4203, 4208, 4210, 4212]);

test("drawn ports stay outside production defaults and Antigravity POSIX lease ranges", async () => {
  // The routing integration file needs over 140 distinct ports. A pool that
  // avoids the lease range but shrinks each block to 99 still breaks CI.
  const ports = await Promise.all(Array.from({ length: 150 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  for (const port of ports) {
    assert.ok(
      port < 10_000 || port >= 30_000,
      `port ${port} overlaps Antigravity's POSIX token/refresh leases`,
    );
    assert.ok(
      Number.isInteger(port) && port >= POOL_FLOOR && port <= POOL_CEILING,
      `port ${port} is outside the test pool window [${POOL_FLOOR}, ${POOL_CEILING}]`,
    );
    assert.ok(
      !PRODUCTION_DEFAULTS.has(port),
      `port ${port} is one of the live router's production defaults`,
    );
  }
});

test("concurrent and sequential draws never hand out the same port twice", async () => {
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => freePort()));
  const sequential = [];
  for (let index = 0; index < 6; index += 1) sequential.push(await freePort());
  const all = [...concurrent, ...sequential];
  assert.equal(new Set(all).size, all.length, `duplicate draws: ${all.join(", ")}`);
});
