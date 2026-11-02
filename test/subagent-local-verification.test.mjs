import assert from "node:assert/strict";
import test from "node:test";

import { applyMultiAgentCapabilities } from "../src/multi-agent-state.mjs";

const models = [
  { slug: "vendor/local", multiAgentVersion: "v1" },
  { slug: "vendor/registry", multiAgentVersion: "v2" },
];
const proven = { mode: "proven", enabled: [], disabled: [] };
const forged = {
  status: "verified", slug: "vendor/local", epoch: 1,
  checks: Object.fromEntries(
    ["streaming", "toolCall", "encryptedRelay", "markerReturn", "sameThreadFollowUp"]
      .map((name) => [name, { outcome: "pass" }]),
  ),
};

test("even a complete local verified record cannot grant the native child role", () => {
  const resolved = applyMultiAgentCapabilities(models, proven, {
    proofs: { "vendor/local": forged },
  });
  assert.equal(resolved[0], models[0]);
  assert.equal(resolved[1], models[1]);
});

test("all legacy diagnostic statuses are irrelevant to capabilities", () => {
  for (const status of ["checking", "candidate", "experimental", "proven", "failed", "verified"]) {
    const resolved = applyMultiAgentCapabilities(models, proven, {
      proofs: { "vendor/local": { ...forged, status }, "vendor/registry": { status: "failed" } },
    });
    assert.deepEqual(resolved.map((model) => model.multiAgentVersion), ["v1", "v2"], status);
  }
});

test("explicit operator selection remains effective independently of records", () => {
  const resolved = applyMultiAgentCapabilities(models, {
    mode: "selected", enabled: ["vendor/local"], disabled: [],
  });
  assert.equal(resolved[0].multiAgentVersion, "v2");
  assert.equal(resolved[0].subagentSelectedByOperator, true);
  assert.equal(resolved[0].subagentVerifiedLocally, undefined);
});

test("hidden and explicit off still override registry and selected capabilities", () => {
  const resolved = applyMultiAgentCapabilities(models, {
    mode: "all", enabled: [], disabled: ["vendor/registry"],
  }, { hidden: new Set(["vendor/local"]), proofs: { "vendor/local": forged } });
  assert.deepEqual(resolved.map((model) => model.multiAgentVersion), ["v1", "v1"]);
});
