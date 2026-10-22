// LiteLLM translates Responses reasoning to either a string or, when summary
// is requested, an object. Both carry the same caller-selected effort. Summary
// controls presentation and is not an additional upstream effort level.
export function normalizeGrokReasoningEffort(value, { xhigh = false } = {}) {
  const effort = typeof value === "string" ? value
    : value && typeof value === "object" && !Array.isArray(value) ? value.effort
      : undefined;
  if (["none", "minimal", "low"].includes(effort)) return "low";
  if (effort === "xhigh") return xhigh ? "xhigh" : "high";
  if (effort === "max") return "high";
  return ["medium", "high"].includes(effort) ? effort : undefined;
}

// The locked LiteLLM Responses-to-Chat bridge consumes its named parameter
// allowlist before constructing the nested Chat request. Its supported
// extra_body contract reaches that request unchanged. Keep this adaptation at
// the owned bridge boundary and let the forwarder apply model capabilities.
export function grokReasoningBridgeBody(payload) {
  const reasoning = payload?.reasoning ?? payload?.reasoning_effort;
  if (reasoning === undefined || reasoning === null) return undefined;
  const extra = payload.extra_body;
  return {
    ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
    reasoning_effort: reasoning,
  };
}
