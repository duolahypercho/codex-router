export const CURSOR_MODEL_PREFIX = "codex_router/";

const LEGACY_CURSOR_MODEL_PREFIXES = ["router/"];

export function cursorModelId(slug) {
  return `${CURSOR_MODEL_PREFIX}${String(slug || "")}`;
}

export function cursorRoutedSlug(model) {
  const value = String(model || "");
  if (value.startsWith(CURSOR_MODEL_PREFIX)) {
    return value.slice(CURSOR_MODEL_PREFIX.length);
  }
  for (const prefix of LEGACY_CURSOR_MODEL_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}
