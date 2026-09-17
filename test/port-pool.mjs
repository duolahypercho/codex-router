import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reserving a port by binding :0, reading the number, and closing the socket
// hands that number straight back to the ephemeral pool -- and whatever is
// meant to use it does not bind for another few milliseconds. `node --test`
// runs every test file in its own process, in parallel, so a second file's
// bind(0) could be handed the same number inside that window and whichever
// bound second died:
//
//     Error: listen EADDRINUSE: address already in use 127.0.0.1:35011
//
// It failed CI at random, most often in startup-cleanup.test.mjs, which
// reserves five ports before it spawns anything and so holds five of those
// windows open at once. Eight test files had their own copy of the same helper.
//
// The fix is to stop drawing from the pool everything else draws from. Each
// test file gets a block of ports of its own, and the blocks sit *below* every
// platform's ephemeral range (Linux from 32768, macOS and Windows from 49152),
// so no other process's bind(0) can be handed one of ours and no other test
// file using this helper shares a block. What remains is a leftover from an
// earlier run of the same file, which the bind check catches by moving up the
// block.
//
// Nothing here serializes: the blocks are disjoint by construction, so no test
// file ever waits on another.
// Avoid production services, Fetch-blocked ports, and Antigravity's POSIX
// token/refresh leases (10000-29999). Sharing that lease range made a test
// listener block credential preparation for 30s and return oauth_transient.
// Both ranges stay below Linux's default ephemeral floor of 32768. Together
// they leave enough capacity for routing.test.mjs, which draws over 140 ports.
const PORT_POOL = [
  ...Array.from({ length: 3_000 }, (_, index) => 7_000 + index),
  ...Array.from({ length: 2_768 }, (_, index) => 30_000 + index),
];
const MAX_BLOCK = 256;
const MIN_BLOCK = 32;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// The same listing in every process, so every file agrees on who owns what
// without any shared state to coordinate. Files that never import this helper
// do not consume address space: counting all of them shrank routing.test.mjs's
// block below its real listener count as unrelated unit-test files were added.
// Adding a port-pool consumer reshuffles the blocks, which is harmless: one run
// sees one listing.
function blockFor(entry) {
  const files = readdirSync(TEST_DIR)
    .filter((file) => file.endsWith(".test.mjs"))
    .filter((file) =>
      readFileSync(path.join(TEST_DIR, file), "utf8").includes("./port-pool.mjs"),
    )
    .sort();
  const index = files.indexOf(path.basename(entry));
  if (index === -1) return undefined;
  const size = Math.max(
    MIN_BLOCK,
    Math.min(MAX_BLOCK, Math.floor(PORT_POOL.length / Math.max(files.length, 1))),
  );
  const start = index * size;
  // More port-consuming test files than the range can seat. Falling back keeps
  // the suite working; it just stops being race-proof, which is what it was
  // before.
  if (start + size > PORT_POOL.length) return undefined;
  return { start, size };
}

async function isFree(port) {
  const server = createServer();
  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return false;
  await new Promise((resolve) => server.close(resolve));
  return true;
}

// The old behaviour, kept for anything running outside `node --test` -- a file
// executed directly, or imported by a tool that is not the test runner. It
// carries the race, which is why it is the fallback rather than the path.
async function ephemeralPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let block;
const issued = new Set();

/**
 * A port nothing else in this test run will take.
 *
 * Still verified by binding it, because the only competitor left is this same
 * file's own leftovers from an earlier run. Ports are never handed out twice
 * within a file, since the caller binds later and a second check would find
 * the port still free.
 */
export async function freePort() {
  if (block === undefined) block = blockFor(process.argv[1] || "") ?? null;
  if (!block) return ephemeralPort();
  for (let offset = 0; offset < block.size; offset += 1) {
    const port = PORT_POOL[block.start + offset];
    if (issued.has(port)) continue;
    // Claimed before the probe, not after it. Callers draw several ports at
    // once (`Promise.all(Array.from({ length: 6 }, freePort))`), and with the
    // claim on the far side of the `await` every one of those starts at the
    // same offset and they sort themselves out only by colliding on the bind:
    // six draws deliberately provoke fifteen EADDRINUSE failures. That is
    // wasteful everywhere and worse on Windows, where each losing bind is a
    // socket the next attempt has to wait out. Claiming first makes concurrent
    // draws walk disjoint offsets and never contend at all. A port that then
    // probes busy stays claimed: it is not usable this run either way.
    issued.add(port);
    // eslint-disable-next-line no-await-in-loop -- probing in order is the point
    if (!(await isFree(port))) continue;
    return port;
  }
  throw new Error(
    `${path.basename(process.argv[1] || "this file")} exhausted its ${block.size}-port ` +
      `block at ${PORT_POOL[block.start]}; expand the pool in test/port-pool.mjs or free the leftovers`,
  );
}

// Both names were in use across the suite for the identical function.
export { freePort as openPort };
