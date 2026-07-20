import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import { protectPrivateFile } from "./file-security.mjs";
import {
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";
import { VERSION } from "./version.mjs";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_CODE_HOME =
  process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const API_BASE = (
  process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1"
).replace(/\/+$/, "");
const OAUTH_HOST = (
  process.env.KIMI_CODE_OAUTH_HOST ||
  process.env.KIMI_OAUTH_HOST ||
  "https://auth.kimi.com"
).replace(/\/+$/, "");
const LISTEN_HOST =
  process.env.CODEX_ROUTER_OAUTH_HOST || process.env.KIMI_FORWARD_HOST || "127.0.0.1";
const LISTEN_PORT = Number(
  process.env.CODEX_ROUTER_OAUTH_PORT || process.env.KIMI_FORWARD_PORT || PORTS.oauth,
);
const INTERNAL_KEY =
  process.env.CODEX_ROUTER_INTERNAL_KEY || process.env.KIMI_INTERNAL_KEY;
const QUIET =
  process.env.CODEX_ROUTER_QUIET === "1" || process.env.KIMI_PROXY_QUIET === "1";

if (!INTERNAL_KEY) throw new Error("CODEX_ROUTER_INTERNAL_KEY is required.");

const CREDENTIALS_PATH = path.join(
  KIMI_CODE_HOME,
  "credentials",
  "kimi-code.json",
);
const OAUTH_LOCK_TARGET = path.join(KIMI_CODE_HOME, "oauth", "kimi-code");
const DEVICE_ID_PATH = path.join(KIMI_CODE_HOME, "device_id");
let refreshInFlight;

function asciiHeader(value, fallback = "unknown") {
  const cleaned = String(value).replace(/[^\u0020-\u007e]/g, "").trim();
  return cleaned || fallback;
}

function macOSProductVersion() {
  if (os.type() !== "Darwin") return undefined;
  try {
    return execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function readDeviceId() {
  const value = readFileSync(DEVICE_ID_PATH, "utf8").trim();
  if (!value) {
    throw new Error(`Kimi device id is missing; run \`kimi login\` first.`);
  }
  return value;
}

function identityHeaders() {
  const platform =
    os.type() === "Darwin"
      ? `macOS ${macOSProductVersion() || os.release()} ${os.arch()}`
      : `${os.type()} ${os.release()} ${os.arch()}`;
  return {
    "User-Agent": `codex-router/${VERSION}`,
    "X-Msh-Platform": "codex",
    "X-Msh-Version": VERSION,
    "X-Msh-Device-Name": asciiHeader(os.hostname()),
    "X-Msh-Device-Model": asciiHeader(platform),
    "X-Msh-Os-Version": asciiHeader(os.release()),
    "X-Msh-Device-Id": asciiHeader(readDeviceId()),
  };
}

function validateToken(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Kimi OAuth credential file is not a JSON object.");
  }
  if (typeof value.access_token !== "string" || !value.access_token) {
    throw new Error("Kimi OAuth credential is missing; run `kimi login`.");
  }
  if (typeof value.refresh_token !== "string" || !value.refresh_token) {
    throw new Error("Kimi OAuth refresh credential is missing; run `kimi login`.");
  }
  const expiresAt = Number(value.expires_at);
  const expiresIn = Number(value.expires_in);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(expiresIn)) {
    throw new Error("Kimi OAuth credential has invalid expiry metadata.");
  }
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: expiresAt,
    expires_in: expiresIn,
    scope: typeof value.scope === "string" ? value.scope : "kimi-code",
    token_type: typeof value.token_type === "string" ? value.token_type : "Bearer",
  };
}

function readToken() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Kimi OAuth credentials were not found; run \`kimi login\`.`);
  }
  return validateToken(JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")));
}

function shouldRefresh(token) {
  const threshold = Math.max(
    300,
    token.expires_in > 0 ? token.expires_in * 0.5 : 0,
  );
  return Math.floor(Date.now() / 1_000) >= token.expires_at - threshold;
}

function sameToken(left, right) {
  return (
    left.access_token === right.access_token &&
    left.refresh_token === right.refresh_token &&
    left.expires_at === right.expires_at
  );
}

function atomicSaveToken(token) {
  const directory = path.dirname(CREDENTIALS_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${CREDENTIALS_PATH}.tmp.${process.pid}`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(token, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CREDENTIALS_PATH);
    protectPrivateFile(CREDENTIALS_PATH);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function refreshToken(refreshTokenValue) {
  const retryable = new Set([429, 500, 502, 503, 504]);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
        method: "POST",
        headers: {
          ...identityHeaders(),
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: KIMI_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        const expiresIn = Number(payload.expires_in);
        if (
          typeof payload.access_token !== "string" ||
          typeof payload.refresh_token !== "string" ||
          !Number.isFinite(expiresIn) ||
          expiresIn <= 0
        ) {
          throw new Error("Kimi OAuth refresh returned an incomplete response.");
        }
        return {
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
          expires_at: Math.floor(Date.now() / 1_000) + expiresIn,
          expires_in: expiresIn,
          scope: typeof payload.scope === "string" ? payload.scope : "kimi-code",
          token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
        };
      }
      const code = typeof payload.error === "string" ? payload.error : "oauth_error";
      if (response.status === 401 || response.status === 403 || code === "invalid_grant") {
        const error = new Error("Kimi OAuth refresh was rejected; run `kimi login` again.");
        error.code = "oauth_unauthorized";
        throw error;
      }
      if (!retryable.has(response.status)) {
        throw new Error(`Kimi OAuth refresh failed with HTTP ${response.status}.`);
      }
      lastError = new Error(`Temporary Kimi OAuth error: HTTP ${response.status}.`);
    } catch (error) {
      if (error?.code === "oauth_unauthorized") throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 2) await delay(2 ** attempt * 1_000);
  }
  throw lastError || new Error("Kimi OAuth refresh failed.");
}

async function ensureFreshToken({ force = false } = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const initial = readToken();
    if (!force && !shouldRefresh(initial)) return initial.access_token;

    mkdirSync(path.dirname(OAUTH_LOCK_TARGET), { recursive: true, mode: 0o700 });
    writeFileSync(OAUTH_LOCK_TARGET, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(OAUTH_LOCK_TARGET, {
      retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 1_000 },
      stale: 5_000,
      realpath: false,
    });
    try {
      const latest = readToken();
      if (!force && !shouldRefresh(latest)) return latest.access_token;
      if (force && !sameToken(initial, latest)) return latest.access_token;
      try {
        const refreshed = await refreshToken(latest.refresh_token);
        atomicSaveToken(refreshed);
        return refreshed.access_token;
      } catch (error) {
        if (error?.code === "oauth_unauthorized") {
          await delay(100);
          const recovered = readToken();
          if (recovered.refresh_token !== latest.refresh_token) {
            return recovered.access_token;
          }
        }
        throw error;
      }
    } finally {
      await release();
    }
  })().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

function foldInterveningAssistantMessages(messages) {
  if (!Array.isArray(messages)) return;
  for (let index = 0; index < messages.length; index += 1) {
    const callingMessage = messages[index];
    const callIds = new Set(
      Array.isArray(callingMessage?.tool_calls)
        ? callingMessage.tool_calls.map((call) => call?.id).filter(Boolean)
        : [],
    );
    if (callingMessage?.role !== "assistant" || callIds.size === 0) continue;
    let cursor = index + 1;
    const intervening = [];
    while (
      messages[cursor]?.role === "assistant" &&
      !Array.isArray(messages[cursor]?.tool_calls)
    ) {
      intervening.push(messages[cursor]);
      cursor += 1;
    }
    if (intervening.length === 0) continue;
    const followingIds = new Set();
    while (messages[cursor]?.role === "tool") {
      if (messages[cursor]?.tool_call_id) followingIds.add(messages[cursor].tool_call_id);
      cursor += 1;
    }
    if (![...callIds].every((id) => followingIds.has(id))) continue;
    const text = [callingMessage, ...intervening]
      .flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        if (!Array.isArray(message.content)) return [];
        return message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text);
      })
      .filter((value) => value.trim());
    if (text.length) callingMessage.content = text.join("\n");
    messages.splice(index + 1, intervening.length);
  }
}

function normalizeKimiBody(buffer, contentType) {
  if (!buffer.length || !String(contentType || "").includes("application/json")) {
    return buffer;
  }
  const payload = JSON.parse(buffer.toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return buffer;
  foldInterveningAssistantMessages(payload.messages);
  payload.thinking = { type: "enabled" };
  const effort = {
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
    ultra: "max",
  }[payload.reasoning_effort];
  if (effort) payload.reasoning_effort = effort;
  else delete payload.reasoning_effort;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function upstreamHeaders(requestHeaders, body) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization") continue;
    if (lower.startsWith("x-msh-") || lower.startsWith("x-codex-")) continue;
    if (lower.startsWith("x-openai-") || lower === "chatgpt-account-id") continue;
    if (lower === "originator" || lower === "user-agent" || lower === "accept-encoding") continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  Object.assign(headers, identityHeaders());
  headers["Accept-Encoding"] = "identity";
  if (body.length) headers["Content-Length"] = String(body.length);
  return headers;
}

function tokenHealth() {
  try {
    const token = readToken();
    return {
      credential_present: true,
      scope: token.scope,
      expires_in_seconds: Math.max(
        0,
        token.expires_at - Math.floor(Date.now() / 1_000),
      ),
    };
  } catch {
    return {
      credential_present: false,
      error: "Kimi OAuth credential is unavailable; run `kimi login`.",
    };
  }
}

async function requestUpstream(request, target, body, token, signal) {
  return fetch(target, {
    method: request.method,
    headers: {
      ...upstreamHeaders(request.headers, body),
      Authorization: `Bearer ${token}`,
    },
    body: body.length ? body : undefined,
    signal,
  });
}

async function handleRequest(request, response) {
  const startedAt = Date.now();
  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || LISTEN_HOST}`,
  );
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "codex-router-oauth-forwarder",
      ...tokenHealth(),
    });
    return;
  }

  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (
    !(
      (request.method === "POST" && route === "/chat/completions") ||
      (request.method === "GET" && route === "/models")
    )
  ) {
    writeJson(response, 404, {
      error: { type: "proxy_route_not_found", message: "Unsupported OAuth route." },
    });
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  let body = await readRequestBody(request);
  if (route === "/chat/completions") {
    body = normalizeKimiBody(body, request.headers["content-type"]);
  }
  const target = `${API_BASE}${route}${requestUrl.search}`;
  let token = await ensureFreshToken();
  let upstream = await requestUpstream(request, target, body, token, controller.signal);
  if (upstream.status === 401) {
    await upstream.arrayBuffer();
    token = await ensureFreshToken({ force: true });
    upstream = await requestUpstream(request, target, body, token, controller.signal);
  }
  await pipeResponse(upstream, response);
  if (!QUIET) {
    console.error(
      `[kimi-oauth] ${request.method} ${route} -> ${upstream.status} ${Date.now() - startedAt}ms`,
    );
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    console.error("[kimi-oauth] request failed");
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: "kimi_oauth_proxy_error",
          message: "The Kimi OAuth forwarder could not complete the request.",
        },
      });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[kimi-oauth] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
