import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const VERTEX_STATE_PATH =
  process.env.MODEL_ROUTER_VERTEX_STATE_PATH ||
  process.env.MODEL_ROUTER_VERTEX_STATE ||
  path.join(STATE_DIR, "vertex-settings.json");

const VERSION = 1;
const PROJECT_ID_ENVIRONMENTS = Object.freeze([
  "VERTEX_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
]);
const LOCATION_ENVIRONMENTS = Object.freeze([
  "VERTEX_LOCATION",
  "GOOGLE_CLOUD_LOCATION",
]);

function defaultSettings() {
  return { version: VERSION, projectId: null, location: null };
}

function projectIdValue(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(normalized) ? normalized : undefined;
}

function locationValue(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9-]{0,62}$/.test(normalized) ? normalized : undefined;
}

function normalizedSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultSettings();
  }
  return {
    version: VERSION,
    projectId: projectIdValue(value.projectId) || null,
    location: locationValue(value.location) || null,
  };
}

export function readVertexSettings() {
  if (!existsSync(VERTEX_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(VERTEX_STATE_PATH, "utf8"));
    if (parsed?.version !== VERSION) return defaultSettings();
    return normalizedSettings(parsed);
  } catch {
    // A corrupt settings file is equivalent to an unconfigured provider. It
    // contains no credential and should not prevent the rest of the router
    // from starting.
    return defaultSettings();
  }
}

function environmentValue(environment, names, normalize) {
  for (const name of names) {
    const value = normalize(environment?.[name]);
    if (value) return { value, source: `environment (${name})` };
  }
  return undefined;
}

export function resolveVertexConfiguration({
  env = process.env,
  settings = readVertexSettings(),
  persistent = false,
} = {}) {
  const stored = normalizedSettings(settings);
  const project = !persistent
    ? environmentValue(env, PROJECT_ID_ENVIRONMENTS, projectIdValue)
    : undefined;
  const location = !persistent
    ? environmentValue(env, LOCATION_ENVIRONMENTS, locationValue)
    : undefined;
  const projectId = project?.value || stored.projectId;
  const resolvedLocation = location?.value || stored.location;

  return {
    configured: Boolean(projectId && resolvedLocation),
    projectId: projectId || null,
    location: resolvedLocation || null,
    projectSource: project?.source || (stored.projectId ? "protected state" : null),
    locationSource: location?.source || (stored.location ? "protected state" : null),
  };
}

function writeSettings(settings) {
  const directory = path.dirname(VERTEX_STATE_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${VERTEX_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, VERTEX_STATE_PATH);
    protectPrivateFile(VERTEX_STATE_PATH);
  } catch (error) {
    if (existsSync(temporary)) {
      // The temporary file contains only project metadata, but removing a
      // failed atomic write still avoids leaving stale state beside the target.
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup; the next write uses a distinct process suffix.
      }
    }
    throw error;
  }
  return settings;
}

export function setVertexConfiguration({ projectId, location } = {}) {
  const normalizedProjectId = projectIdValue(projectId);
  const normalizedLocation = locationValue(location);
  if (!normalizedProjectId) {
    throw new Error("Vertex project ID must be 6-30 lowercase letters, numbers, or hyphens.");
  }
  if (!normalizedLocation) {
    throw new Error("Vertex location must be a non-empty Google Cloud region or location.");
  }
  return writeSettings({
    version: VERSION,
    projectId: normalizedProjectId,
    location: normalizedLocation,
  });
}

export function writeVertexSettings(settings) {
  const normalized = normalizedSettings({ ...settings, version: VERSION });
  if (!normalized.projectId || !normalized.location) {
    throw new Error("Vertex settings require both projectId and location.");
  }
  return writeSettings(normalized);
}

export function clearVertexConfiguration() {
  return writeSettings(defaultSettings());
}

export function vertexConfigurationStatus(options = {}) {
  return {
    ...resolveVertexConfiguration(options),
    path: VERTEX_STATE_PATH,
  };
}
