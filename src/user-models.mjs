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

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_AUTO_COMPACT = 110000;

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
]);

function gatewaySafe(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export function userModelEntry({ providerId, upstreamId, requestProfile, priority, metadata }) {
  const gatewayModel = `${gatewaySafe(providerId)}-${gatewaySafe(upstreamId)}`;
  const entry = {
    slug: `${providerId}/${upstreamId}`,
    gatewayModel,
    upstreamModel: upstreamId,
    provider: providerId,
    listed: true,
    displayName: `${upstreamId} (curated)`,
    description: `User-curated ${providerId} model; conservative default metadata that can be edited in the user model file.`,
    priority,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    autoCompact: DEFAULT_AUTO_COMPACT,
    inputModalities: ["text"],
    compHash: `${gatewayModel}-user-v1`,
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
