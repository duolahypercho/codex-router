import { createHash, randomUUID } from "node:crypto";

const USER_URL =
  process.env.GITHUB_COPILOT_USER_URL ||
  "https://api.github.com/copilot_internal/user";
const DEFAULT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 5 * 60_000;

// Copilot uses this editor identity to select the coding-agent integration;
// generic HTTP client identities receive a narrower model allowlist.
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const USER_AGENT = "GitHubCopilotChat/0.35.0";
const ACCOUNT_API_VERSION = "2025-04-01";
const INFERENCE_API_VERSION = "2026-06-01";
const RUNTIME_INTEGRATION_ID = "copilot-developer-cli";
const SOURCE_TOKEN_PREFIXES = ["github_pat_", "gho_", "ghu_"];

let cached;
let pending;

export function githubCopilotCredentialProblem(value) {
  const token = String(value || "").trim();
  if (!token) return "No GitHub token was entered.";
  // The official CLI accepts fine-grained PATs and GitHub OAuth tokens, but
  // explicitly rejects classic `ghp_` PATs.
  if (token.startsWith("ghp_")) {
    return "Classic GitHub PATs are not supported. Use a fine-grained PAT with Copilot Requests permission.";
  }
  if (!SOURCE_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return "Use a fine-grained GitHub PAT or supported GitHub OAuth token with Copilot access.";
  }
  return undefined;
}

export function assertGitHubCopilotCredential(value) {
  const token = String(value || "").trim();
  const problem = githubCopilotCredentialProblem(token);
  if (problem) throw new Error(problem);
  return token;
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

function githubCopilotHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "githubcopilot.com" ||
    host === "copilot-proxy.githubusercontent.com" ||
    host.endsWith(".githubcopilot.com");
}

function userEndpoint() {
  const url = new URL(USER_URL);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" || url.hostname !== "api.github.com") && !loopback) {
    throw new Error("GITHUB_COPILOT_USER_URL must use api.github.com or a loopback test endpoint.");
  }
  return url;
}

export function copilotApiBaseUrl(payload, fallback = DEFAULT_API_BASE_URL) {
  const endpoint = payload?.endpoints?.api;
  if (endpoint === undefined || endpoint === null || endpoint === "") {
    return fallback.replace(/\/+$/, "");
  }
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    const error = new Error("GitHub returned an invalid Copilot inference endpoint.");
    error.status = 502;
    throw error;
  }
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !githubCopilotHost(url.hostname)
    ) {
      throw new Error("untrusted endpoint");
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    const error = new Error("GitHub returned an invalid Copilot inference endpoint.");
    error.status = 502;
    throw error;
  }
}

export function githubCopilotAccountHeaders(githubToken) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${githubToken}`,
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "identity",
    "X-GitHub-Api-Version": ACCOUNT_API_VERSION,
  };
}

async function resolveSession(githubToken, fetchImpl, now) {
  const response = await fetchImpl(userEndpoint(), {
    headers: githubCopilotAccountHeaders(githubToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const error = new Error(`GitHub Copilot authentication returned HTTP ${response.status}.`);
    error.status = response.status === 401 || response.status === 403 ? 503 : 502;
    throw error;
  }
  const payload = await response.json().catch(() => undefined);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("GitHub Copilot authentication returned an invalid response.");
    error.status = 502;
    throw error;
  }
  return {
    token: githubToken,
    baseUrl: copilotApiBaseUrl(payload),
    checkedAt: now,
    sourceFingerprint: tokenFingerprint(githubToken),
  };
}

export async function ensureFreshGitHubCopilotSession(
  githubToken,
  { force = false, fetchImpl = fetch, now = Date.now() } = {},
) {
  let token;
  try {
    token = assertGitHubCopilotCredential(githubToken);
  } catch (cause) {
    const error = new Error(cause.message);
    error.status = 503;
    throw error;
  }
  const sourceFingerprint = tokenFingerprint(token);
  if (
    !force &&
    cached?.sourceFingerprint === sourceFingerprint &&
    now - cached.checkedAt < SESSION_TTL_MS
  ) {
    return cached;
  }
  if (pending?.sourceFingerprint === sourceFingerprint) return pending.promise;
  const promise = resolveSession(token, fetchImpl, now).then((session) => {
    cached = session;
    return session;
  }).finally(() => {
    if (pending?.promise === promise) pending = undefined;
  });
  pending = { sourceFingerprint, promise };
  return promise;
}

function contentHasType(value, type) {
  if (Array.isArray(value)) return value.some((item) => contentHasType(item, type));
  if (!value || typeof value !== "object") return false;
  return value.type === type || contentHasType(value.content, type);
}

function copilotRequestState(payload) {
  if (typeof payload?.input === "string") return { agent: false, vision: false };
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const last = input.at(-1);
  const agent = !last ||
    last.type === "function_call_output" ||
    last.role !== "user" ||
    contentHasType(last.content, "function_call_output");
  const vision = input.some((item) => contentHasType(item?.content, "input_image"));
  return { agent, vision };
}

export function githubCopilotRequestHeaders(payload, token) {
  const { agent, vision } = copilotRequestState(payload);
  return {
    Authorization: `Bearer ${token}`,
    "Copilot-Integration-Id": RUNTIME_INTEGRATION_ID,
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "Openai-Intent": "conversation-edits",
    "Openai-Organization": "github-copilot",
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "identity",
    "X-GitHub-Api-Version": INFERENCE_API_VERSION,
    "X-Initiator": agent ? "agent" : "user",
    "X-Request-Id": randomUUID(),
    ...(vision ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

export function githubCopilotCatalogHeaders(token) {
  return {
    ...githubCopilotAccountHeaders(token),
    "Copilot-Integration-Id": RUNTIME_INTEGRATION_ID,
    "X-GitHub-Api-Version": INFERENCE_API_VERSION,
  };
}

export function resetGitHubCopilotSessionForTests() {
  cached = undefined;
  pending = undefined;
}
