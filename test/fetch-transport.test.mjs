import assert from "node:assert/strict";
import test from "node:test";

import { installStableFetchTransport } from "../src/fetch-transport.mjs";

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
