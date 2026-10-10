import { randomUUID } from "node:crypto";
import { normalizeGitHubCopilotHost, readGitHubCopilotSettings } from "./github-copilot-state.mjs";

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

function githubCopilotHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "githubcopilot.com" ||
    host === "copilot-proxy.githubusercontent.com" ||
    host.endsWith(".githubcopilot.com");
}

function loopbackUrl(url) {
  return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

function enterpriseInferenceUrl(value, host) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
    ![`copilot-api.${host}`, `copilot-proxy.${host}`].includes(url.hostname)
  ) throw new Error("untrusted endpoint");
  return url.href.replace(/\/+$/, "");
}

export function resolveGitHubCopilotConfiguration({ env = process.env, settings = readGitHubCopilotSettings() } = {}) {
  const host = normalizeGitHubCopilotHost(settings.host);
  const enterprise = host !== "github.com";
  const accountHost = enterprise ? `api.${host}` : "api.github.com";
  const userUrl = env.GITHUB_COPILOT_USER_URL || `https://${accountHost}/copilot_internal/user`;
  let account;
  try {
    account = new URL(userUrl);
    if (!loopbackUrl(account) && (
      account.protocol !== "https:" || account.hostname !== accountHost ||
      (enterprise && (account.username || account.password || account.port || account.search || account.hash || account.pathname !== "/copilot_internal/user"))
    )) throw new Error("untrusted account endpoint");
  } catch {
    throw new Error("GITHUB_COPILOT_USER_URL must match the selected GitHub account API or a loopback test endpoint.");
  }
  let baseUrlOverride = env.GITHUB_COPILOT_BASE_URL || undefined;
  if (baseUrlOverride && enterprise) {
    try {
      const override = new URL(baseUrlOverride);
      // Existing loopback fixtures must set both account and inference URLs.
      // A production account can never use this test-only HTTP exception.
      if (loopbackUrl(account) && loopbackUrl(override) && ["http:", "https:"].includes(override.protocol) &&
        !override.username && !override.password && !override.search && !override.hash) {
        baseUrlOverride = override.href.replace(/\/+$/, "");
      } else {
        baseUrlOverride = enterpriseInferenceUrl(baseUrlOverride, host);
      }
    } catch {
      throw new Error("GITHUB_COPILOT_BASE_URL must use a Copilot endpoint for the selected enterprise tenant.");
    }
  }
  if (baseUrlOverride) baseUrlOverride = baseUrlOverride.replace(/\/+$/, "");
  return Object.freeze({
    host, enterprise, userUrl: account.href,
    dashboardUrl: `https://${host}/settings/copilot`,
    baseUrlOverride,
    identity: JSON.stringify([host, account.href, baseUrlOverride || null]),
  });
}

export function copilotApiBaseUrl(payload, fallback = DEFAULT_API_BASE_URL, configuration = resolveGitHubCopilotConfiguration()) {
  const endpoint = payload?.endpoints?.api;
  if (endpoint === undefined || endpoint === null || endpoint === "") {
    if (configuration.enterprise) {
      const error = new Error("GitHub returned no Copilot inference endpoint for the selected enterprise tenant.");
      error.status = 502;
      throw error;
    }
    return fallback.replace(/\/+$/, "");
  }
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    const error = new Error("GitHub returned an invalid Copilot inference endpoint.");
    error.status = 502;
    throw error;
  }
  try {
    if (configuration.enterprise) return enterpriseInferenceUrl(endpoint, configuration.host);
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

async function resolveSession(githubToken, fetchImpl, now, configuration) {
  const response = await fetchImpl(new URL(configuration.userUrl), {
    headers: githubCopilotAccountHeaders(githubToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(configuration.enterprise ? { redirect: "error" } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const error = new Error(`GitHub Copilot authentication returned HTTP ${response.status}.`);
    error.status = response.status === 401 || response.status === 403 ? 503 : 502;
    // `status` is the local answer exposed to a caller. Pool failover needs the
    // provider's credential-specific answer instead: a rejected source token
    // should cool only that pool entry and try the next one, while the
    // unpooled surface continues to report a setup-oriented 503.
    error.providerStatus = response.status;
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
    baseUrl: copilotApiBaseUrl(payload, DEFAULT_API_BASE_URL, configuration),
    checkedAt: now,
    configuration,
  };
}

export async function ensureFreshGitHubCopilotSession(
  githubToken,
  { force = false, fetchImpl = fetch, now = Date.now(), configuration = resolveGitHubCopilotConfiguration() } = {},
) {
  let token;
  try {
    token = assertGitHubCopilotCredential(githubToken);
  } catch (cause) {
    const error = new Error(cause.message);
    error.status = 503;
    error.providerStatus = 401;
    throw error;
  }
  if (
    !force &&
    cached?.token === token &&
    cached.configuration.identity === configuration.identity &&
    now - cached.checkedAt < SESSION_TTL_MS
  ) {
    return cached;
  }
  if (pending?.token === token && pending.identity === configuration.identity) return pending.promise;
  const promise = resolveSession(token, fetchImpl, now, configuration).then((session) => {
    cached = session;
    return session;
  }).finally(() => {
    if (pending?.promise === promise) pending = undefined;
  });
  // The resolved session already has to retain this token for inference. Keep
  // the in-flight comparison equally short-lived instead of deriving and
  // retaining a fast verifier for a credential.
  pending = { token, identity: configuration.identity, promise };
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
