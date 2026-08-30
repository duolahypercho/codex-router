import assert from "node:assert/strict";
import test from "node:test";

import {
  routedModelPreservesSearchContract,
  routedModelSearchAvailable,
  routedModelSearchMode,
  stripUnsupportedHostedSearch,
} from "../src/search-capability.mjs";

test("effective search mode follows exact model or ready sidecar evidence", () => {
  const model = { slug: "generic/plain" };
  const sidecarOptions = {
    bindingForModel: () => ({ providerId: "perplexity" }),
    providers: new Map([["perplexity", {
      id: "perplexity",
      generic: true,
      enabled: true,
      adapter: "openai-chat",
      allowPrivate: false,
      credentialRef: "credential",
      baseUrl: "https://api.perplexity.ai",
    }]]),
    providerReady: () => true,
  };

  assert.equal(routedModelSearchMode(model, { ...sidecarOptions, providerReady: () => false }), undefined);
  assert.equal(routedModelSearchMode(model, sidecarOptions), "standalone");
  assert.equal(routedModelSearchAvailable(model, sidecarOptions), true);
  assert.equal(
    routedModelSearchMode({ ...model, searchTool: { mode: "hosted" } }, sidecarOptions),
    "hosted",
  );
  assert.equal(
    routedModelSearchMode({ ...model, searchTool: { mode: "standalone" } }, sidecarOptions),
    "standalone",
  );
});

test("a disappearing sidecar invalidates a snapshotted failover contract", () => {
  let ready = true;
  const model = { slug: "generic/plain" };
  const options = {
    bindingForModel: () => ({ providerId: "perplexity" }),
    providers: new Map([["perplexity", {
      id: "perplexity",
      generic: true,
      enabled: true,
      adapter: "openai-chat",
      allowPrivate: false,
      credentialRef: "credential",
      baseUrl: "https://api.perplexity.ai",
    }]]),
    providerReady: () => ready,
  };
  const contract = { requiredMode: "standalone", hasSearchHistory: true };

  assert.equal(routedModelPreservesSearchContract(model, contract, options), true);
  ready = false;
  assert.equal(routedModelPreservesSearchContract(model, contract, options), false);
});

test("unsupported hosted search is removed without touching caller function tools", () => {
  const functionNamedSearch = {
    type: "function",
    name: "web_search",
    parameters: { type: "object" },
  };
  const shell = { type: "function", name: "shell", parameters: { type: "object" } };
  const payload = {
    web_search_options: { search_context_size: "medium" },
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    tools: [
      { type: "web_search", search_context_size: "medium" },
      shell,
      { type: "web_search_preview" },
      functionNamedSearch,
    ],
    tool_choice: "required",
  };
  const normalized = stripUnsupportedHostedSearch(payload, { model: "generic/plain" });

  assert.notEqual(normalized, payload);
  assert.equal(normalized.web_search_options, undefined);
  assert.deepEqual(normalized.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(normalized.tools, [shell, functionNamedSearch]);
  assert.equal(normalized.tool_choice, "required");
  assert.deepEqual(payload.tools.length, 4, "the caller payload must remain untouched");
});

test("empty ambient search declarations leave no dangling tool choice", () => {
  const normalized = stripUnsupportedHostedSearch({
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
  });
  assert.equal("tools" in normalized, false);
  assert.equal("tool_choice" in normalized, false);
});

test("an explicit or otherwise impossible search choice fails locally", () => {
  assert.throws(
    () => stripUnsupportedHostedSearch({
      tools: [{ type: "web_search" }, { type: "function", name: "shell" }],
      tool_choice: { type: "web_search" },
    }, { model: "generic/plain" }),
    (error) => error?.status === 400 && error?.code === "model_search_not_supported",
  );
  assert.throws(
    () => stripUnsupportedHostedSearch({
      tools: [{ type: "web_search_preview" }],
      tool_choice: "required",
    }),
    (error) => error?.status === 400 && error?.code === "model_search_not_supported",
  );
  assert.throws(
    () => stripUnsupportedHostedSearch({
      web_search_options: {},
      tool_choice: { type: "web_search" },
    }),
    (error) => error?.status === 400 && error?.code === "model_search_not_supported",
  );
});
