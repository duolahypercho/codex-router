// Keep the history contract separate from sampling/thinking request profiles.
// Command Code's DeepSeek route uses its normal Provider API parameters; giving
// it the direct DeepSeek profile would also change tool choice and sampling.
// Both hops must agree: the router carries `thinking` parts through LiteLLM,
// then the API forwarder restores the assistant's `reasoning_content` field.
//
// DeepSeek reached through a reseller keeps the vendor's replay rule while the
// route carries a reseller-shaped request profile, so the profile checks above
// leave it unprotected. `opencode-go/deepseek-v4.1-flash` is the measured case:
// its profile is `auto-tool-choice`, so neither hop ran, and the provider
// answered the next turn with HTTP 400 "The `reasoning_content` in the thinking
// mode must be passed back to the API." The failure needs a prior assistant
// turn, so it surfaced on the turn after any reply -- including every subagent
// hand-off, which always ends in prose.
//
// Keyed on the upstream model, because the rule belongs to the upstream and not
// to the profile or the reseller. Deliberately scoped to DeepSeek: OpenCode Go
// also serves GLM, Qwen, Kimi, MiniMax, Longcat, and MiMo thinking models over
// the same endpoint, and moving their replay from visible text to
// `reasoning_content` without evidence that they require it would be a silent
// behaviour change on routes this issue was never reported against.
const RESELLER_DEEPSEEK_CHAT_PROVIDERS = new Set(["opencode-go"]);

function isResellerDeepSeekChatRoute(model) {
  if (!RESELLER_DEEPSEEK_CHAT_PROVIDERS.has(model?.provider)) return false;
  return /(^|\/)deepseek/i.test(String(model?.upstreamModel ?? ""));
}

export function usesNativeChatReasoning(model) {
  return (
    model?.requestProfile === "glm-thinking" ||
    model?.requestProfile === "deepseek-thinking" ||
    (model?.provider === "commandcode" &&
      model?.upstreamModel === "deepseek/deepseek-v4-flash") ||
    isResellerDeepSeekChatRoute(model)
  );
}
