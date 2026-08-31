// The publishable model set for a client that is not Codex.
//
// Codex reads its own catalog and carries its own ChatGPT session; every other
// client is published *to*, and the rules for what may be published are the
// same whichever one it is. They were written for DeepSeek Harness first and
// then wanted verbatim by the Gemini CLI integration, so they live here rather
// than in either client's manager -- two copies of this would drift, and the
// way it would show is one picker offering a model the other just lost.

import { existsSync, readFileSync } from "node:fs";

import { NATIVE_CATALOG_PATH } from "./paths.mjs";
import { nativeSessionAvailable } from "./codex-native-session.mjs";
import { MODEL_SLUG_ALIASES, providerForModel } from "./model-registry.mjs";
import { migrateModelVisibility } from "./model-picker-state.mjs";
import { readMultiAgentSettings } from "./multi-agent-state.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { applySubagentProofs, subagentProofSnapshot } from "./subagent-proofs.mjs";
import { applyVisionBridge, resolveVisionEngine } from "./vision-bridge.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";

// The native catalog Codex itself published, captured by `catalog.mjs`. Read
// rather than re-derived: it is the same document the Codex picker is built
// from, so a client cannot end up advertising a native model Codex does not
// have. Absent simply means no native models are offered.
function readNativeCatalogModels() {
  if (!existsSync(NATIVE_CATALOG_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/**
 * Native GPT models, shaped for a published client.
 *
 * These are authorized by a ChatGPT session rather than an API key, so they are
 * publishable only while the router can supply one -- see
 * `codex-native-session.mjs`. The caller decides that; this function only maps.
 *
 * `visibility: "hide"` entries are Codex's own internal variants (a watermarked
 * build, the auto-review model) and are not offered to anybody.
 */
export function nativeClientModels(nativeCatalogModels) {
  return (nativeCatalogModels || [])
    .filter((model) => model?.slug && model.visibility !== "hide")
    .map((model) => ({
      slug: String(model.slug),
      displayName: model.display_name ? `${model.display_name} (Codex)` : String(model.slug),
      contextWindow: Number.isFinite(model.context_window) ? model.context_window : undefined,
      inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities : ["text"],
      reasoningLevels: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .filter((level) => level?.effort)
            .map((level) => ({ effort: level.effort }))
        : [],
      ...(typeof model.default_reasoning_level === "string"
        ? { defaultEffort: model.default_reasoning_level }
        : {}),
      priority: Number.isFinite(model.priority) ? -model.priority : undefined,
      native: true,
    }));
}

/** The routed models a published client should be offered, vision bridge included. */
export function routedClientModels() {
  // Catalog publication normally carries picker decisions across renamed
  // slugs. DSH- or Gemini-only installs deliberately never run catalog.mjs,
  // though, so their shared publisher must apply the same registry aliases
  // before it evaluates the exact visibility allowlist.
  const picker = migrateModelVisibility(
    [...MODEL_SLUG_ALIASES].map(([from, to]) => ({ from, to })),
  );
  const hidden = new Set(picker.hidden);
  const visible = new Set(picker.visible);
  // Keep every client on the same registry-certified capabilities. Local
  // stream/tool probe records are passed through for compatibility with the
  // proof overlay API, but applySubagentProofs deliberately treats them as
  // diagnostic application evidence and never promotes a route to v2.
  const selected = applySubagentProofs(
    selectedConfiguredListedModels().filter((model) => {
      const slug = String(model.slug);
      return providerForModel(model)?.codexOnly !== true &&
        !hidden.has(slug) &&
        (!picker.hasExplicitVisibility || visible.has(slug));
    }),
    subagentProofSnapshot(),
    { hidden, disabled: readMultiAgentSettings().disabled },
  );
  // Native GPT models are authorized by a ChatGPT session rather than an API
  // key. A published client carries none of its own, so they are publishable
  // only after this user authorizes the shared local router plane and while the
  // signed-in Codex session remains usable (see `codex-native-session.mjs`).
  const native = nativeSessionAvailable() ? nativeClientModels(readNativeCatalogModels()) : [];
  // The vision engine still resolves over routed candidates only. A native
  // engine is spent per-caller, and `vision-engines` wants each call site to
  // name its evidence; this one's is that a bridge read is issued by the router
  // on the caller's behalf, which is not the same as relaying their turn.
  const engine = resolveVisionEngine(() => selected, readVisionBridgeSettings());
  return { models: [...applyVisionBridge(selected, engine), ...native], engine };
}
