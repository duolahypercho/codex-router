// Builds the DeepSeek Harness view of the router's routed models.
//
// The harness reads provider routes from `dsh-llm-pi-ai`, which its shipped
// bundle mounts *dormant*: zero routes until an `llm-pi-ai:` settings section
// supplies profiles. So publishing every routed model into the harness is a
// settings write, not a plugin or composition change, and the harness picks it
// up on its next request because `dsh-settings-file` hot-reloads the document.
//
// Routed models are always published. An unregistered slug on the router's
// `/v1/responses` endpoint is treated as native GPT traffic, which needs a
// ChatGPT session the harness does not carry — so a native model is published
// only while `codex-native-session.mjs` can substitute the one this machine is
// signed in with, and is withheld again the moment it cannot. See
// `dshNativeModels` below.

import { applyVisionBridge } from "./vision-bridge.mjs";
import { yamlScalar } from "./yaml-structure.mjs";

// The route key the router owns inside `llm-pi-ai.providers`. Everything else
// under that key belongs to the user (or to the harness's own Models page) and
// is never read, rewritten, or removed.
export const DSH_ROUTE_ID = "codex-router";
export const DSH_ROUTE_DISPLAY_NAME = "Codex Router";
// The credential *reference* stored in the settings document. Its value lives
// in `.credentials.yaml`, which is what keeps the caller key out of a document
// the harness also renders into its Models page.
export const DSH_CREDENTIAL_REF = "CODEX_ROUTER_CALLER_KEY";

// pi-ai's own level set. `catalog.mjs` ships a wider Codex ladder (it also
// spells `ultra`), and a level pi-ai does not know is not "close enough": the
// harness would offer a selector entry whose wire value the router's effort
// vocabulary never produced. Unmappable levels are dropped and reported.
const PI_AI_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// pi-ai's request modalities. The registry only ever declares these two, but a
// curated user model is hand-edited state and may say anything.
const PI_AI_MODALITIES = new Set(["text", "image"]);

/**
 * Translates one routed model into a pi-ai model profile.
 *
 * `id` is the router **slug**, not the gateway model id: the slug is what
 * `/v1/responses` resolves against `MODEL_BY_SLUG`, and sending a gateway id
 * there falls through to the native path.
 */
export function dshModelProfile(model) {
  const profile = { id: String(model.slug) };
  if (model.displayName) profile.name = String(model.displayName);
  if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) {
    profile.contextWindow = model.contextWindow;
  }
  const input = (model.inputModalities || ["text"]).filter((modality) =>
    PI_AI_MODALITIES.has(modality),
  );
  if (input.length) profile.input = input;

  const levels = Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [];
  const efforts = levels
    .map((level) => String(level?.effort || ""))
    .filter((effort) => PI_AI_THINKING_LEVELS.has(effort));
  // `false` is pi-ai's spelling for "this model does not reason", and it is the
  // right answer for a model the registry gives no levels: omitting the field
  // instead would inherit whatever the installed catalog happens to say about
  // an id that collides with one of its own.
  profile.reasoningEfforts = efforts.length
    ? Object.fromEntries(efforts.map((effort) => [effort, effort]))
    : false;
  return profile;
}

/** Levels the registry declares that pi-ai has no name for, per model. */
export function unmappableEfforts(models) {
  const dropped = new Map();
  for (const model of models) {
    for (const level of model.reasoningLevels || []) {
      const effort = String(level?.effort || "");
      if (!effort || PI_AI_THINKING_LEVELS.has(effort)) continue;
      if (!dropped.has(effort)) dropped.set(effort, []);
      dropped.get(effort).push(String(model.slug));
    }
  }
  return dropped;
}

/**
 * Assembles the whole `codex-router` route.
 *
 * The protocol is `openai-responses` because that is the only thing the
 * router's caller endpoint serves. Everything the router does for a Codex turn
 * — tool-result ageing, the vision bridge, prompt-token substitution, upstream
 * retry, usage and throughput accounting — sits on that same routed path, so a
 * harness turn gets all of it without a second code path.
 *
 * No `compat` is set on purpose: pi-ai types those switches only on
 * `openai-completions`, and a route-level switch on a Responses route is
 * refused outright. The router already applies each model's request profile on
 * its own side of the hop, which is where that knowledge belongs.
 */
export function buildDshRoute({ models, baseUrl, credentialRef = DSH_CREDENTIAL_REF }) {
  if (!baseUrl) throw new Error("A dsh route needs the router's caller base URL.");
  return {
    displayName: DSH_ROUTE_DISPLAY_NAME,
    api: "openai-responses",
    baseURL: baseUrl,
    apiKeyEnv: credentialRef,
    // A route the installed catalog does not ship must state its own
    // fallbacks. Every model below declares a context window, so this only
    // ever covers a model added to the document by hand.
    defaultContextWindow: 131072,
    defaultInput: ["text"],
    models: models.map(dshModelProfile),
  };
}

/**
 * The routed models the harness should see, with the vision bridge applied.
 *
 * The engine candidates deliberately exclude native models: `vision-engines`
 * admits one only on evidence that the caller's ChatGPT session can spend it,
 * and a harness request carries no such session. Offering image input here on
 * a native engine would advertise a paste the router cannot serve.
 */
export function dshCatalogModels(selectedModels, visionEngine) {
  return applyVisionBridge(selectedModels, visionEngine);
}

/**
 * Native GPT models, shaped for the harness route.
 *
 * These are authorized by a ChatGPT session rather than an API key, so they are
 * publishable only while the router can supply one -- see
 * `codex-native-session.mjs`. The caller decides that; this function only maps.
 *
 * `visibility: "hide"` entries are Codex's own internal variants (a watermarked
 * build, the auto-review model) and are not offered to anybody.
 */
export function dshNativeModels(nativeCatalogModels) {
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

/** The model a fresh harness agent should start on: the highest priority one. */
export function dshDefaultModel(models) {
  const ranked = [...models].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      String(left.slug).localeCompare(String(right.slug)),
  );
  return ranked[0]?.slug;
}

function renderScalar(value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return yamlScalar(value);
}

function renderMapping(value, indent, lines) {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry)) {
      if (!entry.length) {
        lines.push(`${indent}${key}: []`);
        continue;
      }
      // Every array this renders is a list of scalars or of flat mappings, so
      // one shape covers both without a general emitter.
      lines.push(`${indent}${key}:`);
      for (const item of entry) {
        if (item && typeof item === "object") {
          const nested = [];
          renderMapping(item, `${indent}    `, nested);
          lines.push(`${indent}  - ${nested[0].trimStart()}`, ...nested.slice(1));
        } else {
          lines.push(`${indent}  - ${renderScalar(item)}`);
        }
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      lines.push(`${indent}${key}:`);
      renderMapping(entry, `${indent}  `, lines);
      continue;
    }
    lines.push(`${indent}${key}: ${renderScalar(entry)}`);
  }
  return lines;
}

/**
 * Renders the route as the YAML lines that replace
 * `llm-pi-ai.providers.codex-router`, indented for that depth.
 */
export function renderDshRouteLines(route, { indent = "    " } = {}) {
  return [`${indent}${DSH_ROUTE_ID}:`, ...renderMapping(route, `${indent}  `, [])];
}
