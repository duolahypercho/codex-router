import { detectLanguage, languageOption, type LanguageId } from "./i18n.ts";
import { analyticsZh } from "./locales/analytics.zh.ts";
import { catalogZh } from "./locales/catalog.zh.ts";
import { commonZh } from "./locales/common.zh.ts";

// English source strings are stable gettext-style keys. Keep values such as
// model IDs, filenames and diagnostic output outside the translation boundary.
const chinese: Record<string, string> = { ...analyticsZh, ...catalogZh, ...commonZh };
export type TextValues = Record<string, string | number>;
export function uiText(source: string, values: TextValues = {}, language: LanguageId = detectLanguage()): string {
  const template = language === "zh-CN" && Object.hasOwn(chinese, source) ? chinese[source] : source;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
export function uiLocale(): string {
  return languageOption(detectLanguage()).locale;
}

export function effortLabel(effort: string): string {
  const names: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
  const label = Object.hasOwn(names, effort) ? names[effort] : undefined;
  return label && detectLanguage() === "zh-CN" ? `${uiText(label)} (${effort})` : effort;
}
