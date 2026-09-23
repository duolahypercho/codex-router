import { en } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";
import { zhTW } from "./locales/zh-TW.ts";
import { ar, hi, ja, ko, es } from "./locales/overlays.ts";

// Presentation only. Never write router configuration, credentials, or model
// selection here. The read-only panel shares this existing preference key.
export const LANGUAGE_STORAGE_KEY = "codex-router-language";
export const LANGUAGE_OPTIONS = [
  { id: "en", label: "English", locale: "en-US" },
  { id: "zh-CN", label: "简体中文", locale: "zh-CN" },
  { id: "zh-TW", label: "繁體中文（台灣）", locale: "zh-TW" },
  { id: "ar", label: "العربية", locale: "ar", dir: "rtl" },
  { id: "hi", label: "हिन्दी", locale: "hi-IN" },
  { id: "ja", label: "日本語", locale: "ja-JP" },
  { id: "ko", label: "한국어", locale: "ko-KR" },
  { id: "es", label: "Español", locale: "es-ES" },
] as const;
export type LanguageId = (typeof LANGUAGE_OPTIONS)[number]["id"];
export type MessageKey = keyof typeof en;
export type TextValues = Record<string, string | number>;
type Overlay = Partial<Record<MessageKey, string>>;
export const messageCatalogs: Readonly<Record<LanguageId, Readonly<Overlay>>> = {
  en, "zh-CN": zhCN, "zh-TW": zhTW, ar, hi, ja, ko, es,
};

export function isLanguageId(value: unknown): value is LanguageId {
  return LANGUAGE_OPTIONS.some((option) => option.id === value);
}

// Script takes precedence over region: zh-Hans-TW is Simplified Chinese,
// while zh-Hant-CN, zh-HK and zh-MO belong to the Traditional catalog.
export function resolveLanguage(value: unknown): LanguageId {
  if (typeof value !== "string" || value.length > 128 || !value.trim()) return "en";
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(value.trim().replaceAll("_", "-")); }
  catch { return "en"; }
  if (locale.language === "zh") {
    if (locale.script === "Hans") return "zh-CN";
    if (locale.script === "Hant") return "zh-TW";
    if (locale.script) return "en";
    return ["TW", "HK", "MO"].includes(locale.region ?? "") ? "zh-TW" : "zh-CN";
  }
  return isLanguageId(locale.language) ? locale.language : "en";
}

export function languageOption(language: LanguageId) {
  return LANGUAGE_OPTIONS.find((option) => option.id === language) ?? LANGUAGE_OPTIONS[0];
}

let selectedLanguage: LanguageId | undefined;
export function detectLanguage(): LanguageId {
  // An explicit in-memory choice must beat an old stored value when writes are
  // denied. On a fresh launch, persisted choice still beats the browser locale.
  if (selectedLanguage) return selectedLanguage;
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguageId(stored)) return stored;
  } catch { /* Restricted webviews may deny storage; use the browser hint. */ }
  return resolveLanguage(globalThis.navigator?.language);
}

export function storeLanguage(language: LanguageId): void {
  if (!isLanguageId(language)) return;
  selectedLanguage = language;
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch { /* Keep the explicit choice for this renderer session. */ }
}

export function applyDocumentLanguage(language: LanguageId): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const option = languageOption(language);
  root.lang = option.locale;
  root.dir = "dir" in option && option.dir === "rtl" ? "rtl" : "ltr";
}

export function translate(language: LanguageId, key: MessageKey, values: TextValues = {}): string {
  const messages = isLanguageId(language) ? messageCatalogs[language] : en;
  const template = Object.hasOwn(messages, key)
    ? messages[key]!
    : Object.hasOwn(en, key) ? en[key] : String(key);
  // One pass, own properties only: inserted user content is not a template and
  // '__proto__'/'constructor' must never read Object.prototype. Rendering uses
  // React text nodes (or panel textContent), never translated innerHTML.
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token);
}

export type Translate = {
  (key: MessageKey, values?: TextValues): string;
  readonly language?: LanguageId;
};

export function createTranslator(language: LanguageId): Translate {
  const resolved = isLanguageId(language) ? language : "en";
  return Object.assign(
    (key: MessageKey, values?: TextValues) => translate(resolved, key, values),
    { language: resolved },
  );
}

export function translatorLocale(t: Translate): string {
  return languageOption(t.language ?? detectLanguage()).locale;
}
