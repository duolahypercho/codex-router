import { existsSync, readFileSync, statSync } from "node:fs";

import { NATIVE_ALIAS_PATH } from "./paths.mjs";

// Signed-out Codex surfaces (notably the ChatGPT desktop app) only display
// models whose slugs pass a server-delivered allowlist of native GPT slugs.
// While signed out, the catalog republishes external models under those native
// slugs so they stay selectable everywhere; this module owns the slug mapping.

export function buildNativeAliasAssignments(nativeModels, externalModels) {
  const slots = (Array.isArray(nativeModels) ? nativeModels : [])
    .filter((model) => model.visibility === "list" && typeof model.slug === "string")
    .sort((left, right) => {
      const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
      return priority || String(left.slug).localeCompare(String(right.slug));
    });
  return externalModels
    .slice(0, slots.length)
    .map((model, index) => ({ nativeModel: slots[index], model }));
}

let cache;

export function readNativeAliases() {
  if (!existsSync(NATIVE_ALIAS_PATH)) return {};
  try {
    const mtimeMs = statSync(NATIVE_ALIAS_PATH).mtimeMs;
    if (!cache || cache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(NATIVE_ALIAS_PATH, "utf8"));
      const aliases =
        parsed?.version === 1 &&
        parsed.aliases &&
        typeof parsed.aliases === "object" &&
        !Array.isArray(parsed.aliases)
          ? Object.fromEntries(
              Object.entries(parsed.aliases).filter(
                ([nativeSlug, target]) =>
                  typeof nativeSlug === "string" && typeof target === "string",
              ),
            )
          : {};
      cache = { mtimeMs, aliases };
    }
    return cache.aliases;
  } catch {
    return {};
  }
}

export function nativeAliasFor(externalSlug) {
  const aliases = readNativeAliases();
  return Object.keys(aliases).find((nativeSlug) => aliases[nativeSlug] === externalSlug);
}
