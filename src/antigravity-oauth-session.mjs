import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { randomUUID, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";

import {
  ANTIGRAVITY_PROBE_MODEL,
  ANTIGRAVITY_PROBE_VERSION,
  ANTIGRAVITY_TOKEN_URL,
} from "./antigravity-oauth-constants.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const REFRESH_THRESHOLD_SECONDS = 60;
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_REFRESH_RETRY_DELAY_MS = 30_000;
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const TOKEN_LOCK_WAIT_ATTEMPTS = 120;
const TOKEN_LOCK_RETRY_MS = 250;
const TOKEN_MUTATION_LEASE_WAIT_MS = (TOKEN_LOCK_WAIT_ATTEMPTS + 1) * TOKEN_LOCK_RETRY_MS;
// A complete refresh can consume three 30s request ceilings plus two capped
// 30s Retry-After delays. Keep the caller's wait horizon beyond both that 150s
// maximum and the former five-minute stale-lock horizon. A live owner is never
// reclaimed from elapsed time: its OS-owned endpoint survives event-loop
// stalls and process suspension, while process death releases the endpoint.
const REFRESH_LEASE_STALE_HORIZON_MS = 300_000;
const REFRESH_LEASE_WAIT_MS = 360_000;
const REFRESH_LEASE_RETRY_MS = 250;
const POSIX_REFRESH_LEASE_PORT_BASE = 20_000;
const POSIX_TOKEN_MUTATION_LEASE_PORT_BASE = 10_000;
const POSIX_OWNER_LEASE_PORT_COUNT = 10_000;
// Version two replaced fast secret-derived hashes with a memory-hard verifier.
// A version-one in-flight journal is intentionally refused: after dispatch,
// treating an unknown one-time refresh-token outcome as reusable is unsafe.
const ANTIGRAVITY_REFRESH_STATE_VERSION = 2;
const REFRESH_PHASE_CLAIMED = "claimed";
const REFRESH_PHASE_DISPATCHED = "dispatched";
const REFRESH_PHASE_UNCERTAIN = "uncertain";
const REFRESH_FINGERPRINT_SALT = "codex-router/antigravity-refresh-fence/v2";
const REFRESH_FINGERPRINT_SCRYPT_OPTIONS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
});
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const PROVABLY_PRECONNECT_REFRESH_CODES = new Set([
  "EADDRNOTAVAIL",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOBUFS",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const MAX_REFRESH_ERROR_GRAPH_DEPTH = 8;
const refreshInFlight = new Map();
const ANTIGRAVITY_CREDENTIAL_VERSION = 3;
const ANTIGRAVITY_CREDENTIAL_OWNER = "codex-router";
const ANTIGRAVITY_DISCONNECT_FENCE_VERSION = 1;
const ANTIGRAVITY_SIGN_IN_INTENT_VERSION = 1;
const ANTIGRAVITY_PROBE_ACTIVATION_VERSION = 1;
const ANTIGRAVITY_PENDING_ACTIVATION = "pending_activation";
const ANTIGRAVITY_ACTIVE_ACTIVATION = "active";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_VENDOR_CLIENT_IDS = new Set([
  // This was bundled by the original implementation. It belongs to the
  // official Antigravity integration and must never become a BYO client just
  // because somebody found a matching secret elsewhere.
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
]);

let injectedTokenPath;

export function setAntigravityTokenPathForTests(value) {
  if (value !== undefined && (!path.isAbsolute(value) || !value)) {
    throw new TypeError("The injected Antigravity token path must be absolute.");
  }
  injectedTokenPath = value;
}

export function antigravityTokenPath() {
  // Router-namespaced on purpose: inheriting a vendor/IDE token-path variable
  // could make this process open the official credential store we promise
  // never to inspect. Production relocation through an inherited environment
  // variable was both nonfunctional after a service restart and could point
  // credential hardening at a directory the router does not own. Tests use an
  // explicit in-process injection instead.
  return injectedTokenPath || path.join(STATE_DIR, "antigravity-oauth.json");
}

function antigravityDisconnectFencePath() {
  return `${antigravityTokenPath()}.disconnect-fence.json`;
}

function antigravitySignInIntentPath() {
  return `${antigravityTokenPath()}.sign-in-intent.json`;
}

function antigravityRefreshStatePath() {
  return `${antigravityTokenPath()}.refresh-state.json`;
}

function removeAntigravityRefreshState() {
  try {
    unlinkSync(antigravityRefreshStatePath());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readBoundedDescriptor(descriptor) {
  const buffer = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(descriptor, buffer, length, buffer.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length > MAX_CREDENTIAL_FILE_BYTES) throw new Error("file exceeds safe limit");
  return buffer.subarray(0, length).toString("utf8");
}

function safeReadJsonFile(target, description, { optional = false } = {}) {
  let descriptor;
  try {
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error("unsafe file");
    }
    const noFollow = fsConstants.O_NOFOLLOW || 0;
    descriptor = openSync(target, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_CREDENTIAL_FILE_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("file changed while opening");
    }
    return JSON.parse(readBoundedDescriptor(descriptor));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined;
    throw unauthorizedError(`${description} could not be read safely.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pathEntryExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function antigravityTokenPathEntryExists() {
  return pathEntryExists(antigravityTokenPath());
}

export function antigravityTokenFileIsRegular() {
  const target = antigravityTokenPath();
  try {
    const metadata = lstatSync(target);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertRegularAntigravityTokenFile() {
  if (!antigravityTokenFileIsRegular()) {
    throw unauthorizedError(
      "Antigravity OAuth refuses a symlink or non-file credential record; disconnect it explicitly before signing in.",
    );
  }
}

function oauthError(
  message,
  { code = "oauth_error", status = 502, cause, providerCode } = {},
) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (cause !== undefined) error.cause = cause;
  if (providerCode !== undefined) error.providerCode = providerCode;
  return error;
}

function unauthorizedError(message, { providerCode } = {}) {
  return oauthError(message, {
    code: "oauth_unauthorized",
    status: 401,
    providerCode,
  });
}

function rejectedClientError() {
  return unauthorizedError(
    "Google rejected the stored Antigravity OAuth client. Disconnect it before signing in with a valid operator-owned Google Desktop app client.",
    { providerCode: "invalid_client" },
  );
}

function transientError(message, cause) {
  return oauthError(message, { code: "oauth_transient", status: 503, cause });
}

function sessionChangedError(message = "The Antigravity OAuth session changed while the operation was running; retry it.") {
  return oauthError(message, { code: "oauth_session_changed", status: 409 });
}

// Capture this synchronously when sign-in begins. Disconnect rotates the
// private marker while holding the same lock used by token saves, so a
// callback that started before a disconnect can never recreate the removed
// credential after its network exchange finally returns.
export function antigravityDisconnectFence() {
  const target = antigravityDisconnectFencePath();
  const value = safeReadJsonFile(target, "Antigravity OAuth disconnect state", { optional: true });
  if (value === undefined) return "";
  try {
    if (
      Number(value?.version) !== ANTIGRAVITY_DISCONNECT_FENCE_VERSION ||
      typeof value?.generation !== "string" ||
      !UUID_V4_PATTERN.test(value.generation)
    ) {
      throw new Error("invalid disconnect fence");
    }
    return value.generation;
  } catch {
    throw unauthorizedError("Antigravity OAuth disconnect state is invalid; disconnect again.");
  }
}

function validProbeActivation(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    ["version", "state", "generation"].every((key) => Object.hasOwn(value, key)) &&
    value.version === ANTIGRAVITY_PROBE_ACTIVATION_VERSION &&
    [ANTIGRAVITY_PENDING_ACTIVATION, ANTIGRAVITY_ACTIVE_ACTIVATION].includes(value.state) &&
    typeof value.generation === "string" &&
    UUID_V4_PATTERN.test(value.generation)
  );
}

function normalizeProbeActivation(value) {
  if (!validProbeActivation(value)) {
    throw unauthorizedError(
      "Antigravity OAuth live-proof activation state is invalid; run the live probe again.",
    );
  }
  const normalized = {
    version: ANTIGRAVITY_PROBE_ACTIVATION_VERSION,
    state: value.state,
    generation: value.generation,
  };
  return normalized;
}

export function validateAntigravityOAuthClient(value) {
  const clientId = value?.client_id;
  const clientSecret = value?.client_secret;
  if (
    typeof clientId !== "string" ||
    !clientId ||
    clientId.length > 512 ||
    clientId.trim() !== clientId ||
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
    KNOWN_VENDOR_CLIENT_IDS.has(clientId)
  ) {
    throw unauthorizedError(
      "Antigravity OAuth needs an operator-owned Google Desktop app client ID.",
    );
  }
  if (
    typeof clientSecret !== "string" ||
    !clientSecret ||
    clientSecret.length > 4096 ||
    clientSecret.trim() !== clientSecret ||
    /[\u0000-\u001F\u007F]/.test(clientSecret)
  ) {
    throw unauthorizedError(
      "Antigravity OAuth needs the matching operator-owned Google client secret.",
    );
  }
  return { client_id: clientId, client_secret: clientSecret };
}

function validateOwnedAntigravityRecord(value) {
  if (
    Number(value?.version) !== ANTIGRAVITY_CREDENTIAL_VERSION ||
    value?.managed_by !== ANTIGRAVITY_CREDENTIAL_OWNER
  ) {
    throw unauthorizedError(
      "Antigravity OAuth will use only a credential created by this Codex Router sign-in flow. " +
        "Disconnect the existing incompatible record before signing in.",
    );
  }
}

function normalizeAntigravityToken(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unauthorizedError("Antigravity OAuth credential file is invalid; run sign-in again.");
  }
  if (
    value.access_token === "" &&
    value.refresh_token === "" &&
    Number(value.expires_at) === 0 &&
    Number(value.expires_in) === 0
  ) {
    throw unauthorizedError("Antigravity OAuth session was rejected; run sign-in again.");
  }
  const client = validateAntigravityOAuthClient(value);
  if (typeof value.refresh_token !== "string" || !value.refresh_token) {
    throw unauthorizedError("Antigravity OAuth refresh credential is missing; run sign-in again.");
  }
  if (typeof value.access_token !== "string" || !value.access_token) {
    throw unauthorizedError("Antigravity OAuth credential is missing; run sign-in again.");
  }
  const expiresAt = Number(value.expires_at);
  const expiresIn = Number(value.expires_in);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw unauthorizedError("Antigravity OAuth credential has invalid expiry metadata; run sign-in again.");
  }
  const projectCheckedAt = Number(value.project_checked_at);
  if (typeof value.session_generation !== "string" || !UUID_V4_PATTERN.test(value.session_generation)) {
    throw unauthorizedError(
      "Antigravity OAuth credential has no valid session generation; disconnect it and sign in again.",
    );
  }
  const projectRevision = Object.hasOwn(value, "project_revision")
    ? value.project_revision
    : value.session_generation;
  if (typeof projectRevision !== "string" || !UUID_V4_PATTERN.test(projectRevision)) {
    throw unauthorizedError(
      "Antigravity OAuth credential has an invalid project revision; disconnect it and sign in again.",
    );
  }
  const probeActivation = Object.hasOwn(value, "probe_activation")
    ? normalizeProbeActivation(value.probe_activation)
    : undefined;
  const normalized = {
    ...client,
    session_generation: value.session_generation,
    // Records written before project fencing derive a stable initial revision
    // from the session generation. The first project mutation persists it,
    // while every explicit invalidation rotates it under the token lock.
    project_revision: projectRevision,
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: expiresAt,
    expires_in: expiresIn,
    project_id: typeof value.project_id === "string" ? value.project_id : "",
    project_source: value.project_source === "managed" || value.project_source === "fallback"
      ? value.project_source
      : undefined,
    project_checked_at: Number.isFinite(projectCheckedAt) ? projectCheckedAt : undefined,
    tier_id: typeof value.tier_id === "string" && value.tier_id ? value.tier_id : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
    token_type: typeof value.token_type === "string" ? value.token_type : "Bearer",
    probe_version: Number(value.probe_version) === ANTIGRAVITY_PROBE_VERSION
      ? ANTIGRAVITY_PROBE_VERSION
      : undefined,
    probe_verified_at: Number.isFinite(Number(value.probe_verified_at))
      ? Number(value.probe_verified_at)
      : undefined,
    probe_model: typeof value.probe_model === "string" && value.probe_model
      ? value.probe_model
      : undefined,
    ...(probeActivation ? { probe_activation: probeActivation } : {}),
  };
  if (probeActivation && !antigravityProbeTupleIsVerified(normalized)) {
    throw unauthorizedError(
      "Antigravity OAuth live-proof activation is not bound to a complete managed-project proof.",
    );
  }
  return normalized;
}

export function validateAntigravityToken(value) {
  validateOwnedAntigravityRecord(value);
  return normalizeAntigravityToken(value);
}

function antigravityProbeTupleIsVerified(token) {
  return (
    token?.probe_version === ANTIGRAVITY_PROBE_VERSION &&
    Number.isFinite(token?.probe_verified_at) &&
    token.probe_verified_at > 0 &&
    token?.probe_model === ANTIGRAVITY_PROBE_MODEL &&
    typeof token?.project_id === "string" &&
    token.project_id.length > 0 &&
    token.project_source === "managed"
  );
}

export function antigravityProbeActivationState(token) {
  if (!antigravityProbeTupleIsVerified(token)) return { state: "unverified" };
  // No pre-activation v2 proof is trustworthy enough to grandfather. The old
  // writer persisted this tuple before service readiness, which is precisely
  // the race the activation record closes; require a fresh explicit probe.
  if (!Object.hasOwn(token, "probe_activation")) return { state: "unverified" };
  if (!validProbeActivation(token.probe_activation)) return { state: "invalid" };
  return { ...token.probe_activation };
}

export function antigravityProbeIsVerified(token) {
  return antigravityProbeActivationState(token).state === ANTIGRAVITY_ACTIVE_ACTIVATION;
}

export function antigravityProbeStartupState(token) {
  const activation = antigravityProbeActivationState(token);
  if (activation.state === ANTIGRAVITY_ACTIVE_ACTIVATION) {
    return { startForwarder: true };
  }
  if (activation.state === ANTIGRAVITY_PENDING_ACTIVATION) {
    return {
      startForwarder: true,
      pendingActivationGeneration: activation.generation,
      pendingSessionGeneration: token.session_generation,
    };
  }
  return { startForwarder: false };
}

export function antigravityProbeActivationIsActive(token, generation) {
  const activation = antigravityProbeActivationState(token);
  return (
    activation.state === ANTIGRAVITY_ACTIVE_ACTIVATION &&
    activation.generation === generation
  );
}

export function readAntigravityToken() {
  if (discoveryDisabled()) {
    throw unauthorizedError(
      "Provider credential discovery is disabled; rerun setup without --no-discovery first.",
    );
  }
  const tokenPath = antigravityTokenPath();
  if (!pathEntryExists(tokenPath)) {
    throw unauthorizedError("Antigravity OAuth credentials were not found; run sign-in first.");
  }
  assertRegularAntigravityTokenFile();
  try {
    return validateAntigravityToken(
      safeReadJsonFile(tokenPath, "Antigravity OAuth credential"),
    );
  } catch (error) {
    if (error?.code === "oauth_unauthorized") throw error;
    throw unauthorizedError("Antigravity OAuth credential file is invalid; run sign-in again.");
  }
}

export function readAntigravityRecordForStatus() {
  return safeReadJsonFile(
    antigravityTokenPath(),
    "Antigravity OAuth credential",
  );
}

export function readAntigravityOAuthClient({ optional = false } = {}) {
  if (discoveryDisabled()) {
    if (optional) return undefined;
    throw unauthorizedError(
      "Provider credential discovery is disabled; rerun setup without --no-discovery first.",
    );
  }
  const tokenPath = antigravityTokenPath();
  if (!pathEntryExists(tokenPath)) {
    if (optional) return undefined;
    throw unauthorizedError("Antigravity OAuth client credentials were not found; run sign-in first.");
  }
  assertRegularAntigravityTokenFile();
  try {
    const value = safeReadJsonFile(tokenPath, "Antigravity OAuth client credential");
    validateOwnedAntigravityRecord(value);
    if (value?.rejection_reason === "invalid_client") throw rejectedClientError();
    return validateAntigravityOAuthClient(value);
  } catch (error) {
    if (error?.code === "oauth_unauthorized") throw error;
    throw unauthorizedError("Antigravity OAuth client credentials are invalid; run sign-in again.");
  }
}

function atomicSaveToken(token) {
  const normalized = normalizeAntigravityToken(token);
  writePrivateJson(
    antigravityTokenPath(),
    {
      version: ANTIGRAVITY_CREDENTIAL_VERSION,
      managed_by: ANTIGRAVITY_CREDENTIAL_OWNER,
      ...normalized,
    },
    { directoryMode: 0o700 },
  );
  return normalized;
}

function abortReason(signal) {
  return signal?.reason || new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

async function withTokenLock(run, { signal } = {}) {
  let owner;
  try {
    owner = await acquireTokenMutationOwner({ signal });
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error?.code === "oauth_transient") throw error;
    throw transientError("Antigravity OAuth credential lock is unavailable.", error);
  }
  let result;
  let operationError;
  try {
    result = await run();
  } catch (error) {
    operationError = error;
  }
  let releaseError;
  try {
    await closeOwnerServer(owner);
  } catch (error) {
    releaseError = error;
  }
  if (operationError) {
    if (releaseError && typeof operationError === "object") {
      try {
        operationError.tokenOwnerReleaseError = releaseError;
      } catch {}
    }
    throw operationError;
  }
  if (releaseError) {
    throw transientError(
      "Antigravity OAuth credential ownership could not be released safely.",
      releaseError,
    );
  }
  return result;
}

function readSignInIntent({ optional = false } = {}) {
  const value = safeReadJsonFile(
    antigravitySignInIntentPath(),
    "Antigravity OAuth sign-in intent",
    { optional },
  );
  if (value === undefined) return undefined;
  if (
    Number(value?.version) !== ANTIGRAVITY_SIGN_IN_INTENT_VERSION ||
    typeof value?.generation !== "string" ||
    !UUID_V4_PATTERN.test(value.generation) ||
    typeof value?.disconnect_fence !== "string"
  ) {
    throw unauthorizedError("Antigravity OAuth sign-in intent is invalid; start sign-in again.");
  }
  return value;
}

export async function beginAntigravitySignInIntent({ signal } = {}) {
  return withTokenLock(() => {
    const intent = {
      version: ANTIGRAVITY_SIGN_IN_INTENT_VERSION,
      generation: randomUUID(),
      disconnect_fence: antigravityDisconnectFence(),
    };
    writePrivateJson(antigravitySignInIntentPath(), intent, { directoryMode: 0o700 });
    return { ...intent };
  }, { signal });
}

export async function saveAntigravityToken(
  token,
  { disconnectFence, signInGeneration, signal } = {},
) {
  return withTokenLock(() => {
    if (
      disconnectFence !== undefined &&
      antigravityDisconnectFence() !== disconnectFence
    ) {
      throw oauthError(
        "Antigravity OAuth was disconnected while sign-in was completing; start a new sign-in.",
        { code: "oauth_disconnected", status: 409 },
      );
    }
    if (signInGeneration !== undefined) {
      const intent = readSignInIntent({ optional: true });
      if (
        !intent ||
        intent.generation !== signInGeneration ||
        intent.disconnect_fence !== disconnectFence
      ) {
        throw sessionChangedError(
          "A newer Antigravity OAuth sign-in superseded this callback; use the newer sign-in.",
        );
      }
    }
    const target = antigravityTokenPath();
    if (pathEntryExists(target)) {
      assertRegularAntigravityTokenFile();
      let existing;
      try {
        existing = safeReadJsonFile(target, "Antigravity OAuth credential");
        validateOwnedAntigravityRecord(existing);
        if (existing?.rejection_reason === "invalid_client") throw rejectedClientError();
      } catch (error) {
        if (error?.code === "oauth_unauthorized") throw error;
        throw unauthorizedError(
          "Antigravity OAuth will not overwrite an invalid or unowned credential file.",
        );
      }
      const previousClient = validateAntigravityOAuthClient(existing);
      const nextClient = validateAntigravityOAuthClient(token);
      if (
        previousClient.client_id !== nextClient.client_id ||
        previousClient.client_secret !== nextClient.client_secret
      ) {
        throw unauthorizedError(
          "Disconnect the existing Antigravity OAuth client before connecting a different pair.",
        );
      }
    }
    const saved = atomicSaveToken({
      ...token,
      session_generation: signInGeneration || token?.session_generation || randomUUID(),
    });
    // A new authorization-code result is a new durable refresh boundary. Any
    // abandoned journal belongs to the replaced session and must not make the
    // new operator-approved credential look ambiguous.
    removeAntigravityRefreshState();
    if (signInGeneration !== undefined) {
      try {
        unlinkSync(antigravitySignInIntentPath());
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return saved;
  }, { signal });
}

export async function updateAntigravityToken(transform) {
  if (typeof transform !== "function") throw new TypeError("transform must be a function");
  return withTokenLock(async () => {
    const latest = readAntigravityToken();
    const candidate = await transform({ ...latest });
    if (candidate === undefined || candidate === null || candidate === latest) return latest;
    return atomicSaveToken(candidate);
  });
}

export function assertAntigravitySessionCurrent(session) {
  const latest = readAntigravityToken();
  if (
    typeof session?.session_generation !== "string" ||
    latest.session_generation !== session.session_generation
  ) {
    throw sessionChangedError();
  }
  return latest;
}

export function assertAntigravitySessionActivated(
  session,
  expectedActivationGeneration,
) {
  const latest = assertAntigravitySessionCurrent(session);
  const activation = antigravityProbeActivationState(latest);
  if (
    activation.state !== ANTIGRAVITY_ACTIVE_ACTIVATION ||
    (expectedActivationGeneration !== undefined &&
      activation.generation !== expectedActivationGeneration)
  ) {
    throw oauthError(
      "Antigravity OAuth remains disabled until this exact session has an active truthful live proof.",
      { code: "antigravity_probe_required", status: 403 },
    );
  }
  return latest;
}

export function pendingAntigravityProbeActivation(generation = randomUUID()) {
  return normalizeProbeActivation({
    version: ANTIGRAVITY_PROBE_ACTIVATION_VERSION,
    state: ANTIGRAVITY_PENDING_ACTIVATION,
    generation,
  });
}

export async function promoteAntigravityProbeActivation(generation, expectedSessionGeneration) {
  if (typeof generation !== "string" || !UUID_V4_PATTERN.test(generation)) {
    throw new TypeError("Antigravity probe activation generation must be a UUID.");
  }
  let matched = false;
  let saved;
  try {
    saved = await updateAntigravityToken((latest) => {
      if (
        expectedSessionGeneration !== undefined &&
        latest.session_generation !== expectedSessionGeneration
      ) return undefined;
      const activation = antigravityProbeActivationState(latest);
      if (
        activation.state === ANTIGRAVITY_ACTIVE_ACTIVATION &&
        activation.generation === generation
      ) {
        matched = true;
        return undefined;
      }
      if (
        activation.state !== ANTIGRAVITY_PENDING_ACTIVATION ||
        activation.generation !== generation
      ) {
        return undefined;
      }
      matched = true;
      return {
        ...latest,
        probe_activation: {
          ...activation,
          state: ANTIGRAVITY_ACTIVE_ACTIVATION,
        },
      };
    });
  } catch (error) {
    // A disconnect or incompatible replacement that wins the token lock is a
    // failed compare-and-set, not permission for the stale startup to recreate
    // or bless the record it originally read.
    if (error?.code === "oauth_unauthorized") return false;
    throw error;
  }
  return matched && antigravityProbeActivationIsActive(saved, generation);
}

export async function deactivateAntigravityProbeActivation(generation, expectedSessionGeneration) {
  if (typeof generation !== "string" || !UUID_V4_PATTERN.test(generation)) {
    throw new TypeError("Antigravity probe activation generation must be a UUID.");
  }
  let saved;
  try {
    saved = await updateAntigravityToken((latest) => {
      if (
        expectedSessionGeneration !== undefined &&
        latest.session_generation !== expectedSessionGeneration
      ) return undefined;
      const activation = antigravityProbeActivationState(latest);
      if (
        activation.state !== ANTIGRAVITY_ACTIVE_ACTIVATION ||
        activation.generation !== generation
      ) {
        return undefined;
      }
      return {
        ...latest,
        probe_activation: {
          ...activation,
          state: ANTIGRAVITY_PENDING_ACTIVATION,
        },
      };
    });
  } catch (error) {
    // A replacement or disconnect means this exact generation is already no
    // longer active. Never recreate the record merely to perform rollback.
    if (error?.code === "oauth_unauthorized") return true;
    throw error;
  }
  return !antigravityProbeActivationIsActive(saved, generation);
}

export function storedAntigravityProbeActivationIsActive(generation, expectedSessionGeneration) {
  try {
    const token = readAntigravityToken();
    return (
      (expectedSessionGeneration === undefined ||
        token.session_generation === expectedSessionGeneration) &&
      antigravityProbeActivationIsActive(token, generation)
    );
  } catch {
    return false;
  }
}

export async function invalidateAntigravityProbeProof(session) {
  let matched = false;
  const projectRevision = randomUUID();
  const saved = await updateAntigravityToken((latest) => {
    if (
      latest.session_generation !== session?.session_generation
    ) {
      return undefined;
    }
    matched = true;
    const {
      probe_version: _probeVersion,
      probe_verified_at: _probeVerifiedAt,
      probe_model: _probeModel,
      probe_activation: _probeActivation,
      ...withoutProof
    } = latest;
    return { ...withoutProof, project_revision: projectRevision };
  });
  if (!matched) {
    throw oauthError(
      "The Antigravity OAuth credential changed before the live probe began; retry it.",
      { code: "oauth_credential_changed", status: 409 },
    );
  }
  return saved;
}

export async function removeAntigravityToken() {
  return withTokenLock(async () => {
    const target = antigravityTokenPath();
    const existed = pathEntryExists(target);
    writePrivateJson(
      antigravityDisconnectFencePath(),
      {
        version: ANTIGRAVITY_DISCONNECT_FENCE_VERSION,
        generation: randomUUID(),
      },
      { directoryMode: 0o700 },
    );
    const { invalidateAntigravityProjectCache } = await import("./antigravity-project.mjs");
    if (existed) {
      const metadata = lstatSync(target);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        try {
          // rmdir removes only this exact empty entry and never follows a
          // replacement symlink or descends into operator-owned contents.
          rmdirSync(target);
        } catch (error) {
          if (["ENOTEMPTY", "EEXIST"].includes(error?.code)) {
            throw oauthError(
              "The incompatible Antigravity OAuth record path is a nonempty directory. " +
                "Review and remove its contents and the directory manually, then disconnect again; " +
                "Codex Router will not delete it recursively.",
              { code: "oauth_credential_recovery_required", status: 409, cause: error },
            );
          }
          throw oauthError(
            "The incompatible Antigravity OAuth record directory could not be removed safely. " +
              "Inspect its permissions and contents manually, remove the directory when safe, then disconnect again.",
            { code: "oauth_credential_recovery_required", status: 409, cause: error },
          );
        }
      } else {
        // unlink removes the directory entry itself. In particular, a symlink
        // is removed without opening or modifying its target.
        try {
          unlinkSync(target);
        } catch (error) {
          throw oauthError(
            "The incompatible Antigravity OAuth record entry changed or could not be removed safely. " +
              "Inspect that exact path manually, remove it when safe, then disconnect again.",
            { code: "oauth_credential_recovery_required", status: 409, cause: error },
          );
        }
      }
    }
    try {
      unlinkSync(antigravitySignInIntentPath());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    removeAntigravityRefreshState();
    // Disconnect never needs to inspect the credential it is deleting. Clear
    // pending in-memory project discoveries so this explicit removal is
    // also safe while --no-discovery is active.
    invalidateAntigravityProjectCache();
    return existed;
  });
}

export function protectAntigravityToken() {
  if (discoveryDisabled()) return false;
  const target = antigravityTokenPath();
  if (!pathEntryExists(target)) return false;
  if (!antigravityTokenFileIsRegular()) return false;
  protectPrivateFile(target);
  return target;
}

function shouldRefresh(token, nowSeconds) {
  return nowSeconds >= token.expires_at - REFRESH_THRESHOLD_SECONDS;
}

function isHardExpired(token, nowSeconds) {
  return nowSeconds >= token.expires_at;
}

function sameToken(left, right) {
  return (
    left.session_generation === right.session_generation &&
    left.client_id === right.client_id &&
    left.client_secret === right.client_secret &&
    left.access_token === right.access_token &&
    left.refresh_token === right.refresh_token &&
    left.expires_at === right.expires_at
  );
}

function sameOAuthClient(left, right) {
  return (
    left?.client_id === right?.client_id &&
    left?.client_secret === right?.client_secret
  );
}

function sameCredentialSnapshot(left, right) {
  const leftActivation = left?.probe_activation;
  const rightActivation = right?.probe_activation;
  const sameActivation = (
    (leftActivation === undefined && rightActivation === undefined) ||
    (leftActivation?.version === rightActivation?.version &&
      leftActivation?.state === rightActivation?.state &&
      leftActivation?.generation === rightActivation?.generation)
  );
  return (
    sameToken(left, right) &&
    left.project_revision === right.project_revision &&
    left.expires_in === right.expires_in &&
    left.project_id === right.project_id &&
    left.project_source === right.project_source &&
    left.project_checked_at === right.project_checked_at &&
    left.tier_id === right.tier_id &&
    left.email === right.email &&
    left.token_type === right.token_type &&
    left.probe_version === right.probe_version &&
    left.probe_verified_at === right.probe_verified_at &&
    left.probe_model === right.probe_model &&
    sameActivation
  );
}

function revokedTombstone(token, { reason } = {}) {
  return {
    client_id: token.client_id,
    client_secret: token.client_secret,
    session_generation: token.session_generation,
    project_revision: token.project_revision,
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    expires_in: 0,
    project_id: token.project_source === "managed" ? token.project_id : "",
    project_source: token.project_source,
    project_checked_at: token.project_checked_at,
    tier_id: token.tier_id,
    email: token.email,
    token_type: token.token_type,
    ...(["invalid_client", "refresh_outcome_unknown"].includes(reason)
      ? { rejection_reason: reason }
      : {}),
  };
}

function writeRevokedTombstone(token, { reason } = {}) {
  writePrivateJson(
    antigravityTokenPath(),
    {
      version: ANTIGRAVITY_CREDENTIAL_VERSION,
      managed_by: ANTIGRAVITY_CREDENTIAL_OWNER,
      ...revokedTombstone(token, { reason }),
    },
    { directoryMode: 0o700 },
  );
}

function fnv1a64(value, seed = FNV64_OFFSET) {
  let hash = seed;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV64_PRIME);
  }
  return hash;
}

function ownerLeaseIdentity(value) {
  // This is routing, not credential verification: a collision can only deny a
  // lease, never admit two owners. A non-cryptographic digest states that
  // contract plainly and avoids treating a credential pathname as a password.
  const first = fnv1a64(`first\0${value}`);
  const second = fnv1a64(`second\0${value}`, FNV64_OFFSET ^ 0x9e3779b97f4a7c15n);
  return {
    id: `${first.toString(16).padStart(16, "0")}${second.toString(16).padStart(16, "0")}`
      .slice(0, 24),
    portOffset: Number(first & 0xffffffffn),
  };
}

function ownerLeaseEndpoint(namespace, posixPortBase) {
  const tokenPath = path.resolve(antigravityTokenPath());
  // Resolve only the existing parent. The credential itself is atomically
  // replaced after a rotation, so inode identity would change between owners;
  // resolving the parent makes stable directory aliases converge without ever
  // following a credential-path symlink that safeReadJsonFile would reject.
  let identity = path.join(
    realpathSync.native(path.dirname(tokenPath)),
    path.basename(tokenPath),
  );
  if (process.platform === "win32") identity = identity.toLowerCase();
  const leaseIdentity = ownerLeaseIdentity(`${namespace}\0${identity}`);
  if (process.platform === "win32") {
    // Named-pipe ownership belongs to the server handle. Windows removes the
    // pipe instance when its process dies, and a suspended process retains it.
    return `\\\\.\\pipe\\codex-router-antigravity-${namespace}-${leaseIdentity.id}`;
  }
  // Linux has abstract Unix sockets, but macOS does not. A deterministic
  // loopback listener gives both platforms the same kernel-owned lifetime and
  // atomic exclusion without a stale filesystem pathname. A hash collision or
  // unrelated listener can deny this refresh temporarily, but can never allow
  // two owners; acquisition therefore fails closed after the bounded wait.
  return {
    host: "127.0.0.1",
    port: posixPortBase +
      (leaseIdentity.portOffset % POSIX_OWNER_LEASE_PORT_COUNT),
    exclusive: true,
  };
}

function refreshLeaseEndpoint() {
  return ownerLeaseEndpoint("refresh", POSIX_REFRESH_LEASE_PORT_BASE);
}

function tokenMutationLeaseEndpoint() {
  return ownerLeaseEndpoint("token", POSIX_TOKEN_MUTATION_LEASE_PORT_BASE);
}

function listenOwnerServer(server, endpoint, callback) {
  if (process.platform !== "win32" || typeof endpoint !== "string") {
    server.listen(endpoint, callback);
    return;
  }

  // Node 22/24/26 can access-violate after a named-pipe bind loses with
  // EADDRINUSE when this inherited tuning variable caused libuv to mark the
  // unbound handle as a pipe server first (nodejs/node#65057). Node reads the
  // variable synchronously inside listen(), so remove it only around that
  // call and restore the operator's process environment before yielding.
  const hadPendingInstances = Object.hasOwn(process.env, "NODE_PENDING_PIPE_INSTANCES");
  const pendingInstances = process.env.NODE_PENDING_PIPE_INSTANCES;
  delete process.env.NODE_PENDING_PIPE_INSTANCES;
  try {
    server.listen(endpoint, callback);
  } finally {
    if (hadPendingInstances) process.env.NODE_PENDING_PIPE_INSTANCES = pendingInstances;
  }
}

function startOwnerServer(endpoint) {
  return new Promise((resolve, reject) => {
    // This temporary listener is a kernel lease, not a long-lived HTTP server
    // entry point. Production entry points remain responsible for installing
    // the process-wide stable fetch dispatcher exactly once.
    const server = new net.Server((socket) => socket.destroy());
    const onError = (error) => {
      reject(error);
    };
    server.once("error", onError);
    listenOwnerServer(server, endpoint, () => {
      server.off("error", onError);
      // A later accept error must not become an unhandled process crash. Only
      // closing this listening handle (or process death) releases ownership.
      server.on("error", () => {});
      server.unref();
      resolve(server);
    });
  });
}

// The Windows-only regression fixture needs the exact production bind helper
// so a losing named-pipe election proves the process survives. It returns only
// the server handle and never exposes an endpoint derived from a credential.
export function startAntigravityOwnerServerForTests(endpoint) {
  return startOwnerServer(endpoint);
}

async function closeOwnerServer(owner) {
  if (!owner?.server) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
    try {
      owner.server.close(finish);
    } catch {
      finish();
    }
  });
}

async function acquireTokenMutationOwner({ signal } = {}) {
  mkdirSync(path.dirname(antigravityTokenPath()), { recursive: true, mode: 0o700 });
  const endpoint = tokenMutationLeaseEndpoint();
  const waitDeadline = Date.now() + TOKEN_MUTATION_LEASE_WAIT_MS;
  // The deadline limits only this caller's wait. It never reclaims the lease:
  // a live or suspended owner's kernel handle remains authoritative until that
  // owner closes it or exits.
  for (;;) {
    throwIfAborted(signal);
    try {
      const server = await startOwnerServer(endpoint);
      return { server };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (!["EADDRINUSE", "EACCES"].includes(error?.code)) {
        throw transientError("Antigravity OAuth credential lock is unavailable.", error);
      }
      if (Date.now() >= waitDeadline) {
        throw transientError(
          "Antigravity OAuth credential lock remained unavailable beyond its safe wait horizon.",
          error,
        );
      }
      await delay(TOKEN_LOCK_RETRY_MS, signal);
    }
  }
}

async function acquireRefreshOwner({ signal } = {}) {
  if (REFRESH_LEASE_WAIT_MS <= REFRESH_LEASE_STALE_HORIZON_MS) {
    throw new Error("Antigravity refresh lease wait must exceed its stale horizon.");
  }
  const ownerNonce = randomUUID();
  const endpoint = refreshLeaseEndpoint();
  const waitDeadline = Date.now() + REFRESH_LEASE_WAIT_MS;
  for (;;) {
    throwIfAborted(signal);
    try {
      const server = await startOwnerServer(endpoint);
      return { owner_nonce: ownerNonce, server };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (!["EADDRINUSE", "EACCES"].includes(error?.code)) {
        throw transientError("Antigravity OAuth refresh lease is unavailable.", error);
      }
      if (Date.now() >= waitDeadline) {
        throw transientError(
          "Antigravity OAuth refresh ownership remained unavailable beyond the safe wait horizon.",
          error,
        );
      }
      await delay(REFRESH_LEASE_RETRY_MS, signal);
    }
  }
}

async function withRefreshLease(run, { signal } = {}) {
  const owner = await acquireRefreshOwner({ signal });
  let result;
  let operationError;
  try {
    // This OS-owned lease intentionally spans HTTP. It serializes refresh-token
    // use across processes without relying on a heartbeat that suspension can
    // stop, while every credential CAS uses the separate short token lock.
    result = await run(owner);
  } catch (error) {
    operationError = error;
  }
  let releaseError;
  try {
    // Only this server handle can release this lease. There is no pathname to
    // unlink and therefore no stale holder can remove a successor's ownership.
    await closeOwnerServer(owner);
  } catch (error) {
    releaseError = error;
  }
  if (operationError) {
    if (releaseError && typeof operationError === "object") {
      try {
        operationError.refreshOwnerReleaseError = releaseError;
      } catch {}
    }
    throw operationError;
  }
  if (releaseError) {
    throw transientError("Antigravity OAuth refresh ownership could not be released safely.", releaseError);
  }
  return result;
}

function refreshTokenFingerprint(token) {
  const snapshot = [
    token.session_generation,
    token.client_id,
    token.client_secret,
    token.access_token,
    token.refresh_token,
    token.expires_at,
  ].map((value) => String(value));
  return scryptSync(
    JSON.stringify(snapshot),
    REFRESH_FINGERPRINT_SALT,
    32,
    REFRESH_FINGERPRINT_SCRYPT_OPTIONS,
  ).toString("hex");
}

function normalizeRefreshState(value) {
  const exactKeys = [
    "epoch",
    "owner_nonce",
    "phase",
    "session_generation",
    "token_fingerprint",
    "version",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== exactKeys.sort().join("\0") ||
    value.version !== ANTIGRAVITY_REFRESH_STATE_VERSION ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch <= 0 ||
    typeof value.owner_nonce !== "string" ||
    !UUID_V4_PATTERN.test(value.owner_nonce) ||
    ![REFRESH_PHASE_CLAIMED, REFRESH_PHASE_DISPATCHED, REFRESH_PHASE_UNCERTAIN]
      .includes(value.phase) ||
    typeof value.session_generation !== "string" ||
    !UUID_V4_PATTERN.test(value.session_generation) ||
    typeof value.token_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.token_fingerprint)
  ) {
    throw oauthError(
      "Antigravity OAuth refresh state is invalid; disconnect and sign in again before retrying.",
      { code: "oauth_credential_recovery_required", status: 409 },
    );
  }
  return { ...value };
}

function readRefreshState({ optional = false } = {}) {
  let value;
  try {
    value = safeReadJsonFile(
      antigravityRefreshStatePath(),
      "Antigravity OAuth refresh state",
      { optional },
    );
  } catch (error) {
    if (optional && !pathEntryExists(antigravityRefreshStatePath())) return undefined;
    throw oauthError(
      "Antigravity OAuth refresh state could not be read safely; disconnect and sign in again.",
      { code: "oauth_credential_recovery_required", status: 409, cause: error },
    );
  }
  return value === undefined ? undefined : normalizeRefreshState(value);
}

function writeRefreshState(state) {
  writePrivateJson(
    antigravityRefreshStatePath(),
    normalizeRefreshState(state),
    { directoryMode: 0o700 },
  );
  return state;
}

function refreshStateMatchesToken(state, token) {
  return Boolean(state) &&
    state.session_generation === token.session_generation &&
    state.token_fingerprint === refreshTokenFingerprint(token);
}

export function antigravityRefreshJournalStatus(token) {
  const state = readRefreshState({ optional: true });
  if (!refreshStateMatchesToken(state, token)) {
    return { matching: false, outcomeUnknown: false };
  }
  return {
    matching: true,
    phase: state.phase,
    outcomeUnknown: [REFRESH_PHASE_DISPATCHED, REFRESH_PHASE_UNCERTAIN]
      .includes(state.phase),
  };
}

function refreshFenceMatches(state, fence, phase) {
  return Boolean(state) &&
    state.epoch === fence.epoch &&
    state.owner_nonce === fence.owner_nonce &&
    state.session_generation === fence.session_generation &&
    state.token_fingerprint === fence.token_fingerprint &&
    (phase === undefined || state.phase === phase);
}

function refreshSupersededError() {
  return oauthError(
    "A newer Antigravity OAuth refresh owner superseded this result; retry the request.",
    { code: "oauth_refresh_superseded", status: 409 },
  );
}

function refreshOutcomeUnknownError() {
  return oauthError(
    "A previous Antigravity OAuth refresh ended after dispatch without a durably committed result, so its one-time token outcome is unknown. Sign in again before routing another request.",
    { code: "oauth_refresh_outcome_unknown", status: 401 },
  );
}

function ambiguousRefreshAttemptError(error, message) {
  // Always wrap into an error we own. Abort reasons and injected fetch errors
  // can be frozen objects; silently failing to attach the classification would
  // clear the dispatch journal and make an ambiguous one-time rotation usable
  // again.
  const detail = message || (error instanceof Error && error.message) ||
    "Antigravity OAuth refresh ended with an unknown provider outcome.";
  const result = transientError(detail, error instanceof Error ? error : undefined);
  Object.defineProperty(result, "refreshOutcomeUnknown", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return result;
}

function provablyPreconnectRefreshFailure(error) {
  const visited = new Set();
  const pending = [{ value: error, depth: 0 }];
  let provenCode = false;
  while (pending.length) {
    const { value, depth } = pending.shift();
    // A code-less leaf, malformed AggregateError member, cycle, or truncated
    // graph is not proof that no request byte reached Google. Fetch commonly
    // wraps a real connect error in a code-less TypeError, so wrappers are
    // allowed only when every path below them terminates in an allowlisted
    // pre-connect code.
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    if (
      value.name === "AbortError" ||
      value.name === "TimeoutError" ||
      (value.status !== undefined && value.status !== null)
    ) {
      return false;
    }

    const hasCode = value.code !== undefined && value.code !== null && value.code !== "";
    if (hasCode) {
      if (
        typeof value.code !== "string" ||
        !PROVABLY_PRECONNECT_REFRESH_CODES.has(value.code)
      ) {
        return false;
      }
      provenCode = true;
    }

    const children = [];
    if (value.cause !== undefined && value.cause !== null) children.push(value.cause);
    if (Object.hasOwn(value, "errors")) {
      if (!Array.isArray(value.errors) || value.errors.length === 0) return false;
      for (const member of value.errors) {
        children.push(member);
      }
    }
    if (children.length === 0) {
      if (!hasCode) return false;
      continue;
    }
    if (depth >= MAX_REFRESH_ERROR_GRAPH_DEPTH) return false;
    for (const child of children) {
      if (!child || typeof child !== "object") return false;
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return provenCode;
}

function removeRefreshStateIfOwned(fence) {
  const state = readRefreshState({ optional: true });
  if (!refreshFenceMatches(state, fence)) return false;
  removeAntigravityRefreshState();
  return true;
}

function failClosedUnknownRefresh(expected, fence) {
  const latest = readAntigravityToken();
  if (latest.session_generation !== expected.session_generation) throw sessionChangedError();
  const state = readRefreshState({ optional: true });
  if (!refreshFenceMatches(state, fence, REFRESH_PHASE_DISPATCHED)) {
    throw refreshSupersededError();
  }
  if (!sameToken(latest, expected)) {
    removeRefreshStateIfOwned(fence);
    return latest;
  }
  // Publish uncertainty first. If this process dies before writing the
  // tombstone, the next owner observes the dispatched/uncertain journal and
  // completes the fail-closed transition without another provider attempt.
  writeRefreshState({ ...state, phase: REFRESH_PHASE_UNCERTAIN });
  writeRevokedTombstone(latest, { reason: "refresh_outcome_unknown" });
  return undefined;
}

async function claimRefreshFence(expected, owner, { signal } = {}) {
  return withTokenLock(() => {
    const latest = readAntigravityToken();
    if (latest.session_generation !== expected.session_generation) throw sessionChangedError();
    if (!sameToken(latest, expected)) return { complete: latest };

    const previous = readRefreshState({ optional: true });
    if (
      refreshStateMatchesToken(previous, latest) &&
      [REFRESH_PHASE_DISPATCHED, REFRESH_PHASE_UNCERTAIN].includes(previous.phase)
    ) {
      writeRefreshState({ ...previous, phase: REFRESH_PHASE_UNCERTAIN });
      writeRevokedTombstone(latest, { reason: "refresh_outcome_unknown" });
      throw refreshOutcomeUnknownError();
    }

    const priorEpoch = previous?.epoch || 0;
    if (priorEpoch >= Number.MAX_SAFE_INTEGER) {
      throw oauthError(
        "Antigravity OAuth refresh fencing epoch is exhausted; disconnect and sign in again.",
        { code: "oauth_credential_recovery_required", status: 409 },
      );
    }
    const fence = {
      version: ANTIGRAVITY_REFRESH_STATE_VERSION,
      epoch: priorEpoch + 1,
      owner_nonce: owner.owner_nonce,
      phase: REFRESH_PHASE_CLAIMED,
      session_generation: latest.session_generation,
      token_fingerprint: refreshTokenFingerprint(latest),
    };
    writeRefreshState(fence);
    return { refresh: latest, fence };
  }, { signal });
}

async function markRefreshDispatched(expected, fence, { signal } = {}) {
  return withTokenLock(() => {
    const latest = readAntigravityToken();
    if (latest.session_generation !== expected.session_generation) throw sessionChangedError();
    const state = readRefreshState({ optional: true });
    if (!refreshFenceMatches(state, fence, REFRESH_PHASE_CLAIMED)) {
      throw refreshSupersededError();
    }
    if (!sameToken(latest, expected)) throw refreshSupersededError();
    const dispatched = { ...state, phase: REFRESH_PHASE_DISPATCHED };
    writeRefreshState(dispatched);
    return dispatched;
  }, { signal });
}

export async function revokeRejectedAntigravityClient(
  expectedToken,
  attemptedClient,
) {
  const expected = normalizeAntigravityToken(expectedToken);
  const attempted = validateAntigravityOAuthClient(attemptedClient);
  // Bind the rejection to both things the re-login flow knew before its
  // network exchange. An invalid_client for a different submitted pair says
  // nothing about the credential already on disk.
  if (!sameOAuthClient(expected, attempted)) return false;

  return withTokenLock(() => {
    let latest;
    try {
      latest = readAntigravityToken();
    } catch (error) {
      if (error?.code === "oauth_unauthorized") return false;
      throw error;
    }
    // The entire normalized credential and proof are the compare-and-set, not
    // merely the refresh token. A refresh, replacement, or new probe that
    // completed while the authorization-code request was in flight owns the
    // new record and must not inherit the stale rejection.
    if (
      !sameCredentialSnapshot(latest, expected) ||
      !sameOAuthClient(latest, attempted)
    ) {
      return false;
    }
    writePrivateJson(
      antigravityTokenPath(),
      {
        version: ANTIGRAVITY_CREDENTIAL_VERSION,
        managed_by: ANTIGRAVITY_CREDENTIAL_OWNER,
        ...revokedTombstone(latest, { reason: "invalid_client" }),
      },
      { directoryMode: 0o700 },
    );
    return true;
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(response, attempt, now, random) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_REFRESH_RETRY_DELAY_MS);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - now()), MAX_REFRESH_RETRY_DELAY_MS);
    }
  }
  return Math.min(
    2 ** attempt * 1_000 + Math.floor(random() * 250),
    MAX_REFRESH_RETRY_DELAY_MS,
  );
}

async function refreshAntigravityToken(
  refreshToken,
  client,
  {
    fetchImpl = fetch,
    now = Date.now,
    delayImpl = delay,
    random = Math.random,
    signal,
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    let response;
    try {
      response = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: client.client_id,
          client_secret: client.client_secret,
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (!signal?.aborted && provablyPreconnectRefreshFailure(error)) {
        // These codes prove that no connection capable of carrying the token
        // existed: DNS/no-route/refused failures and local socket allocation
        // failures. They may be retried, and if the bound is exhausted the
        // caller may clear this attempt's dispatch journal without consuming
        // an otherwise hard-valid refresh token.
        lastError = transientError(
          "Antigravity OAuth could not connect to Google's authentication endpoint.",
          error instanceof Error ? error : undefined,
        );
        if (attempt < 2) {
          await delayImpl(retryDelay(undefined, attempt, now, random), signal);
          continue;
        }
        throw lastError;
      }
      // Once fetch begins, a transport error or cancellation cannot prove that
      // Google did not consume and rotate the one-time refresh token. Retrying
      // the old token (or clearing the durable dispatch journal) would turn a
      // lost success response into invalid_grant and erase the only safe fence.
      throw ambiguousRefreshAttemptError(
        signal?.aborted
          ? abortReason(signal)
          : error,
        signal?.aborted
          ? undefined
          : "Antigravity OAuth refresh could not confirm Google's authentication response.",
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (response.ok) {
        throw ambiguousRefreshAttemptError(
          error,
          "Antigravity OAuth refresh returned an unreadable success response.",
        );
      }
      payload = {};
    }
    if (response.ok) {
      const expiresIn = Number(payload.expires_in);
      if (typeof payload.access_token !== "string" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw ambiguousRefreshAttemptError(
          undefined,
          "Antigravity OAuth refresh returned an incomplete success response.",
        );
      }
      return {
        access_token: payload.access_token,
        refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token
          ? payload.refresh_token
          : refreshToken,
        expires_at: Math.floor(now() / 1_000) + expiresIn,
        expires_in: expiresIn,
        token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      };
    }

    const providerCode = typeof payload.error === "string" ? payload.error : "oauth_error";
    if (providerCode === "invalid_grant") {
      throw unauthorizedError("Antigravity OAuth refresh was rejected; run sign-in again.", {
        providerCode,
      });
    }
    if (providerCode === "invalid_client") {
      throw unauthorizedError(
        "Antigravity OAuth client was rejected by Google; disconnect it, then sign in with a valid operator-owned Google Desktop app client.",
        { providerCode },
      );
    }
    if (!RETRYABLE_REFRESH_STATUSES.has(response.status)) {
      throw oauthError(`Antigravity OAuth refresh failed with HTTP ${response.status}.`, {
        code: "oauth_refresh_failed",
        status: response.status >= 400 && response.status <= 599 ? response.status : 502,
      });
    }
    lastError = transientError(`Temporary Antigravity OAuth error: HTTP ${response.status}.`);
    if (attempt < 2) await delayImpl(retryDelay(response, attempt, now, random), signal);
  }
  throw lastError || transientError("Antigravity OAuth refresh failed.");
}

export async function ensureFreshAntigravitySession({
  force = false,
  expectedGeneration,
  now = Date.now,
  fetchImpl = fetch,
  delayImpl = delay,
  random = Math.random,
  signal,
  // Deterministic fault-injection point used by cross-process crash/fencing
  // tests. Production callers never supply it.
  _beforeRefreshDispatch,
  _beforeRefreshCommit,
} = {}) {
  throwIfAborted(signal);
  const initial = readAntigravityToken();
  const generation = expectedGeneration || initial.session_generation;
  if (initial.session_generation !== generation) throw sessionChangedError();
  const preliminary = await withTokenLock(() => {
    const latest = readAntigravityToken();
    if (latest.session_generation !== generation) throw sessionChangedError();
    // A rotator that completed after this invocation's initial read already
    // answered the same refresh epoch. Forced 401 callers consume that winner
    // too; spending its newly rotated refresh token again recreates the race
    // this cross-process lease is intended to close.
    if (!sameToken(latest, initial)) return { complete: latest };
    const nowSeconds = Math.floor(now() / 1_000);
    const refreshState = readRefreshState({ optional: true });
    const unresolvedRefresh = refreshStateMatchesToken(refreshState, latest);
    // A non-forced caller must join an already-claimed refresh even while the
    // access token is hard-valid. Otherwise a dead dispatched owner remains
    // invisible until the ordinary expiry window and routing does not fail
    // closed on its durable ambiguous outcome.
    if (!force && !unresolvedRefresh && !shouldRefresh(latest, nowSeconds)) {
      return { complete: latest };
    }
    return { refresh: latest };
  }, { signal });
  if (preliminary.complete) return preliminary.complete;

  const initialRefresh = preliminary.refresh;
  const key = `${antigravityTokenPath()}\0${generation}\0${force ? "force" : "normal"}`;
  const current = signal ? undefined : refreshInFlight.get(key);
  if (current) return current;

  const promise = withRefreshLease(async (owner) => {
    const claimed = await claimRefreshFence(initialRefresh, owner, { signal });
    if (claimed.complete) return claimed.complete;

    const expected = claimed.refresh;
    const fence = claimed.fence;
    try {
      if (_beforeRefreshDispatch) await _beforeRefreshDispatch();
      await markRefreshDispatched(expected, fence, { signal });
    } catch (error) {
      // No provider request was admitted yet, so this epoch can be abandoned
      // safely. The exact-fence comparison prevents an old owner from clearing
      // a successor that has already claimed the journal.
      try {
        await withTokenLock(() => removeRefreshStateIfOwned(fence));
      } catch (cleanupError) {
        if (typeof error === "object" && error !== null) {
          try {
            error.refreshFenceCleanupError = cleanupError;
          } catch {}
        }
      }
      throw error;
    }

    let refreshed;
    try {
      refreshed = await refreshAntigravityToken(expected.refresh_token, expected, {
        fetchImpl,
        now,
        delayImpl,
        random,
        signal,
      });
    } catch (error) {
      if (error?.refreshOutcomeUnknown) {
        // The caller can still cancel an unresolved HTTP request, but that
        // cancellation cannot cancel this durable safety commit. withTokenLock
        // has a fixed 30s retry budget; a disconnect or re-login that won the
        // credential CAS remains final.
        const concurrent = await withTokenLock(() =>
          failClosedUnknownRefresh(expected, fence));
        if (concurrent) return concurrent;
        throw error;
      }
      if (error?.code === "oauth_unauthorized") {
        // A provider rejection is authoritative only for the exact durable
        // owner epoch that dispatched it. A resumed stale process can neither
        // tombstone the credential nor clear the successor's journal.
        const concurrent = await withTokenLock(() => {
          const latest = readAntigravityToken();
          if (latest.session_generation !== generation) throw sessionChangedError();
          const state = readRefreshState({ optional: true });
          if (!refreshFenceMatches(state, fence, REFRESH_PHASE_DISPATCHED)) {
            throw refreshSupersededError();
          }
          if (!sameToken(latest, expected)) {
            removeRefreshStateIfOwned(fence);
            return latest;
          }
          writeRevokedTombstone(latest, { reason: error?.providerCode });
          removeRefreshStateIfOwned(fence);
          return undefined;
        });
        if (concurrent) return concurrent;
        throw error;
      }
      const fallback = await withTokenLock(() => {
        const latest = readAntigravityToken();
        if (latest.session_generation !== generation) throw sessionChangedError();
        const state = readRefreshState({ optional: true });
        if (!refreshFenceMatches(state, fence, REFRESH_PHASE_DISPATCHED)) {
          throw refreshSupersededError();
        }
        removeRefreshStateIfOwned(fence);
        if (
          error?.code === "oauth_transient" &&
          !force &&
          !isHardExpired(latest, Math.floor(now() / 1_000))
        ) {
          return latest;
        }
        return undefined;
      });
      if (fallback) return fallback;
      throw error;
    }

    // The provider result is fully parsed. The production CAS remains bounded
    // and synchronous once it holds the mutation lease, and no longer observes
    // the caller signal, so cancellation cannot discard a one-time rotation
    // after success. Disconnect/re-login still wins through the session
    // generation and exact token/fence comparisons below. The awaited hook is
    // present only for deterministic suspension tests.
    return withTokenLock(async () => {
      const latest = readAntigravityToken();
      if (latest.session_generation !== generation) throw sessionChangedError();
      const state = readRefreshState({ optional: true });
      if (!refreshFenceMatches(state, fence, REFRESH_PHASE_DISPATCHED)) {
        throw refreshSupersededError();
      }
      if (!sameToken(latest, expected)) {
        removeRefreshStateIfOwned(fence);
        return latest;
      }
      if (_beforeRefreshCommit) await _beforeRefreshCommit();
      const saved = atomicSaveToken({ ...latest, ...refreshed });
      removeRefreshStateIfOwned(fence);
      return saved;
    });
  }, { signal }).finally(() => {
    if (refreshInFlight.get(key) === promise) refreshInFlight.delete(key);
  });
  if (!signal) refreshInFlight.set(key, promise);
  return promise;
}

export async function ensureFreshAntigravityToken(options = {}) {
  return (await ensureFreshAntigravitySession(options)).access_token;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const command = process.argv[2] || "protect";
  if (command !== "protect") {
    process.stderr.write("Usage: antigravity-oauth-session.mjs protect\n");
    process.exitCode = 2;
  } else {
    const protectedPath = protectAntigravityToken();
    process.stdout.write(`${JSON.stringify({ present: Boolean(protectedPath) })}\n`);
  }
}
