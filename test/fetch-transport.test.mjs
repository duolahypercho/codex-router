import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installStableFetchTransport } from "../src/fetch-transport.mjs";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

test("the router disables HTTP/2 on its process-wide fetch dispatcher", () => {
  const created = [];
  const installed = [];

  class FakeAgent {
    constructor(options) {
      this.options = options;
      created.push(this);
    }
  }

  const dispatcher = installStableFetchTransport({
    AgentClass: FakeAgent,
    setDispatcher(value) {
      installed.push(value);
    },
  });

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].options, { allowH2: false });
  assert.equal(dispatcher, created[0]);
  assert.deepEqual(installed, [dispatcher]);
});

// The service is four long-lived processes, and setGlobalDispatcher only
// reaches the one that called it. A forwarder that skips the install keeps
// Node's HTTP/2-capable default and stays exposed to the poisoned-session
// failure this module exists to remove — so every server entry point must
// install the stable transport, including ones added after this test.
test("every long-lived server process installs the stable transport", () => {
  const serverEntryPoints = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) =>
      readFileSync(path.join(SRC_DIR, name), "utf8").includes("createServer("),
    );

  assert.ok(
    serverEntryPoints.length >= 4,
    `expected at least the four known server entry points, found: ${serverEntryPoints.join(", ")}`,
  );

  for (const name of serverEntryPoints) {
    const source = readFileSync(path.join(SRC_DIR, name), "utf8");
    assert.ok(
      source.includes("installStableFetchTransport()"),
      `${name} creates a server but never installs the stable fetch transport`,
    );
  }
});
