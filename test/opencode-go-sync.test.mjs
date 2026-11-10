import assert from "node:assert/strict";
import test from "node:test";

import { goProtocol, planGoSync, probePendingGoModels, syncGoCatalog } from "../src/opencode-go-sync.mjs";
import { isOpenCodeGeminiModel } from "../src/opencode-gemini.mjs";

const record = (id, api, extras = {}) => ({
  id,
  name: id,
  type: "chat",
  api: { [api]: { base_url: api === "messages"
    ? "https://opencode.ai/inference/go/anthropic/v1"
    : "https://opencode.ai/inference/go/openai/v1" } },
  limit: { context: 1_048_576, output: 65_536 },
  modalities: { input: ["text", "image/png"] },
  capabilities: { reasoning: { effort: ["low", "medium", "high"] } },
  ...extras,
});

test("live Go API metadata selects each wire and retains Gemini identity", () => {
  const plan = planGoSync([
    record("new-chat", "chat-completions"),
    record("new-message", "messages"),
    record("new-response", "responses"),
    record("new-gemini", "generate-content", {
      api: { "generate-content": { base_url: "https://opencode.ai/inference/go/google/v1beta" } },
    }),
  ], []);
  assert.deepEqual(plan.additions.map((model) => model.provider), [
    "opencode-go", "opencode-go-messages", "opencode-go-responses", "opencode-go",
  ]);
  assert.equal(plan.additions[0].contextWindow, 1_048_576);
  assert.deepEqual(plan.additions[0].inputModalities, ["text", "image"]);
  assert.equal(plan.additions[0].openCodeGoManaged, true);
  assert.equal(isOpenCodeGeminiModel(plan.additions[3]), true);
});

test("ambiguous and foreign Go API records remain blocked", () => {
  assert.equal(goProtocol(record("bad", "unknown")), undefined);
  assert.equal(goProtocol(record("bad", "messages", {
    api: { messages: { base_url: "https://elsewhere.example/v1" } },
  })), undefined);
  const plan = planGoSync([record("bad", "messages", {
    api: { messages: { base_url: "https://opencode.ai/inference/go/anthropic/v1" },
      responses: { base_url: "https://opencode.ai/inference/go/openai/v1" } },
  })], []);
  assert.deepEqual(plan.blocked, ["bad"]);
  assert.deepEqual(plan.additions, []);
  assert.throws(() => planGoSync([]), /empty catalog/);
  assert.throws(() => planGoSync([record("same", "messages"), record("same", "messages")]), /duplicate/);
});

test("withdrawn routes are hidden and failed new routes stay hidden", () => {
  const plan = planGoSync([record("current", "chat-completions")], [
    { provider: "opencode-go", upstreamModel: "old", slug: "opencode-go/old" },
  ]);
  assert.deepEqual(plan.stale, ["opencode-go/old"]);
  const changedWire = planGoSync([record("current", "messages")], [
    { provider: "opencode-go", upstreamModel: "current", slug: "opencode-go/current" },
  ]);
  assert.deepEqual(changedWire.stale, ["opencode-go/current"]);
  assert.deepEqual(changedWire.blocked, ["current"]);
  const pending = probePendingGoModels([
    { slug: "opencode-go/current", upstreamModel: "current", openCodeGoManaged: true },
    { slug: "opencode-go/manual", upstreamModel: "manual", openCodeGoManaged: false },
  ], ["current", "manual"], ["opencode-go/current", "opencode-go/manual"], () => false);
  assert.deepEqual(pending.passed, []);
  assert.deepEqual(pending.failed, ["opencode-go/current"]);
});

test("dry-run sync fetches current Go records without mutating state or probing", async () => {
  const result = await syncGoCatalog({
    catalog: async () => ({ data: [record("new-chat", "chat-completions")] }),
    probe: () => { throw new Error("dry-run must not probe"); },
  });
  assert.equal(result.applied, false);
  assert.ok(result.additions.some((model) => model.upstreamModel === "new-chat"));
});

test("apply stages new routes hidden, probes, then reveals only a passing route", async () => {
  let saved = [];
  const hidden = new Set();
  const phases = [];
  const result = await syncGoCatalog({
    catalog: async () => ({ data: [
      record("good", "chat-completions"), record("bad", "messages"),
    ] }),
    apply: true,
    models: [{ provider: "opencode-go", upstreamModel: "retired", slug: "opencode-go/retired" }],
    readModels: () => saved,
    writeModels: (models) => { saved = models; },
    picker: () => ({ hidden: [...hidden] }),
    setVisible: (slugs, visible) => {
      for (const slug of slugs) visible ? hidden.delete(slug) : hidden.add(slug);
    },
    transact: async ({ mutate, restart }) => { phases.push(restart); mutate(); },
    probe: (slug) => {
      assert.ok(hidden.has(slug), "new routes must stay hidden while probed");
      return slug === "opencode-go/good";
    },
  });
  assert.deepEqual(phases, [true, false]);
  assert.deepEqual(result.passed, ["opencode-go/good"]);
  assert.deepEqual(result.failed, ["opencode-go-messages/bad"]);
  assert.ok(!hidden.has("opencode-go/good"));
  assert.ok(hidden.has("opencode-go-messages/bad"));
  assert.ok(hidden.has("opencode-go/retired"));
  assert.equal(saved.length, 2);
});
