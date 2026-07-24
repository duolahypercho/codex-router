import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// User-curated models live outside config/providers.json so a checkout update
// never discards them. Entries carry the same shape as registry models;
// metadata uses conservative defaults the user can edit in place.

export const USER_MODELS_PATH =
  process.env.MODEL_ROUTER_USER_MODELS || path.join(STATE_DIR, "user-models.json");

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_AUTO_COMPACT = 110000;

function gatewaySafe(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export function userModelEntry({ providerId, upstreamId, requestProfile, priority }) {
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
  mkdirSync(path.dirname(USER_MODELS_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${USER_MODELS_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, USER_MODELS_PATH);
    protectPrivateFile(USER_MODELS_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return USER_MODELS_PATH;
}
