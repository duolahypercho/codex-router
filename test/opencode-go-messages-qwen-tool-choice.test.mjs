import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { curatableRequestProfile, requestProfileKnown } from "../src/request-profiles.mjs";

// opencode Go's Messages route answers HTTP 400 for every Qwen model the moment
// the request carries tool_choice in any form ("auto" and "none" included),
// and calls the listed tools when the field is absent. Probed live on
// 2026-09-15; MiniMax on the same route accepts tool_choice, so the profile is
// per model, not per provider.
test("Qwen behind opencode Go Messages omits tool_choice instead of downgrading it", () => {
  for (const slug of [
    "opencode-go-messages/qwen3.6-plus",
    "opencode-go-messages/qwen3.7-max",
    "opencode-go-messages/qwen3.7-plus",
    "opencode-go-messages/qwen3.8-flash",
    "opencode-go-messages/qwen3.8-max",
  ]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, slug);
    assert.equal(model.requestProfile, "omit-tool-choice", slug);
  }
  assert.equal(MODEL_BY_SLUG.get("opencode-go-messages/minimax-m3").requestProfile, undefined);
});

test("omit-tool-choice is a known, curatable request profile", () => {
  assert.equal(requestProfileKnown("omit-tool-choice"), true);
  assert.equal(curatableRequestProfile("omit-tool-choice"), true);
});
