import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerSource = readFileSync(path.join(root, "src/router.mjs"), "utf8");
const start = routerSource.indexOf("function normalizeNativeInput(");
const end = routerSource.indexOf("\nfunction extractUserMessages(", start);
assert.ok(start >= 0 && end > start, "native input normalizer source is available");

const normalizeNativeInput = new Function(
  "NATIVE_ITEM_ID_PREFIXES",
  "sanitizeReasoningForNative",
  "nativeReasoningReplay",
  "sanitizeCollaborationForNative",
  "isRouterCompactionValue",
  "renderCompactionValue",
  "messageItem",
  `${routerSource.slice(start, end)}\nreturn normalizeNativeInput;`,
)(
  new Map([
    ["function_call", "fc"],
    ["custom_tool_call", "ctc"],
    ["message", "msg"],
  ]),
  (item) => item,
  (item) => [item],
  (item) => item,
  () => false,
  (value) => value,
  (text) => ({ type: "message", role: "user", content: text }),
);

const metadata = { content_token_count: 7 };

test("native input normalization removes only the top-level internal metadata", () => {
  const items = [
    {
      type: "message",
      role: "user",
      content: "hello",
      internal_chat_message_metadata_passthrough: metadata,
      sibling: true,
      nested: { internal_chat_message_metadata_passthrough: metadata },
    },
    {
      type: "function_call",
      call_id: "call_1",
      id: "fc_call_1",
      name: "tool",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: metadata,
    },
    {
      type: "reasoning",
      id: "rs_native",
      summary: [],
      encrypted_content: "gAAAA-ciphertext",
      internal_chat_message_metadata_passthrough: metadata,
    },
    {
      type: "compaction",
      id: "cmp_native",
      encrypted_content: "gAAAA-checkpoint",
      internal_chat_message_metadata_passthrough: metadata,
    },
    { type: "message", role: "assistant", content: "plain", sibling: true },
  ];

  const normalized = normalizeNativeInput(items);

  assert.equal(normalized.length, items.length);
  assert.equal(normalized[0].sibling, true);
  assert.deepEqual(normalized[0].nested, {
    internal_chat_message_metadata_passthrough: metadata,
  });
  assert.equal(normalized[0].internal_chat_message_metadata_passthrough, undefined);
  for (const item of normalized.slice(1, 4)) {
    assert.equal(item.internal_chat_message_metadata_passthrough, undefined);
  }
  assert.equal(normalized[1].call_id, "call_1");
  assert.equal(normalized[1].id, "fc_call_1");
  assert.equal(normalized[2].encrypted_content, "gAAAA-ciphertext");
  assert.equal(normalized[3].encrypted_content, "gAAAA-checkpoint");
  assert.deepEqual(normalized[4], items[4]);
  assert.equal(normalizeNativeInput("native input"), "native input");
  assert.equal(normalizeNativeInput(null), null);
});
