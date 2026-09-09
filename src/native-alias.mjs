import { existsSync, readFileSync } from "node:fs";

import {
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
  SIGNED_PROVIDER_MODE_PATH,
} from "./paths.mjs";

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

// The alias file is a few hundred bytes and is rewritten whenever the user
// switches models, so it is read fresh on every lookup. An mtime-keyed cache
// used to guard the read, but file timestamps advance on a coarse tick (~15ms
// on Windows), so a rewrite in the same tick kept serving the previous map and
// routed the switched-to model to its old target.
export function readNativeAliases() {
  if (!existsSync(NATIVE_ALIAS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_ALIAS_PATH, "utf8"));
    if (
      parsed?.version !== 1 ||
      !parsed.aliases ||
      typeof parsed.aliases !== "object" ||
      Array.isArray(parsed.aliases)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.aliases).filter(
        ([nativeSlug, target]) =>
          typeof nativeSlug === "string" && typeof target === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function nativeAliasFor(externalSlug) {
  const aliases = readNativeAliases();
  return Object.keys(aliases).find((nativeSlug) => aliases[nativeSlug] === externalSlug);
}

function nativeCatalogSlugs() {
  if (!existsSync(NATIVE_CATALOG_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return new Set(
      models
        .map((model) => (typeof model?.slug === "string" ? model.slug : ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

// Official ChatGPT models are unprefixed GPT slugs. Routed copies keep a
// provider prefix (`private/gpt-5.6-sol`) and must still be remappable.
export function isOfficialNativeSlug(slug) {
  if (typeof slug !== "string" || !slug || slug.includes("/")) return false;
  if (nativeCatalogSlugs().has(slug)) return true;
  return /^gpt-/i.test(slug);
}

export function officialModelsMustPassthrough() {
  return existsSync(SIGNED_PROVIDER_MODE_PATH);
}
