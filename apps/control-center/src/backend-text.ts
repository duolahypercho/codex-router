import { detectLanguage } from "./i18n.ts";
import { backendTemplatesZh, backendZh } from "./locales/backend.zh.ts";
import { uiText } from "./ui-text.ts";

/**
 * Displays backend-owned copy in the interface language.
 *
 * The four localized pages show text that the router, the Electron IPC layer,
 * and the local-runtime helpers produced: operation progress, setup
 * requirements, provider setup notes, and local-model details. That copy never
 * passes through a page's own `uiText` source, so it needs a display step of
 * its own.
 *
 * Only the exact strings and templates in `backend.zh.ts` are translated. A raw
 * provider error, a path, a command, a model id, or a status id nobody has
 * mapped is returned untouched, so diagnostics keep the backend's wording and
 * a backend rewording simply falls back to English instead of breaking.
 */
export function backendText(source: string | null | undefined): string {
  const value = typeof source === "string" ? source : "";
  if (!value || detectLanguage() !== "zh-CN") return value;
  // `backendZh` is a plain object literal, so a raw backend string such as
  // "constructor" or "__proto__" would otherwise read an inherited value that
  // is not a translation at all.
  if (Object.hasOwn(backendZh, value)) return backendZh[value];
  // Some backend copy is also shared interface copy ("Not installed"), which
  // the page dictionaries already cover.
  const shared = uiText(value);
  if (shared !== value) return shared;
  for (const { pattern, template } of backendTemplatesZh) {
    const match = pattern.exec(value);
    if (!match) continue;
    const groups = (match.groups ?? {}) as Record<string, string>;
    return template.replace(/\{(\w+)\}/g, (token, key: string) => groups[key] ?? token);
  }
  return value;
}
