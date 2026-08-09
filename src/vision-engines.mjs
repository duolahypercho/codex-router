import { existsSync, readFileSync } from "node:fs";

import { modelPickerSnapshot } from "./model-picker-state.mjs";
import { MERGED_CATALOG_PATH, NATIVE_CATALOG_PATH } from "./paths.mjs";
import { nativeVisionCandidates } from "./vision-bridge.mjs";

// One rule, one place: which models from the signed-in ChatGPT plan may read an
// image for a text-only model.
//
// Three surfaces used to answer that separately and disagreed. `catalog.mjs`
// gated on the Codex auth probe, the tray gated on merged-catalog membership,
// and the request path did not gate at all -- it read `native-models.json`
// straight off disk. Both captures are reused deliberately when a fresh probe
// fails, so after a sign-out the catalog correctly stopped advertising the
// engine while the pinned setting still named it, and every bridged paste
// called a stale capture, got a 401, and degraded the image to "unreadable"
// instead of reporting that the bridge had no engine.
//
// The rule below is shared. The *evidence* for the gate cannot be, because the
// callers know the session differently and only one of them can afford to ask
// Codex: `codexAuthStatus()` spawns a process, which the request path cannot do
// per paste. So every call site names its evidence explicitly and
// `test/vision-bridge.test.mjs` fails when one of them stops passing any.

// The raw entries as written. The vision bridge reads declared modalities,
// which the picker-shaped normalizations elsewhere drop.
export function catalogModelsAt(catalogPath) {
  if (!existsSync(catalogPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

// `authorized` is required and must be exactly `true`. A missing gate reads as
// "closed", so a new caller that forgets to supply one ships no engines rather
// than silently shipping every engine -- which is how the request path came to
// have no gate at all.
export function nativeVisionEngines({ models, hidden, authorized } = {}) {
  if (authorized !== true) return [];
  return nativeVisionCandidates(
    models,
    hidden instanceof Set ? hidden : new Set(hidden || []),
  );
}

// Every reader outside the catalog build. Membership in the merged catalog is
// the proof that an entry survived the auth gate that produced it; the native
// capture is what declares the modalities. This is the strongest evidence
// available on disk -- but it is still on disk, so the request path pairs it
// with the caller's live session before nominating anything.
export function installedNativeVisionEngines({ hidden } = {}) {
  const shipped = new Set(
    catalogModelsAt(MERGED_CATALOG_PATH).map((model) => String(model.slug)),
  );
  const captured = catalogModelsAt(NATIVE_CATALOG_PATH).filter((model) =>
    shipped.has(String(model.slug)),
  );
  return nativeVisionEngines({
    models: captured,
    hidden: hidden ?? new Set(modelPickerSnapshot().hidden),
    // The filter above is the gate. Nothing shipped means nothing survived,
    // which is what a signed-out or login-free install looks like from here.
    authorized: captured.length > 0,
  });
}
