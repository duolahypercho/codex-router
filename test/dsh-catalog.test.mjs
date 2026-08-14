import assert from "node:assert/strict";
import test from "node:test";

import {
  DSH_CREDENTIAL_REF,
  DSH_ROUTE_ID,
  buildDshRoute,
  dshDefaultModel,
  dshModelProfile,
  renderDshRouteLines,
  unmappableEfforts,
} from "../src/dsh-catalog.mjs";

const BASE_URL = "http://127.0.0.1:4202/_codex-router/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v1";

function model(overrides = {}) {
  return {
    slug: "vendor/model",
    gatewayModel: "vendor-model",
    displayName: "Vendor Model",
    contextWindow: 262144,
    inputModalities: ["text"],
    reasoningLevels: [{ effort: "high" }],
    priority: 1,
    ...overrides,
  };
}

test("a model profile is keyed on the router slug, not the gateway id", () => {
  // `/v1/responses` resolves the requested model against MODEL_BY_SLUG; a
  // gateway id there falls through to the native GPT path, which a harness
  // request has no session for.
  const profile = dshModelProfile(model());
  assert.equal(profile.id, "vendor/model");
  assert.equal(profile.name, "Vendor Model");
  assert.equal(profile.contextWindow, 262144);
  assert.deepEqual(profile.input, ["text"]);
});

test("reasoning levels become pi-ai efforts with their own wire spelling", () => {
  const profile = dshModelProfile(
    model({ reasoningLevels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }] }),
  );
  assert.deepEqual(profile.reasoningEfforts, { low: "low", high: "high", max: "max" });
});

test("a model with no reasoning levels declares itself non-reasoning", () => {
  // Omitting the field would inherit whatever pi-ai's installed catalog says
  // about a colliding id, so the absence has to be stated rather than implied.
  const profile = dshModelProfile(model({ reasoningLevels: [] }));
  assert.equal(profile.reasoningEfforts, false);
});

test("a level pi-ai has no name for is dropped and reported", () => {
  const subject = model({ reasoningLevels: [{ effort: "high" }, { effort: "ultra" }] });
  assert.deepEqual(dshModelProfile(subject).reasoningEfforts, { high: "high" });
  assert.deepEqual([...unmappableEfforts([subject])], [["ultra", ["vendor/model"]]]);
});

test("only modalities pi-ai accepts survive", () => {
  const profile = dshModelProfile(model({ inputModalities: ["text", "image", "audio"] }));
  assert.deepEqual(profile.input, ["text", "image"]);
});

test("the route speaks the one protocol the caller endpoint serves", () => {
  const route = buildDshRoute({ models: [model()], baseUrl: BASE_URL });
  assert.equal(route.api, "openai-responses");
  assert.equal(route.baseURL, BASE_URL);
  assert.equal(route.apiKeyEnv, DSH_CREDENTIAL_REF);
  // pi-ai types its reasoning-dispatch switches only on `openai-completions`,
  // and refuses a route-level switch anywhere else. Each model's request
  // profile is applied on the router's own side of the hop instead.
  assert.equal(route.compat, undefined);
});

test("a route without a base URL is refused rather than published broken", () => {
  assert.throws(() => buildDshRoute({ models: [model()], baseUrl: "" }), /caller base URL/);
});

test("the default model is the highest-priority one, ties broken by slug", () => {
  assert.equal(
    dshDefaultModel([
      model({ slug: "b/one", priority: 5 }),
      model({ slug: "a/two", priority: 9 }),
      model({ slug: "a/one", priority: 9 }),
    ]),
    "a/one",
  );
  assert.equal(dshDefaultModel([]), undefined);
});

test("the rendered block is valid YAML at the route's own indentation", () => {
  const route = buildDshRoute({ models: [model()], baseUrl: BASE_URL });
  const lines = renderDshRouteLines(route, { indent: "    " });
  assert.equal(lines[0], `    ${DSH_ROUTE_ID}:`);
  assert.ok(lines.includes(`      baseURL: ${JSON.stringify(BASE_URL)}`));
  assert.ok(lines.includes('        - id: "vendor/model"'));
  // Every value is quoted or numeric, so a slug like `1.0` or a name like
  // `yes` cannot be reinterpreted as a number or a boolean.
  for (const line of lines.slice(1)) {
    const value = line.split(/:\s/).slice(1).join(": ").trim();
    if (!value || value === "[]") continue;
    assert.ok(
      /^(".*"|-?\d+(\.\d+)?|true|false)$/.test(value),
      `unquoted scalar in rendered YAML: ${line}`,
    );
  }
});
