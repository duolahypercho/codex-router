import { existsSync, readFileSync } from "node:fs";

import { readModelsCache } from "./native-account-catalog.mjs";
import { NATIVE_CATALOG_PATH } from "./paths.mjs";

// Keep this ordered from the least to the most reasoning. `none` is present
// in some native account catalogs even though Codex's cross-provider picker
// normally starts at `minimal`.
export const NATIVE_REASONING_EFFORT_LADDER = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function capturedModels(path = NATIVE_CATALOG_PATH) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

// The account cache is the freshest statement of native capabilities. The
// captured catalog remains the offline fallback used by the installed picker.
// Merge by slug so an account entry can narrow a stale capture rather than
// resurrecting a rung the current account no longer advertises.
export function nativeReasoningModels({
  accountCatalog = readModelsCache().catalog,
  capturedCatalogModels = capturedModels(),
} = {}) {
  const bySlug = new Map(
    capturedCatalogModels
      .filter((model) => typeof model?.slug === "string" && model.slug)
      .map((model) => [model.slug, model]),
  );
  for (const model of accountCatalog?.models || []) {
    if (typeof model?.slug !== "string" || !model.slug) continue;
    bySlug.set(model.slug, { ...(bySlug.get(model.slug) || {}), ...model });
  }
  return [...bySlug.values()];
}

function supportedEfforts(model) {
  if (!Array.isArray(model?.supported_reasoning_levels)) return [];
  return [...new Set(model.supported_reasoning_levels.map((level) => (
    typeof level === "string" ? level : level?.effort
  )).filter((effort) => NATIVE_REASONING_EFFORT_LADDER.includes(effort)))];
}

export function clampNativeReasoningEffort(requested, supported) {
  if (typeof requested !== "string" || supported.includes(requested)) return requested;
  const requestedIndex = NATIVE_REASONING_EFFORT_LADDER.indexOf(requested);
  if (requestedIndex === -1) return requested;
  const ordered = supported
    .filter((effort) => NATIVE_REASONING_EFFORT_LADDER.includes(effort))
    .sort((left, right) => (
      NATIVE_REASONING_EFFORT_LADDER.indexOf(left) -
      NATIVE_REASONING_EFFORT_LADDER.indexOf(right)
    ));
  if (!ordered.length) return requested;
  const atOrBelow = ordered.filter((effort) => (
    NATIVE_REASONING_EFFORT_LADDER.indexOf(effort) <= requestedIndex
  ));
  return atOrBelow.at(-1) || ordered[0];
}

/**
 * Repair a stale picker effort after a native-model switch.
 *
 * Codex can apply the new model and the old effort in separate UI state
 * updates. ChatGPT validates the pair atomically and otherwise returns a 400.
 * Only known Codex effort names are clamped; unknown values remain untouched
 * so a real schema/client defect is not hidden by the router.
 */
export function normalizeNativeReasoningEffort(payload, { models } = {}) {
  const model = (models || nativeReasoningModels()).find((candidate) => (
    candidate?.slug === payload?.model
  ));
  const supported = supportedEfforts(model);
  if (!supported.length) return [];

  const changes = [];
  const nested = payload?.reasoning?.effort;
  const normalizedNested = clampNativeReasoningEffort(nested, supported);
  if (normalizedNested !== nested) {
    payload.reasoning = { ...payload.reasoning, effort: normalizedNested };
    changes.push({ field: "reasoning.effort", from: nested, to: normalizedNested });
  }

  const flat = payload?.reasoning_effort;
  const normalizedFlat = clampNativeReasoningEffort(flat, supported);
  if (normalizedFlat !== flat) {
    payload.reasoning_effort = normalizedFlat;
    changes.push({ field: "reasoning_effort", from: flat, to: normalizedFlat });
  }
  return changes;
}
