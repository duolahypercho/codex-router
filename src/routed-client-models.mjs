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
import { readHiddenModels } from "./model-picker-state.mjs";
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
      priority: Number.isFinite(model.priority) ? -model.priority : undefined,
      native: true,
    }));
}

/** The routed models a published client should be offered, vision bridge included. */
export function routedClientModels() {
  const hidden = readHiddenModels();
  // The same machine-local capability proofs the Codex catalog honors: a model
  // this machine verified as a subagent is one everywhere the proven set is
  // consumed, or a client's tool-subagent preset silently disagrees with the
  // picker about which children exist.
  const selected = applySubagentProofs(
    selectedConfiguredListedModels().filter((model) => !hidden.has(String(model.slug))),
    subagentProofSnapshot(),
    { hidden, disabled: readMultiAgentSettings().disabled },
  );
  // Native GPT models are authorized by a ChatGPT session rather than an API
  // key. A published client carries none of its own -- but this machine is
  // signed in to Codex, and the router relays that session for a caller that
  // brought nothing (see `codex-native-session.mjs`). So they are publishable
  // exactly while that fallback can supply one, and withheld the moment it
  // cannot.
  const native = nativeSessionAvailable() ? nativeClientModels(readNativeCatalogModels()) : [];
  // The vision engine still resolves over routed candidates only. A native
  // engine is spent per-caller, and `vision-engines` wants each call site to
  // name its evidence; this one's is that a bridge read is issued by the router
  // on the caller's behalf, which is not the same as relaying their turn.
  const engine = resolveVisionEngine(() => selected, readVisionBridgeSettings());
  return { models: [...applyVisionBridge(selected, engine), ...native], engine };
}
