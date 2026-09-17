import { estimateInputTokens } from "./response-usage.mjs";

// Remote compaction V2 arrives through the ordinary Responses endpoint with a
// terminal compaction_trigger item. When the conversation is still under the
// route's own auto-compact budget, the trigger is a model-switch artifact
// rather than a genuinely full context; stripping it avoids a lossy summary.
export function shouldSkipRemoteCompactV2(payload, route, body) {
  if (!route || !Array.isArray(payload?.input)) return false;
  if (payload.input.at(-1)?.type !== "compaction_trigger") return false;
  const estimatedTokens = estimateInputTokens(body, {
    contextWindow: route.contextWindow,
  });
  return (
    Number.isFinite(route?.autoCompact) &&
    estimatedTokens !== undefined &&
    estimatedTokens <= route.autoCompact
  );
}
