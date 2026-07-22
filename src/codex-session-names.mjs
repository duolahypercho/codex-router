import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const METADATA_ID_KEYS = new Set([
  "conversationId",
  "conversation_id",
  "sessionId",
  "session_id",
  "threadId",
  "thread_id",
]);

export const SESSION_INDEX_PATH =
  process.env.CODEX_ROUTER_SESSION_INDEX ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "session_index.jsonl");

let cachedPath;
let cachedModifiedAt = -1;
let cachedNames = new Map();

function headerText(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function uuidIn(value) {
  return typeof value === "string" ? value.match(THREAD_ID_PATTERN)?.[0] : undefined;
}

function metadataThreadId(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (METADATA_ID_KEYS.has(key)) {
      const id = uuidIn(item);
      if (id) return id;
    }
  }
  for (const item of Object.values(value)) {
    const id = metadataThreadId(item);
    if (id) return id;
  }
  return undefined;
}

export function threadIdFromHeaders(headers = {}) {
  for (const name of ["thread-id", "session-id", "session_id", "x-codex-parent-thread-id"]) {
    const id = uuidIn(headerText(headers, name));
    if (id) return id;
  }

  const metadata = headerText(headers, "x-codex-turn-metadata");
  if (!metadata) return undefined;
  try {
    return metadataThreadId(JSON.parse(metadata));
  } catch {
    return undefined;
  }
}

function sessionNames(indexPath) {
  try {
    const modifiedAt = statSync(indexPath).mtimeMs;
    if (cachedPath === indexPath && cachedModifiedAt === modifiedAt) return cachedNames;
    const names = new Map();
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const id = uuidIn(entry?.id);
        const name = typeof entry?.thread_name === "string"
          ? entry.thread_name.replace(/\s+/g, " ").trim()
          : "";
        if (id && name) names.set(id.toLowerCase(), name.slice(0, 240));
      } catch {
        // Ignore a partially written or legacy index row.
      }
    }
    cachedPath = indexPath;
    cachedModifiedAt = modifiedAt;
    cachedNames = names;
    return names;
  } catch {
    return new Map();
  }
}

export function sessionNameFromHeaders(headers, { indexPath = SESSION_INDEX_PATH } = {}) {
  const id = threadIdFromHeaders(headers);
  if (!id) return undefined;
  return sessionNames(indexPath).get(id.toLowerCase());
}
