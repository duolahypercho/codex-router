import { createHash, randomUUID } from "node:crypto";

import { threadIdFromHeaders } from "./codex-session-names.mjs";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";

export const OPENCODE_SESSION_FALLBACKS = Object.freeze({
  discovery: "codex-router-discovery",
  usage: "codex-router-usage",
});

const OPENCODE_PROVIDER_IDS = new Set([
  "opencode-go",
  "opencode-go-messages",
  "opencode-go-responses",
  "opencode-zen",
  "opencode-free",
  "opencode-free-responses",
]);

export function isOpenCodeProvider(provider) {
  if (!provider || typeof provider !== "object") return false;
  if (provider.ownedBy === "opencode") return true;
  return OPENCODE_PROVIDER_IDS.has(provider.id);
}

export function resolveOpenCodeSessionId({ headers = {}, body, fallback } = {}) {
  const fromThread = threadIdFromHeaders(headers);
  if (fromThread) return fromThread;

  const fromBody = conversationAnchorId(body);
  if (fromBody) return fromBody;

  if (typeof fallback === "string" && fallback) return fallback;
  return randomUUID();
}

export function openCodeSessionHeaders({ headers, body, fallback } = {}) {
  return {
    [OPENCODE_SESSION_HEADER]: resolveOpenCodeSessionId({ headers, body, fallback }),
  };
}

export function applyOpenCodeSessionHeaders(
  target,
  { provider, requestHeaders, body, fallback } = {},
) {
  if (!isOpenCodeProvider(provider)) return false;
  Object.assign(
    target,
    openCodeSessionHeaders({ headers: requestHeaders, body, fallback }),
  );
  return true;
}

function parseBody(body) {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return undefined;
    }
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (typeof body === "object") return body;
  return undefined;
}

function conversationItems(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.messages)) return payload.messages;
  if (Array.isArray(payload.input)) return payload.input;
  return [];
}

function itemAnchor(item) {
  if (typeof item === "string") return `text:${item}`;
  if (!item || typeof item !== "object") return `value:${JSON.stringify(item)}`;
  const role = item.role || item.type || "item";
  const content =
    typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? item);
  return `${role}:${content}`;
}

function conversationAnchorId(body) {
  const payload = parseBody(body);
  const anchor = [];
  for (const item of conversationItems(payload)) {
    anchor.push(itemAnchor(item));
    if (anchor.length === 2) break;
  }
  if (anchor.length === 0) return undefined;
  const digest = createHash("sha256").update(anchor.join("\n")).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}
