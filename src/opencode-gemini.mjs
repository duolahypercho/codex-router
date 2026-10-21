export const OPENCODE_GEMINI_MODEL = "gemini-4-argon-contributor";
export const OPENCODE_GEMINI_BASE_URL = "https://opencode.ai/inference/go/v1";
export const OPENCODE_GEMINI_BASE_URL_ENV = "OPENCODE_GEMINI_BASE_URL";
export const OPENCODE_GEMINI_THOUGHT_SIGNATURE_SENTINEL =
  "skip_thought_signature_validator";

export function isOpenCodeGeminiModel(model) {
  return (
    model?.provider === "opencode-go" &&
    model?.upstreamModel === OPENCODE_GEMINI_MODEL
  );
}

export function openCodeGeminiModelFromRoute(route) {
  const match = String(route || "").match(
    /^\/models\/([^/:]+):(?:generateContent|streamGenerateContent)$/,
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function ensureOpenCodeGeminiThoughtSignatures(payload) {
  if (!Array.isArray(payload?.contents)) return payload;
  for (const content of payload.contents) {
    if (!Array.isArray(content?.parts)) continue;
    for (const part of content.parts) {
      if (!part || typeof part !== "object") continue;
      if (
        part.function_call &&
        !part.thought_signature &&
        !part.thoughtSignature
      ) {
        part.thought_signature = OPENCODE_GEMINI_THOUGHT_SIGNATURE_SENTINEL;
      }
      if (
        part.functionCall &&
        !part.thoughtSignature &&
        !part.thought_signature
      ) {
        part.thoughtSignature = OPENCODE_GEMINI_THOUGHT_SIGNATURE_SENTINEL;
      }
    }
  }
  return payload;
}
