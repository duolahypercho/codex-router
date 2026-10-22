import { grokReasoningBridgeBody } from "./grok-reasoning-effort.mjs";
import { grokTimingHeaders } from "./grok-request-timing.mjs";

// Ordinary turns and compaction share the same Responses-to-Chat bridge.
// Apply this after caller/child policy so both paths preserve the final effort
// and the Router-owned correlation ID through LiteLLM.
export function grokBridgeRequest(payload, route, request) {
  if (route?.provider !== "grok-oauth") return payload;
  const extraBody = grokReasoningBridgeBody(payload);
  return {
    ...payload,
    extra_headers: grokTimingHeaders(request, payload.extra_headers),
    ...(extraBody ? { extra_body: extraBody } : {}),
  };
}
