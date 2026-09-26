// @ts-check

/** @typedef {"en" | "zh-CN" | "zh-TW" | "ar" | "hi" | "ja" | "ko" | "es"} InterfaceLanguage */

/** @type {readonly InterfaceLanguage[]} */
export const INTERFACE_LANGUAGES = Object.freeze([
  "en", "zh-CN", "zh-TW", "ar", "hi", "ja", "ko", "es",
]);

/**
 * The renderer IPC accepts only exact, bounded preference IDs. System locale
 * matching is deliberately separate: an alias, a path, or a label object is
 * not a new command or translation file the renderer may ask us to load.
 * @param {unknown} value
 * @returns {value is InterfaceLanguage}
 */
export function isInterfaceLanguage(value) {
  return typeof value === "string" && INTERFACE_LANGUAGES.some((id) => id === value);
}

/**
 * Map a BCP 47 system locale to the existing preference IDs. An explicit
 * script outranks the region: zh-Hans-TW is Simplified, zh-Hant-CN Traditional.
 * Keep zh-CN/zh-TW as IDs rather than migrating persisted preferences merely
 * to spell the script differently. Unsupported scripts/languages use English.
 * This function is presentation-only; it never writes router/account state.
 * @param {unknown} value
 * @returns {InterfaceLanguage}
 */
export function interfaceLanguageFromLocale(value) {
  if (typeof value !== "string" || value.length > 128 || !value.trim()) return "en";
  let locale;
  try {
    locale = new Intl.Locale(value.trim().replaceAll("_", "-"));
  } catch {
    return "en";
  }
  if (locale.language === "zh") {
    if (locale.script === "Hans") return "zh-CN";
    if (locale.script === "Hant") return "zh-TW";
    if (locale.script) return "en";
    return ["TW", "HK", "MO"].includes(locale.region ?? "") ? "zh-TW" : "zh-CN";
  }
  return isInterfaceLanguage(locale.language) ? locale.language : "en";
}
