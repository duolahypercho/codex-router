import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { localTimeoutSeconds, localTransportIdleTimeoutMs } from "../src/local-timeouts.mjs";

test("local timeout defaults and overrides remain in seconds with a transport margin", () => {
  assert.equal(localTimeoutSeconds({}), 600);
  assert.equal(localTransportIdleTimeoutMs({}), 660_000);
  assert.equal(localTimeoutSeconds({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2400);
  assert.equal(localTransportIdleTimeoutMs({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2_460_000);
});

test("router routes only local and Grok through long-idle fetch", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const block = source.match(/function fetchForRoute\(route, url, init\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(block);
  assert.match(source, /const LOCAL_TRANSPORT_IDLE_TIMEOUT_MS = localTransportIdleTimeoutMs\(\);/);
  assert.match(block, /isGrokOauthRoute\(route\)[\s\S]*?bodyTimeoutMs: GROK_TRANSPORT_IDLE_TIMEOUT_MS/);
  assert.match(block, /canonicalProviderId\(route\.provider\) === "local"[\s\S]*?bodyTimeoutMs: LOCAL_TRANSPORT_IDLE_TIMEOUT_MS/);
  assert.match(block, /return fetch\(url, init\);/);
});
