import assert from "node:assert/strict";
import test from "node:test";

import {
  markChatWireSearchHistory,
  usesChatCompletionsWire,
  webSearchCallMarkerText,
  webSearchCallQuery,
} from "../src/chat-wire-search-history.mjs";

test("only a Responses-surface provider keeps the structured search item", () => {
  // litellm-config.mjs writes `use_chat_completions_api: true` for every
  // deployment whose protocol is not openai-responses, so those are exactly the
  // routes whose web_search_call items LiteLLM discards.
  assert.equal(usesChatCompletionsWire({ protocol: "openai-responses" }), false);
  assert.equal(usesChatCompletionsWire({ protocol: "openai" }), true);
  assert.equal(usesChatCompletionsWire({ protocol: "anthropic" }), true);
  assert.equal(usesChatCompletionsWire(undefined), true);
});

test("the replayed query is read from the action or the legacy top level", () => {
  assert.equal(
    webSearchCallQuery({ type: "web_search_call", action: { type: "search", query: "北京今天天气" } }),
    "北京今天天气",
  );
  assert.equal(webSearchCallQuery({ type: "web_search_call", query: "  spaced  " }), "spaced");
  assert.equal(webSearchCallQuery({ type: "web_search_call" }), undefined);
  assert.equal(webSearchCallQuery({ type: "web_search_call", action: { query: "   " } }), undefined);
});

test("a completed call becomes a marker naming its query", () => {
  const text = webSearchCallMarkerText({
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "北京今天天气" },
  });
  assert.equal(text, "[completed web search: 北京今天天气]");
});

test("a call that did not complete is not reported as one that did", () => {
  // Telling the model a failed search "completed" invites it to invent results.
  assert.equal(
    webSearchCallMarkerText({ type: "web_search_call", status: "failed", action: { query: "weather" } }),
    "[web search (failed): weather]",
  );
  assert.equal(
    webSearchCallMarkerText({ type: "web_search_call", status: "in_progress" }),
    "[web search (in_progress)]",
  );
});

test("a missing status is treated as completed, and a missing query is omitted", () => {
  assert.equal(webSearchCallMarkerText({ type: "web_search_call" }), "[completed web search]");
  assert.equal(
    webSearchCallMarkerText({ type: "web_search_call", status: "   " }),
    "[completed web search]",
  );
});

test("search items are replaced in place and every other item is untouched", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "web_search_call", id: "ws_1", status: "completed", action: { query: "北京今天天气" } },
    { type: "function_call", name: "shell", call_id: "c1", arguments: "{}" },
  ];
  const { input: marked, replaced } = markChatWireSearchHistory(input);

  assert.equal(replaced, 1);
  assert.equal(marked.length, 3);
  // Position is preserved: the marker has to sit where the search happened.
  assert.deepEqual(marked[0], input[0]);
  assert.deepEqual(marked[2], input[2]);
  assert.deepEqual(marked[1], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "[completed web search: 北京今天天气]" }],
  });
  // The caller's array is not mutated.
  assert.equal(input[1].type, "web_search_call");
});

test("several search calls each keep their own query", () => {
  const { input: marked, replaced } = markChatWireSearchHistory([
    { type: "web_search_call", action: { query: "first" } },
    { type: "web_search_call", action: { query: "second" } },
  ]);
  assert.equal(replaced, 2);
  assert.deepEqual(marked.map((item) => item.content[0].text), [
    "[completed web search: first]",
    "[completed web search: second]",
  ]);
});

test("a batched search keeps every query in the replayed history", () => {
  const call = {
    type: "web_search_call", status: "completed",
    action: { type: "search", queries: ["  Ankara weather ", "İstanbul weather", "", null, 42] },
  };
  const before = structuredClone(call);
  const marked = markChatWireSearchHistory([call]);
  assert.equal(marked.replaced, 1);
  assert.equal(marked.input[0].content[0].text,
    '[completed web search: queries=["Ankara weather","İstanbul weather"]]');
  assert.deepEqual(call, before);
});

test("page opens and in-page finds retain their own action details and status", () => {
  assert.equal(webSearchCallMarkerText({
    status: "completed", action: { type: "open_page", url: "https://example.com/guide" },
  }), "[completed web page open: https://example.com/guide]");
  assert.equal(webSearchCallMarkerText({
    status: "failed", action: { type: "find_in_page", url: "https://example.com/guide", pattern: "install" },
  }), '[web page find (failed): url="https://example.com/guide", pattern="install"]');
});

test("new action shapes keep the legacy query and missing-detail contracts", () => {
  assert.equal(webSearchCallMarkerText({
    action: { type: "search", query: "one", queries: ["one", "two"] },
  }), '[completed web search: queries=["one","two"]]');
  assert.equal(webSearchCallMarkerText({ action: { type: "search", queries: [] }, query: "legacy" }),
    "[completed web search: legacy]");
  assert.equal(webSearchCallMarkerText({ action: { type: "open_page" }, status: "in_progress" }),
    "[web page open (in_progress)]");
  assert.equal(webSearchCallMarkerText({ action: { type: "find_in_page", url: 42, pattern: null } }),
    "[completed web page find]");
  assert.equal(webSearchCallMarkerText({
    action: { type: "search", query: "distinct", queries: ["one", "one", "two"] },
    query: "stale legacy",
  }), '[completed web search: queries=["distinct","one","two"]]');
});

test("a turn with no search history is returned unchanged", () => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
  const result = markChatWireSearchHistory(input);
  assert.equal(result.replaced, 0);
  // Same reference: a turn without search history must not pay an allocation.
  assert.equal(result.input, input);
});

test("a non-array input is passed through rather than throwing", () => {
  for (const value of [undefined, null, "text", 42, {}]) {
    const result = markChatWireSearchHistory(value);
    assert.equal(result.replaced, 0);
    assert.equal(result.input, value);
  }
});
