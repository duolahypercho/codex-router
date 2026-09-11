// Keep the history contract separate from sampling/thinking request profiles.
// Command Code's DeepSeek route uses its normal Provider API parameters; giving
// it the direct DeepSeek profile would also change tool choice and sampling.
// Both hops must agree: the router carries `thinking` parts through LiteLLM,
// then the API forwarder restores the assistant's `reasoning_content` field.
//
// Hy4 Preview is an interleaved-thinking model on the same contract: its
// reasoning arrives as `reasoning_content` and belongs back on the assistant
// turn that produced it. Replayed as visible text instead, the model reads its
// own past thinking as prose it once said, starts putting new thinking into the
// answer channel, and from there loops on its last progress note (rollout
// 01a0928e, 12 September 2026: reasoning tokens 174 -> 0 at the turn the
// switch happened, then the same sentence 2, 4, 5, 8, 16 times).
export function usesNativeChatReasoning(model) {
  return (
    model?.requestProfile === "glm-thinking" ||
    model?.requestProfile === "deepseek-thinking" ||
    model?.requestProfile === "hy4-reasoning" ||
    (model?.provider === "commandcode" &&
      model?.upstreamModel === "deepseek/deepseek-v4-flash")
  );
}
