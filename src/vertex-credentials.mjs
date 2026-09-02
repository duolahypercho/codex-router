import { execFileSync } from "node:child_process";

import { resolveVertexConfiguration } from "./vertex-state.mjs";

export const GOOGLE_ACCESS_TOKEN_CACHE_TTL_MS = 5 * 60 * 1_000;
export const GOOGLE_ACCESS_TOKEN_SOURCE =
  "Google Cloud Application Default Credentials (gcloud)";

const TOKEN_COMMANDS = Object.freeze([
  {
    args: ["auth", "application-default", "print-access-token"],
    source: GOOGLE_ACCESS_TOKEN_SOURCE,
  },
  {
    args: ["auth", "print-access-token"],
    source: "Google Cloud user credentials (gcloud)",
  },
]);

let tokenCache;
let lastFailure = { reason: "google-auth-unavailable" };

function tokenValue(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && !/\s/.test(normalized) ? normalized : undefined;
}

function defaultRunCommand(command, args, timeoutMs) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function failureReason(error) {
  return error?.code === "ENOENT" ? "gcloud-not-found" : "adc-not-configured";
}

function rememberFailure(reason) {
  lastFailure = { reason };
}

export function clearVertexTokenCache() {
  tokenCache = undefined;
  lastFailure = { reason: "google-auth-unavailable" };
}

export function resolveVertexAccessToken({
  now = Date.now(),
  cacheTtlMs = GOOGLE_ACCESS_TOKEN_CACHE_TTL_MS,
  command = process.env.GCLOUD_BIN || "gcloud",
  timeoutMs = 10_000,
  runCommand = defaultRunCommand,
} = {}) {
  if (
    tokenCache &&
    tokenCache.command === command &&
    tokenCache.runCommand === runCommand &&
    tokenCache.expiresAt > now
  ) {
    return tokenCache.value;
  }

  let sawInstalledCommand = false;
  for (const candidate of TOKEN_COMMANDS) {
    try {
      const output = runCommand(command, candidate.args, timeoutMs);
      sawInstalledCommand = true;
      const token = tokenValue(output);
      if (!token) {
        rememberFailure("adc-not-configured");
        continue;
      }
      tokenCache = {
        value: token,
        source: candidate.source,
        command,
        runCommand,
        expiresAt: now + Math.max(0, Number(cacheTtlMs) || 0),
      };
      lastFailure = { reason: undefined };
      return token;
    } catch (error) {
      const reason = failureReason(error);
      rememberFailure(reason);
      if (reason === "gcloud-not-found") return undefined;
      sawInstalledCommand = true;
    }
  }
  if (!sawInstalledCommand) rememberFailure("gcloud-not-found");
  return undefined;
}

function authSetupHint() {
  return "Install gcloud, then run `gcloud auth application-default login` (or `gcloud auth login`).";
}

export function vertexCredentialSetupHint({ persistent = true } = {}) {
  const configuration = resolveVertexConfiguration({ persistent });
  return configuration.configured
    ? authSetupHint()
    : "Set a Vertex project and location with `./bin/control vertex set PROJECT_ID LOCATION`.";
}

function resolvedToken(options) {
  if (typeof options.resolveAccessToken === "function") {
    try {
      const token = tokenValue(options.resolveAccessToken());
      return token
        ? { value: token, source: GOOGLE_ACCESS_TOKEN_SOURCE }
        : undefined;
    } catch {
      return undefined;
    }
  }
  const value = resolveVertexAccessToken(options);
  if (!value) return undefined;
  return {
    value,
    source: tokenCache?.source || GOOGLE_ACCESS_TOKEN_SOURCE,
  };
}

function authResolution(options = {}) {
  const configuration = resolveVertexConfiguration(options);
  if (!configuration.configured) {
    return { configuration };
  }
  return { configuration, token: resolvedToken(options) };
}

export function resolveVertexCredential(options = {}) {
  const resolved = authResolution(options);
  if (!resolved.token) return undefined;
  const { configuration } = resolved;
  return {
    value: resolved.token.value,
    source: resolved.token.source,
    persistent:
      configuration.projectSource === "protected state" &&
      configuration.locationSource === "protected state",
    projectId: configuration.projectId,
    location: configuration.location,
  };
}

export function vertexCredentialStatus(options = {}) {
  const resolved = authResolution(options);
  const { configuration } = resolved;
  if (!configuration.configured) {
    return {
      configured: false,
      reason: "vertex-configuration-missing",
      projectId: configuration.projectId,
      location: configuration.location,
      setup: vertexCredentialSetupHint({ persistent: options.persistent }),
    };
  }
  if (!resolved.token) {
    return {
      configured: false,
      reason: typeof options.resolveAccessToken === "function"
        ? "google-auth-unavailable"
        : lastFailure.reason || "google-auth-unavailable",
      projectId: configuration.projectId,
      location: configuration.location,
      setup: authSetupHint(),
    };
  }
  return {
    configured: true,
    source: resolved.token.source,
    persistent:
      configuration.projectSource === "protected state" &&
      configuration.locationSource === "protected state",
    projectId: configuration.projectId,
    location: configuration.location,
  };
}
