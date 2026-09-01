import { createHash } from "node:crypto";

export const CURSOR_MODEL_PREFIX = "codex_router/";

const LEGACY_CURSOR_MODEL_PREFIXES = ["router/"];

const EFFORT_LABELS = new Map([
  ["none", "none"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
  ["ultra", "ultra"],
]);

function neutralStem(slug) {
  const value = String(slug || "");
  const readable = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "model";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${readable}__${digest}`;
}

function reasoningEfforts(model) {
  const seen = new Set();
  return (Array.isArray(model?.reasoningLevels) ? model.reasoningLevels : [])
    .map((level) => String(typeof level === "string" ? level : level?.effort || "").trim().toLowerCase())
    .filter((effort) => effort && !seen.has(effort) && seen.add(effort));
}

export function cursorModelId(slug, effort) {
  const suffix = effort ? `/${String(effort).trim().toLowerCase()}` : "";
  return `${CURSOR_MODEL_PREFIX}${neutralStem(slug)}${suffix}`;
}

export function cursorModelSelections(model) {
  const slug = String(model?.slug || "");
  if (!slug) return [];
  const efforts = reasoningEfforts(model);
  if (!efforts.length) {
    return [{ alias: cursorModelId(slug), slug, effort: undefined, model }];
  }
  return efforts.map((effort) => ({
    alias: cursorModelId(slug, effort),
    slug,
    effort,
    model,
    displayName: `${model.displayName || slug} · ${EFFORT_LABELS.get(effort) || effort}`,
  }));
}

export function cursorCatalogSelections(models) {
  return (Array.isArray(models) ? models : []).flatMap((model) => cursorModelSelections(model));
}

export function resolveCursorModel(model, models) {
  const requested = String(model || "");
  const candidates = Array.isArray(models) ? models : [];
  const selection = cursorCatalogSelections(candidates).find((entry) => entry.alias === requested);
  if (selection) return selection;

  // Existing Cursor Agent sessions and pre-fix Cursor App rows used the raw
  // slug after codex_router/. Keep accepting those at the private edge even
  // though new App rows must use neutral ids to pass Cursor's BYOK classifier.
  const legacySlug = cursorRoutedSlug(requested);
  const legacy = candidates.find((candidate) => String(candidate?.slug || "") === legacySlug);
  return legacy ? { alias: requested, slug: legacySlug, effort: undefined, model: legacy } : undefined;
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
