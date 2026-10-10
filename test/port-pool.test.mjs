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

const POOL_FLOOR = 5_000;
// One below Linux's default ephemeral floor of 32768.
const POOL_CEILING = 32_767;
const PRODUCTION_DEFAULTS = new Set([4200, 4201, 4202, 4203, 4208, 4210, 4212]);

test("drawn ports stay inside the dedicated pool window and off production defaults", async () => {
  const ports = await Promise.all(Array.from({ length: 24 }, () => freePort()));
  for (const port of ports) {
    assert.ok(
      Number.isInteger(port) && port >= POOL_FLOOR && port <= POOL_CEILING,
      `port ${port} is outside the test pool window [${POOL_FLOOR}, ${POOL_CEILING}]`,
    );
    assert.ok(
      !PRODUCTION_DEFAULTS.has(port),
      `port ${port} is one of the live router's production defaults`,
    );
    assert.ok(
      port < 10_000 || port >= 30_000,
      `port ${port} overlaps the Antigravity token or refresh lease window`,
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
