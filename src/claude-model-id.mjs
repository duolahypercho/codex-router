export const CLAUDE_MODEL_PREFIX = "codex_router/anthropic/";

// Claude Code's gateway discovery intentionally keeps only IDs containing
// "claude" or "anthropic". The router supports many model families, so the
// transport prefix carries "anthropic" while the suffix remains the exact
// router slug. display_name still shows the model's real human-facing name.
export function claudeModelId(slug) {
  return `${CLAUDE_MODEL_PREFIX}${String(slug || "")}`;
}

export function claudeRoutedSlug(model) {
  const value = String(model || "");
  return value.startsWith(CLAUDE_MODEL_PREFIX)
    ? value.slice(CLAUDE_MODEL_PREFIX.length)
    : value;
}
