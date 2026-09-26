import assert from "node:assert/strict";
import test from "node:test";

const {
  OPENCODE_MESSAGE_CONTENT_LIMIT,
  clampOpenCodeMessageContent,
  contentChars,
  openCodeOversizedImageNotice,
} = await import("../src/opencode-message-compat.mjs");

test("OpenCode Messages replaces a Console Go-oversized ImageGen data URL", () => {
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
  const huge = `data:image/png;base64,${"A".repeat(2_700_000)}`;
  const notice = openCodeOversizedImageNotice();
  assert.match(notice, new RegExp(String(OPENCODE_MESSAGE_CONTENT_LIMIT)));

  const original = [
    { role: "user", content: "look at the vehicle sheet" },
    { role: "assistant", content: "calling imagegen" },
    { role: "user", content: huge },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: huge } }],
    },
    {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2_700_000) } }],
    },
    { role: "user", content: [{ type: "image_url", image_url: { url: pixel } }] },
  ];
  const clamped = clampOpenCodeMessageContent(original);
  assert.equal(clamped[0], original[0]);
  assert.equal(clamped[1], original[1]);
  assert.equal(clamped[2].content, notice);
  assert.deepEqual(clamped[3].content, [{ type: "text", text: notice }]);
  assert.deepEqual(clamped[4].content, [{ type: "text", text: notice }]);
  assert.equal(clamped[5], original[5]);
  assert.ok(contentChars(clamped[2].content) < OPENCODE_MESSAGE_CONTENT_LIMIT);
  assert.ok(contentChars(clamped[3].content) < OPENCODE_MESSAGE_CONTENT_LIMIT);
  assert.ok(!JSON.stringify(clamped).includes("A".repeat(1000)));
});
