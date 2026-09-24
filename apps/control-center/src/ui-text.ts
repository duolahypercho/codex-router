// Compatibility adapter for backend-owned English display copy. New page text
// uses semantic ids in i18n.ts; this bridge does not own another dictionary.
import { detectLanguage, languageOption, translate, createTranslator, type LanguageId, type TextValues } from "./i18n.ts";
import { backendMessageKeys } from "./backend-messages.ts";
import { effortLabel as localizedEffortLabel } from "./lib.ts";
export type { TextValues } from "./i18n.ts";
export function uiText(source: string, values: TextValues = {}, language: LanguageId = detectLanguage()): string {
  if (["zh-CN", "zh-TW"].includes(language) && Object.hasOwn(backendMessageKeys, source)) {
    return translate(language, backendMessageKeys[source as keyof typeof backendMessageKeys], values);
  }
  return source.replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}
export function uiLocale(): string { return languageOption(detectLanguage()).locale; }
export function effortLabel(effort: string): string { return localizedEffortLabel(effort, createTranslator(detectLanguage())); }
