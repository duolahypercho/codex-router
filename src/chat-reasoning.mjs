// Keep the history contract separate from sampling/thinking request profiles.
// Command Code's DeepSeek route uses its normal Provider API parameters; giving
// it the direct DeepSeek profile would also change tool choice and sampling.
// Both hops must agree: the router carries `thinking` parts through LiteLLM,
// then the API forwarder restores the assistant's `reasoning_content` field.
//
// The rule belongs to the model, not to the profile or the reseller. A
// thinking model reached over Chat Completions emits `reasoning_content` and
// expects it back on the assistant turn that produced it; replayed as visible
// text instead, the model reads its own past thinking as prose it once said,
// moves new thinking into the answer channel, and loops on its last progress
// note (Hy4 on opencode Go, rollout 01a0928e, 12 September 2026: reasoning
// tokens 174 -> 0 in one step, then the same sentence 2, 4, 5, 8, 16 times).
// The profile checks below cover the vendor-direct routes; the family table
// covers the same models behind resellers, whose request profiles say nothing
// about the upstream's replay rule.

// Upstream model families with an established replay requirement, matched
// against `upstreamModel` with or without a vendor prefix (`glm-5.3`,
// `z-ai/glm-5.3`, `zai-org/GLM-5.3`). Each entry names its evidence.
const NATIVE_REASONING_FAMILIES = [
  // DeepSeek: the API answers the turn after any reply with HTTP 400 "The
  // `reasoning_content` in the thinking mode must be passed back" (#703).
  { family: "deepseek", upstream: /(^|\/)deepseek/i },
  // Z.ai GLM-5.x: with preserved thinking the vendor requires the full
  // historical reasoning_content replayed; every reseller route here answered
  // a live probe with a reasoning item (12 September 2026).
  { family: "glm", upstream: /(^|\/)glm-5/i },
  // Moonshot Kimi K3: the platform guide states reasoning_content is required
  // in multi-turn conversations and tool-call loops. K2.x is left out: k2.6
  // does not preserve thinking, and no reseller route for k2.7 was probed.
  { family: "kimi-k3", upstream: /(^|\/)kimi-k3$/i },
  // MiniMax M3: interleaved thinking depends on prior-round reasoning being
  // fed back; the `minimax-m3` profile already asks for it split out as
  // reasoning_content.
  { family: "minimax-m3", upstream: /(^|\/)minimax-m3$/i },
  // Tencent Hunyuan: hy4-preview measured (above); hy3 and hy3-paid share the
  // family and returned reasoning on every probed route.
  { family: "hunyuan", upstream: /(^|\/)hy(3|4)(-[a-z]+)*$/i },
];

// Chat Completions providers the table applies to. Verified live on 12
// September 2026 (opencode-go, openrouter, commandcode) or the vendor's own
// API. Anthropic-protocol variants (`*-messages`) carry reasoning as thinking
// blocks and must never receive the reasoning_content restore; routes on
// resellers not listed here keep their existing replay channel until probed.
const NATIVE_REASONING_CHAT_PROVIDERS = new Set([
  "opencode-go",
  "openrouter",
  "commandcode",
  "minimax-token-plan",
  "kimi-api",
  "kimi-api-cn",
  "zai-api",
  "deepseek",
]);

export function nativeReasoningFamily(model) {
  if (!NATIVE_REASONING_CHAT_PROVIDERS.has(model?.provider)) return undefined;
  const upstream = String(model?.upstreamModel ?? "");
  return NATIVE_REASONING_FAMILIES.find((entry) => entry.upstream.test(upstream))?.family;
}

export function usesNativeChatReasoning(model) {
  return (
    model?.requestProfile === "glm-thinking" ||
    model?.requestProfile === "deepseek-thinking" ||
    model?.requestProfile === "hy4-reasoning" ||
    (model?.provider === "commandcode" &&
      model?.upstreamModel === "deepseek/deepseek-v4-flash") ||
    nativeReasoningFamily(model) !== undefined
  );
}
