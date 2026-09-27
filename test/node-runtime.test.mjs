import assert from "node:assert/strict";
import test from "node:test";

import { routerNodeBinary } from "../src/node-runtime.mjs";

test("routerNodeBinary prefers the configured runtime", () => {
  assert.equal(
    routerNodeBinary({ CODEX_ROUTER_NODE_BIN: "/stable/node" }, "/deleted/node"),
    "/stable/node",
  );
});

test("routerNodeBinary falls back without a configured runtime", () => {
  assert.equal(routerNodeBinary({}, "/deleted/node"), "/deleted/node");
});
