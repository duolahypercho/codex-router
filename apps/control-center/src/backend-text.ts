import { createTranslator, detectLanguage, type Translate } from "./i18n.ts";
import { backendMessageKeys, backendMessagePatterns } from "./backend-messages.ts";

/**
 * Localizes recognized backend-owned display copy at the rendering boundary.
 * The backend's diagnostics, model/provider ids, paths and user content remain
 * untouched. A newly worded or unknown message falls through verbatim.
 * Static page text must use semantic message ids through useI18n()/translate().
 */
export function backendText(
  source: string | null | undefined,
  t: Translate = createTranslator(detectLanguage()),
): string {
  const value = typeof source === "string" ? source : "";
  if (!value || !["zh-CN", "zh-TW"].includes(t.language ?? detectLanguage())) return value;
  if (Object.hasOwn(backendMessageKeys, value)) {
    return t(backendMessageKeys[value as keyof typeof backendMessageKeys]);
  }
  for (const { pattern, key } of backendMessagePatterns) {
    const match = pattern.exec(value);
    if (match) return t(key, match.groups ?? {});
  }
  return value;
}
