import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// User-curated models live outside the checked-in config/ registry tree so a checkout update
// never discards them. Entries carry the same shape as registry models;
// metadata uses conservative defaults the user can adjust at curation time
// (bin/curate-models asks for context, modalities, and reasoning efforts) or
// edit in place afterwards. The stored values are plain local state the user
// owns.

export const USER_MODELS_PATH =
  process.env.MODEL_ROUTER_USER_MODELS || path.join(STATE_DIR, "user-models.json");

// Only reached when the provider's own catalog said nothing about the model's
// size. Curation prefers the advertised context length precisely because this
// number is a guess, and a guess eight times too small compacts a session that
// had the room (#266).
export const DEFAULT_CONTEXT_WINDOW = 131072;
export const DEFAULT_AUTO_COMPACT = 110000;

// Curation may adjust presentation, sizing, and effort metadata only;
// identity and routing fields always come from the provider id and the
// discovered model id.
const METADATA_FIELDS = new Set([
  "description",
  "contextWindow",
  "autoCompact",
  "inputModalities",
  "reasoningLevels",
  "defaultEffort",
  "serviceTiers",
  "supportsReasoningSummaries",
  "defaultReasoningSummary",
  "availabilityNux",
  "upgradeTo",
  "requiresTrailingUserTurn",
  "isFree",
]);

// Some providers deliberately publish opaque preview ids while documenting a
// stable user-facing name separately. Keep those names keyed by both provider
// and upstream id: the id remains the routing identity, and a reseller cannot
// accidentally rename another provider's model with the same slug.
const OFFICIAL_MODEL_DISPLAY_NAMES = new Map([
  ["opencode-free/x-preview-f-free", "Ox Alpha Free"],
]);

export function officialModelDisplayName(providerId, upstreamId) {
  return OFFICIAL_MODEL_DISPLAY_NAMES.get(`${providerId}/${upstreamId}`);
}

function gatewaySafe(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// Orca's catalog prefixes model ids with the upstream owner and appends
// `-free` to the zero-price deployment. Those are transport details, not the
// routed identity users choose in Codex: the provider namespace already says
// who serves the call and the `isFree` tag carries the price distinction.
// Keep the exact catalog id in `upstreamModel`, where the forwarder reads it.
export function userModelPublicId(providerId, upstreamId, metadata) {
  if (providerId !== "orca" || metadata?.isFree !== true) return upstreamId;
  const modelId = String(upstreamId).split("/").filter(Boolean).at(-1) || String(upstreamId);
  return modelId.replace(/-free$/, "");
}

export function userModelIdentity({ providerId, upstreamId, metadata }) {
  const publicId = userModelPublicId(providerId, upstreamId, metadata);
  const gatewayModel = `${gatewaySafe(providerId)}-${gatewaySafe(publicId)}`;
  return {
    slug: `${providerId}/${publicId}`,
    gatewayModel,
    compHash: `${gatewayModel}-user-v1`,
  };
}

// The picker text a curated entry carries until someone gives it a better
// one. Exported so curation can tell "nobody has written a description here"
// apart from a description the user edited, the same way the untouched
// DEFAULT_CONTEXT_WINDOW/DEFAULT_AUTO_COMPACT pair marks untuned sizing.
export function defaultUserModelDescription(providerId) {
  return `User-curated ${providerId} model; conservative default metadata that can be edited in the user model file.`;
}

export function userModelEntry({ providerId, upstreamId, requestProfile, priority, metadata }) {
  const identity = userModelIdentity({ providerId, upstreamId, metadata });
  const entry = {
    ...identity,
    upstreamModel: upstreamId,
    provider: providerId,
    listed: true,
    displayName: officialModelDisplayName(providerId, upstreamId) || `${upstreamId} (curated)`,
    description: defaultUserModelDescription(providerId),
    priority,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    autoCompact: DEFAULT_AUTO_COMPACT,
    inputModalities: ["text"],
  };
  for (const [key, value] of Object.entries(metadata || {})) {
    if (METADATA_FIELDS.has(key)) entry[key] = value;
  }
  if (requestProfile) entry.requestProfile = requestProfile;
  return entry;
}

export function readUserModels() {
  if (!existsSync(USER_MODELS_PATH)) return [];
  try {
    const payload = JSON.parse(readFileSync(USER_MODELS_PATH, "utf8"));
    return Array.isArray(payload?.models) ? payload.models : [];
  } catch {
    return [];
  }
}

export function writeUserModels(models) {
  writePrivateJson(USER_MODELS_PATH, { version: 1, models });
  return USER_MODELS_PATH;
}
