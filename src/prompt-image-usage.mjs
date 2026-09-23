import { isUtf8 } from "node:buffer";

const DEEPSEEK_FLASH_MODELS = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

const DEEPSEEK_FLASH_IMAGE_TOKENS = 1024;

// The estimate exists to keep a false zero from being believed, not to price an
// image. Every provider here charges an image in the low thousands of tokens at
// most, so a route whose exact bound is unknown still gets a bound: the error
// stays inside a few thousand tokens, where counting the payload whole can cross
// the compaction threshold with a single screenshot. Only a recognised image
// reference in a real content array is ever discounted (see promptImageUsage),
// so a route that takes no images is unaffected.
export const DEFAULT_IMAGE_TOKEN_BOUND = 4096;

// DeepSeek's hosted Flash API resizes every image to at most 1024 tokens.
// The older Flash names now alias that model. That bound is not established for
// resellers, other providers, or other DeepSeek models, which take the
// conservative default above rather than no bound at all.
// Verified 2026-09-10: https://api-docs.deepseek.com/guides/vision/#token-usage
export function maxImageTokensForRoute(route) {
  return route?.provider === "deepseek" && DEEPSEEK_FLASH_MODELS.has(route.upstreamModel)
    ? DEEPSEEK_FLASH_IMAGE_TOKENS
    : DEFAULT_IMAGE_TOKEN_BOUND;
}

// Discount only image references in actual Responses content arrays. A pasted
// JSON example, tool schema, unknown field, or text-only request keeps the old
// byte estimate. This never changes the body forwarded to the provider.
export function promptImageUsage(buffer, maxTokensPerImage) {
  const unchanged = { bytes: 0, tokens: 0 };
  if (
    !Number.isSafeInteger(maxTokensPerImage) || maxTokensPerImage <= 0 ||
    !buffer.includes('"input_image"') || !isUtf8(buffer)
  ) return unchanged;

  const referenceBytes = new WeakMap();
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"), function (key, value, context) {
      if ((key === "image_url" || key === "file_id") && typeof value === "string") {
        // The source slice preserves JSON escapes and surrounding whitespace in
        // the byte estimate. Keep the string's quotes as structural overhead.
        const bytes = typeof context?.source === "string"
          ? Buffer.byteLength(context.source, "utf8") - 2 : 0;
        const fields = referenceBytes.get(this) || {};
        fields[key] = bytes;
        referenceBytes.set(this, fields);
      }
      return value;
    });
  } catch {
    return unchanged;
  }

  let bytes = 0;
  let tokens = 0;
  for (const item of Array.isArray(payload?.input) ? payload.input : []) {
    const isMessage = (item?.type === "message" || item?.type === undefined) &&
      (item?.role === "user" || item?.role === "developer");
    const isToolOutput = item?.type === "function_call_output" ||
      item?.type === "custom_tool_call_output";
    const parts = isMessage ? item.content : isToolOutput ? item.output : undefined;
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part?.type !== "input_image") continue;
      const hasUrl = typeof part.image_url === "string" && part.image_url.length > 0;
      const hasFile = typeof part.file_id === "string" && part.file_id.length > 0;
      // Ambiguous or malformed references stay conservatively counted whole.
      if (hasUrl === hasFile) continue;
      const key = hasUrl ? "image_url" : "file_id";
      if (hasUrl && !/^(?:data:image\/|https?:\/\/)/i.test(part.image_url)) continue;
      bytes += referenceBytes.get(part)?.[key] || 0;
      tokens += maxTokensPerImage;
    }
  }
  return { bytes, tokens };
}
