// Request profiles are executable router behavior, not free-form metadata.
// Keep the complete set closed here so neither a live provider catalog nor a
// hand-edited model overlay can mint a new behavior merely by naming it.
export const REQUEST_PROFILES = Object.freeze([
  "anthropic-reasoning",
  "antigravity",
  "auto-tool-choice",
  "clinepass",
  "codex-encrypted-schema",
  "deepseek-nonthinking",
  "deepseek-thinking",
  "glm-thinking",
  "hy4-reasoning",
  "kimi-k3",
  "kimi-oauth",
  "minimax-m3",
  "ollama-cloud",
  "ollama-cloud-auto-tool-choice",
  "ollama-cloud-glm-5-3-flash",
  "ox-alpha",
  "qwen-plan",
  "qwen38-community",
  "xai-reasoning",
]);

const PROFILE_SET = new Set(REQUEST_PROFILES);

// Most profiles encode a checked-in vendor contract and are never sensible to
// lend to an arbitrary model. These two are deliberately model-scoped
// compatibility observations an operator can make while curating a route.
export const CURATABLE_REQUEST_PROFILES = Object.freeze([
  "auto-tool-choice",
  "codex-encrypted-schema",
]);

const CURATABLE_PROFILE_SET = new Set(CURATABLE_REQUEST_PROFILES);

export function requestProfileKnown(value) {
  return typeof value === "string" && PROFILE_SET.has(value);
}

export function curatableRequestProfile(value) {
  return typeof value === "string" && CURATABLE_PROFILE_SET.has(value);
}
