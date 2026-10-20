import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

import { parseChatGPTAccountPoolState, chatGPTSubscriptionAccountHome, isChatGPTAccountId, withChatGPTAccountPoolLock } from "./chatgpt-account-pool.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { acquireFileLock, acquireFileLockWithSignal, runWithLockRelease } from "./file-lock.mjs";
import { privateFileIsProtected, privateFilesAreProtectedAsync, writePrivateJson, writePrivateJsonAsync } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import { CHATGPT_ACCOUNT_POOL_PATH, CHATGPT_ACCOUNT_HOMES_DIR, STATE_DIR } from "./paths.mjs";
import { fetchWithRetry, NATIVE_RETRY_LIMIT, NATIVE_RETRY_BUDGET_MS } from "./upstream-retry.mjs";

export const CHATGPT_ACCOUNT_ROUTING_PATH = process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_ROUTING || path.join(STATE_DIR, "chatgpt-account-routing.json");
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 4096;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const QUOTA_CODES = new Set(["usage_limit_reached", "insufficient_quota", "workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonicalAccountId = (value) => isChatGPTAccountId(value) && value === value.trim();
const safeHeader = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function unavailable(message = "No eligible ChatGPT account is available for this request.") {
  const error = new Error(message);
  error.status = 503;
  error.code = "chatgpt_account_routing_unavailable";
  return error;
}

// Never harden or refresh credentials from the request path. A login writer's
// lease (including unfinished finalization) excludes the entire profile.
function openPrivateJson(filePath) {
  ensureNoSymlinkParents(path.dirname(filePath), { label: "ChatGPT routing state" });
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JSON_BYTES) throw unavailable();
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_JSON_BYTES || (process.platform !== "win32" && ((opened.mode & 0o777) !== 0o600 || opened.uid !== process.getuid()))) throw unavailable();
    return { filePath, descriptor, opened };
  } catch (error) { closeSync(descriptor); throw error; }
}

function readOpenedJson({ filePath, descriptor, opened }) {
  ensureNoSymlinkParents(path.dirname(filePath));
  const current = lstatSync(filePath);
  const checked = fstatSync(descriptor);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || checked.size !== opened.size || checked.mtimeMs !== opened.mtimeMs || checked.ctimeMs !== opened.ctimeMs) throw unavailable();
  const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX_JSON_BYTES + 1));
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(descriptor, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  const contents = buffer.subarray(0, length).toString("utf8");
  const after = fstatSync(descriptor);
  ensureNoSymlinkParents(path.dirname(filePath), { label: "ChatGPT routing state" });
  const leaf = lstatSync(filePath);
  if (Buffer.byteLength(contents) > MAX_JSON_BYTES || length !== opened.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || !leaf.isFile() || leaf.isSymbolicLink() || leaf.dev !== opened.dev || leaf.ino !== opened.ino) throw unavailable();
  return JSON.parse(contents);
}

function privateJson(filePath) {
  const opened = openPrivateJson(filePath);
  try {
    if (!privateFileIsProtected(filePath)) throw unavailable();
    return readOpenedJson(opened);
  } finally { closeSync(opened.descriptor); }
}

// Credentials are read only after a fresh batch ACL check. Descriptors remain
// open across the await, and replacements or mutations invalidate the read.
export async function readChatGPTPrivateJsonBatch(filePaths, { signal, verifyFiles = privateFilesAreProtectedAsync } = {}) {
  if (discoveryDisabled()) return new Map();
  signal?.throwIfAborted();
  const opened = [];
  const documents = new Map();
  try {
    for (const filePath of new Set(filePaths)) {
      if (discoveryDisabled()) return new Map();
      try { opened.push(openPrivateJson(filePath)); } catch { documents.set(filePath, undefined); }
    }
    if (discoveryDisabled()) return new Map();
    const protectedFiles = await verifyFiles(opened.map((file) => file.filePath), { signal });
    if (discoveryDisabled()) return new Map();
    signal?.throwIfAborted();
    if (!Array.isArray(protectedFiles) || protectedFiles.length !== opened.length || protectedFiles.some((value) => typeof value !== "boolean")) throw unavailable();
    for (const [index, file] of opened.entries()) {
      try { documents.set(file.filePath, protectedFiles[index] ? readOpenedJson(file) : undefined); } catch { documents.set(file.filePath, undefined); }
    }
    return documents;
  } finally { for (const file of opened) closeSync(file.descriptor); }
}

function emptyState() { return { version: 1, affinityVersion: 2, enabled: false, strategy: "round-robin", cursor: 0, sessions: {}, cooldowns: {}, allowUntrackedHistory: true }; }

export function readChatGPTAccountRouting(filePath = CHATGPT_ACCOUNT_ROUTING_PATH, { allowLegacyAffinity = false } = {}) {
  if (discoveryDisabled()) return emptyState();
  if (!existsSync(filePath)) return emptyState();
  return parseRoutingState(privateJson(filePath), { allowLegacyAffinity });
}

export async function readChatGPTAccountRoutingAsync(filePath = CHATGPT_ACCOUNT_ROUTING_PATH, options = {}) {
  if (discoveryDisabled() || !existsSync(filePath)) return emptyState();
  const documents = await readChatGPTPrivateJsonBatch([filePath], options);
  if (discoveryDisabled()) return emptyState();
  return parseRoutingState(documents.get(filePath), options);
}

function parseRoutingState(state, { allowLegacyAffinity = false } = {}) {
  if (state?.version !== 1 || typeof state.enabled !== "boolean" || !["round-robin", "fill-first"].includes(state.strategy) || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !state.sessions || typeof state.sessions !== "object" || Array.isArray(state.sessions) || !state.cooldowns || typeof state.cooldowns !== "object" || Array.isArray(state.cooldowns)) throw unavailable("The ChatGPT routing policy is invalid.");
  if (state.allowUntrackedHistory !== undefined && typeof state.allowUntrackedHistory !== "boolean") throw unavailable("The ChatGPT routing ownership reset flag is invalid.");
  const sessions = Object.entries(state.sessions);
  if (state.affinityVersion !== undefined && state.affinityVersion !== 2) throw unavailable("The ChatGPT routing affinity version is invalid.");
  if (state.affinityVersion === undefined && sessions.length && !allowLegacyAffinity) throw unavailable("Legacy ChatGPT routing ownership cannot be recovered safely. Close pooled conversations and run chatgpt-account-pool routing reset, then start new conversations.");
  if (!sessions.length) state.affinityVersion = 2;
  if (sessions.length > MAX_SESSIONS || sessions.some(([key, entry]) => !/^[a-f0-9]{64}$/.test(key) || (entry?.native === true ? entry.profileId !== undefined : entry?.native !== undefined || !canonicalAccountId(entry?.profileId)) || !/^[a-f0-9]{64}$/.test(entry?.identityHash) || (entry.rootKey !== undefined && !/^[a-f0-9]{64}$/.test(entry.rootKey)) || (entry.hasChildren !== undefined && typeof entry.hasChildren !== "boolean"))) throw unavailable("The ChatGPT routing affinity state is invalid.");
  if (Object.entries(state.cooldowns).some(([id, until]) => !canonicalAccountId(id) || !Number.isSafeInteger(until) || until < 0)) throw unavailable("The ChatGPT routing cooldown state is invalid.");
  return state;
}

export function chatGPTAccountRoutingSnapshot(filePath = CHATGPT_ACCOUNT_ROUTING_PATH) {
  const state = readChatGPTAccountRouting(filePath);
  return { enabled: state.enabled, strategy: state.strategy, sessions: { count: Object.keys(state.sessions).length }, cooldowns: { ...state.cooldowns } };
}

export async function setChatGPTAccountRouting(strategy, { filePath = CHATGPT_ACCOUNT_ROUTING_PATH } = {}) {
  if (discoveryDisabled()) throw unavailable("ChatGPT account routing requires credential discovery.");
  if (!["off", "round-robin", "fill-first", "reset"].includes(strategy)) throw new Error("Choose off, round-robin, fill-first, or reset.");
  ensureNoSymlinkParents(path.dirname(filePath));
  return withChatGPTAccountPoolLock(async () => {
    const state = readChatGPTAccountRouting(filePath, { allowLegacyAffinity: strategy === "reset" });
    if (strategy === "reset") {
      const directory = path.join(path.dirname(filePath), "chatgpt-routing-sessions");
      ensureNoSymlinkParents(directory);
      for (const name of existsSync(directory) ? readdirSync(directory) : []) {
        if (!/^[a-f0-9]{64}\.lock$/.test(name)) throw unavailable("The ChatGPT routing lease directory is invalid.");
        let release;
        try {
          release = await acquireFileLock(path.join(directory, name.slice(0, -5)), { realpath: false, stale: 600_000, retries: 0 });
        } catch { throw unavailable("Close active pooled turns before resetting account routing; crashed leases recover after ten minutes."); }
        await release();
      }
      state.sessions = {};
      state.affinityVersion = 2;
      state.allowUntrackedHistory = false;
    } else {
      state.enabled = strategy !== "off";
      if (state.enabled) state.strategy = strategy;
    }
    writePrivateJson(filePath, state, { directoryMode: 0o700 });
    return chatGPTAccountRoutingSnapshot(filePath);
  }, { filePath });
}

export function chatGPTAccountBoundHistory(payload, headers = {}) {
  if (payload?.previous_response_id || payload?.conversation || headers["x-oai-attestation"] || headers["x-codex-turn-state"]) return true;
  // Inspect the original body before native normalization removes references.
  const stack = [payload?.input, payload?.tools];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (value.encrypted_content || value.file_id || (Array.isArray(value.file_ids) && value.file_ids.length > 0) || value.vector_store_ids?.length || (typeof value.container_id === "string" && value.container_id.length > 0) || (typeof value.container === "string" && value.container !== "auto") || value.type === "item_reference" || value.type === "compaction" || value.type === "input_compaction" || (value.type === "reasoning" && value.id)) return true;
    stack.push(...Object.values(value).filter((item) => item && typeof item === "object"));
  }
  return false;
}

function credentialHome(account, homesDir, now) {
  const cooldownUntil = Date.parse(account.health?.cooldownUntil);
  if ((account.health?.state === "cooldown" && (!Number.isFinite(cooldownUntil) || cooldownUntil > now)) || account.state !== "active" || account.paused || !safeHeader(account.identity?.accountId) || ["reauth-required", "failed"].includes(account.health?.state)) return undefined;
  try {
    const home = chatGPTSubscriptionAccountHome(account.id, { homesDir });
    ensureNoSymlinkParents(home);
    // Existing lease inspection may clear stale records. Routing stays read-only
    // and excludes any lease until the account manager settles it.
    if (readdirSync(home).some((name) => name === "router-login-lease.json" || name.startsWith("router-login-lease.relocated-"))) return undefined;
    return home;
  } catch { return undefined; }
}

function credential(account, document, homesDir, now) {
  try {
    if (!credentialHome(account, homesDir, now)) return undefined;
    const tokens = document?.tokens;
    if (!safeHeader(tokens?.access_token, 64 * 1024) || !safeHeader(tokens?.account_id) || tokens.account_id !== account.identity.accountId) return undefined;
    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1] || "", "base64url").toString("utf8"));
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 120_000) return undefined;
    return { profileId: account.id, identityHash: hash(tokens.account_id), accountId: tokens.account_id, authorization: `Bearer ${tokens.access_token}` };
  } catch { return undefined; }
}

function liveProofRequired() {
  return unavailable("Pooled ChatGPT collaboration and encrypted agent-message relay are unavailable until live marker-return verification is completed. Disable account routing for native collaboration.");
}

const COLLABORATION_ENVELOPE = /Message Type:\s*(?:NEW_TASK|MESSAGE|FOLLOWUP_TASK|FINAL_ANSWER|TASK_COMPLETE)\b[\s\S]*\n(?:Payload:\s*$|(?:Sender|Recipient):)/i;

export function chatGPTAccountCollaboration(payload, headers = {}) {
  const metadata = payload?.client_metadata || {};
  if (headers["x-codex-parent-thread-id"] || headers["x-openai-subagent"] || metadata["x-codex-parent-thread-id"] || metadata["x-openai-subagent"]) return true;
  const stack = [payload?.tools, payload?.input];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (value.type === "agent_message" || ["collaboration", "agents"].includes(value.namespace) || (value.type === "namespace" && ["collaboration", "agents"].includes(value.name)) || /^(?:collaboration|agents)[._/]/.test(value.name || "") || /(?:^|[._/])(?:spawn_agent|wait_agent|interrupt_agent|send_input|resume_agent|close_agent|followup_task)$/.test(value.name || "")) return true;
    const text = Array.isArray(value.content)
      ? value.content.filter((part) => ["input_text", "text"].includes(part?.type) && typeof part.text === "string").map((part) => part.text).join("")
      : value.text;
    if (typeof text === "string" && COLLABORATION_ENVELOPE.test(text)) return true;
    stack.push(...Object.values(value).filter((item) => item && typeof item === "object"));
  }
  return false;
}

function sessionKey(headers, payload, parent = false, callerScope) {
  const session = headers["thread-id"] || payload?.client_metadata?.thread_id || headers.session_id || headers["session-id"] || payload?.client_metadata?.session_id || payload?.prompt_cache_key;
  // The private routing file already isolates the shared local installation.
  // A rotating authentication capability is not a durable caller identity.
  const scope = callerScope || "local-router";
  // A caller without a conversation key shares one affinity. This deliberately
  // sacrifices balancing rather than losing the owner of encrypted history.
  const parentId = headers["x-codex-parent-thread-id"];
  if (parent && !safeHeader(parentId, 1024)) return undefined;
  return hash(JSON.stringify([scope, parent ? parentId : safeHeader(session, 1024) ? session : "caller"]));
}

export async function createChatGPTAccountRoutingPlan({ headers, payload, signal, filePath = CHATGPT_ACCOUNT_ROUTING_PATH, poolPath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = () => Date.now(), callerScope } = {}) {
  if (discoveryDisabled()) return undefined;
  const initial = await readChatGPTAccountRoutingAsync(filePath, { signal });
  if (discoveryDisabled()) throw unavailable("ChatGPT account routing requires credential discovery.");
  const key = sessionKey(headers, payload, false, callerScope);
  const bound = chatGPTAccountBoundHistory(payload, headers);
  const initialAffinity = initial.sessions[key] || initial.sessions[sessionKey(headers, payload, true, callerScope)];
  if ((initial.enabled || (initialAffinity && !initialAffinity.native)) && (chatGPTAccountCollaboration(payload, headers) || initialAffinity?.hasChildren || initialAffinity?.rootKey)) throw liveProofRequired();
  if (!initial.enabled) {
    const native = async (state) => {
      const affinity = state.sessions[key] || state.sessions[sessionKey(headers, payload, true, callerScope)];
      if ((affinity && affinity.identityHash !== hash(headers["chatgpt-account-id"] || "")) || (bound && !affinity && state.allowUntrackedHistory === false)) {
        throw unavailable("This conversation belongs to a pooled ChatGPT account. Re-enable account routing or start a new conversation.");
      }
      if (!affinity && state.allowUntrackedHistory === false) {
        if (!safeHeader(headers["chatgpt-account-id"])) throw unavailable("A fresh native conversation requires its ChatGPT account identity after a routing reset.");
        if (Object.keys(state.sessions).length >= MAX_SESSIONS) throw unavailable("The ChatGPT routing affinity store is full.");
        // Record only the native identity, without opening a pool or auth file.
        // Re-enabling routing must recover this owner before selecting a profile.
        state.sessions[key] = { native: true, identityHash: hash(headers["chatgpt-account-id"]) };
        await writePrivateJsonAsync(filePath, state, { directoryMode: 0o700, signal });
      }
    };
    if (initial.allowUntrackedHistory !== false) return native(initial);
    return withChatGPTAccountPoolLock(async () => {
      const state = await readChatGPTAccountRoutingAsync(filePath, { signal });
      if (discoveryDisabled()) throw unavailable("ChatGPT account routing requires credential discovery.");
      if (state.enabled) throw unavailable("ChatGPT account routing changed during this turn; retry the request.");
      return native(state);
    }, { filePath, signal });
  }
  const lockDirectory = path.join(path.dirname(filePath), "chatgpt-routing-sessions");
  ensureNoSymlinkParents(lockDirectory);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  // Serialize the complete turn, including the stream, across router processes.
  // The short policy lock below is never held across network I/O.
  const release = await acquireFileLockWithSignal(path.join(lockDirectory, key), { realpath: false, stale: 600_000 }, { signal });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await release(); } };
  let current;
  const attempted = new Set();
  const select = async () => withChatGPTAccountPoolLock(async () => {
    signal?.throwIfAborted();
    const documents = await readChatGPTPrivateJsonBatch([filePath, poolPath], { signal });
    const state = parseRoutingState(documents.get(filePath));
    if (!state.enabled) throw unavailable("ChatGPT account routing was disabled during this turn; retry the request.");
    if (!documents.get(poolPath)) throw unavailable("The ChatGPT account pool is unavailable.");
    const pool = parseChatGPTAccountPoolState(documents.get(poolPath));
    if (!pool.policy.enabled) throw unavailable("The ChatGPT account pool is disabled.");
    const affinity = state.sessions[key];
    if (affinity?.hasChildren || affinity?.rootKey || chatGPTAccountCollaboration(payload, headers)) throw liveProofRequired();
    const entries = Object.values(pool.accounts).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const identities = new Set();
    const homes = new Map(entries.map((account) => [account.id, credentialHome(account, homesDir, now())]));
    const auth = await readChatGPTPrivateJsonBatch([...homes.values()].filter(Boolean).map((home) => path.join(home, "auth.json")), { signal });
    const candidates = entries.map((account) => credential(account, auth.get(path.join(homes.get(account.id) || "", "auth.json")), homesDir, now())).filter((entry) => {
      if (!entry || identities.has(entry.identityHash)) return false;
      identities.add(entry.identityHash);
      return !attempted.has(entry.profileId) && !(state.cooldowns[entry.profileId] > now());
    });
    let selected = affinity && candidates.find((entry) => (affinity.native === true || entry.profileId === affinity.profileId) && entry.identityHash === affinity.identityHash);
    if (bound && !selected) {
      // Unknown opaque history can only belong to the account presented by the
      // original caller. Never guess another profile or drop encrypted history.
      if (!affinity && state.allowUntrackedHistory !== false) selected = candidates.find((entry) => entry.accountId === headers["chatgpt-account-id"]);
      if (!selected) throw unavailable("This conversation has account-bound history and its original ChatGPT account is unavailable. Start a new conversation with an available account.");
    }
    if (!selected) selected = candidates[state.strategy === "fill-first" ? 0 : state.cursor % candidates.length];
    if (!selected) throw unavailable();
    const requiredSlots = Number(!affinity);
    if (Object.keys(state.sessions).length + requiredSlots > MAX_SESSIONS) throw unavailable("The ChatGPT routing affinity store is full.");
    if (!affinity || selected.profileId !== affinity.profileId) state.cursor = (state.cursor + 1) % 1_000_000_000;
    state.sessions[key] = { profileId: selected.profileId, identityHash: selected.identityHash };
    await writePrivateJsonAsync(filePath, state, { directoryMode: 0o700, signal });
    current = selected;
    attempted.add(selected.profileId);
    return selected;
  }, { filePath, signal });
  try {
    signal?.throwIfAborted();
    await select();
    return {
      get profileId() { return current.profileId; },
      get headers() { return { authorization: current.authorization, "chatgpt-account-id": current.accountId }; },
      get portable() { return !bound; },
      close,
      async quota(until) {
        await withChatGPTAccountPoolLock(async () => {
          const state = await readChatGPTAccountRoutingAsync(filePath, { signal });
          if (discoveryDisabled()) throw unavailable("ChatGPT account routing requires credential discovery.");
          state.cooldowns[current.profileId] = Math.max(state.cooldowns[current.profileId] || 0, until);
          await writePrivateJsonAsync(filePath, state, { directoryMode: 0o700, signal });
        }, { filePath, signal });
      },
      next: select,
    };
  } catch (error) { return runWithLockRelease(() => { throw error; }, close); }
}

export function chatGPTQuotaCooldown(response, text, now = Date.now()) {
  if (response.status !== 429 && response.status !== 402) return undefined;
  let error;
  try { error = JSON.parse(text)?.error; } catch { return undefined; }
  if (!QUOTA_CODES.has(error?.code) && !QUOTA_CODES.has(error?.type)) return undefined;
  const reset = Number(error.resets_at) * 1000;
  const retry = response.headers.get("retry-after");
  const retryAt = retry && /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry || "");
  const times = [reset, retryAt].filter((value) => Number.isSafeInteger(value) && value > now && value <= now + 30 * 24 * 3600_000);
  return times.length ? Math.max(...times) : now + DEFAULT_COOLDOWN_MS;
}

// Only an explicit HTTP quota refusal permits switching accounts. Preserve the
// bounded same-account transport retries before any response is relayed.
export async function fetchWithChatGPTAccountRouting(plan, url, init = {}, {
  retries = NATIVE_RETRY_LIMIT,
  budgetMs = NATIVE_RETRY_BUDGET_MS,
  signal = init.signal,
  canRetry = () => true,
  now = () => Date.now(),
  expectEventStream = false,
  ...retryOptions
} = {}) {
  const startedAt = now();
  let transportRetries = 0;
  let hops = 0;
  while (true) {
    signal?.throwIfAborted();
    const { response, retries: accountRetries } = await fetchWithRetry(url, { ...init, signal, headers: { ...init.headers, ...plan.headers } }, {
      ...retryOptions, signal, canRetry, now,
      // The transport helper restarts its counter for each account; usage and
      // failure paths need a monotonic attempt number for the entire turn.
      onAttempt: (event) => retryOptions.onAttempt?.({ ...event, attempt: hops + transportRetries + event.attempt }),
      retries: Math.max(0, retries - transportRetries),
      budgetMs: Math.max(0, budgetMs - (now() - startedAt)),
    });
    transportRetries += accountRetries;
    if (signal?.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    if (![402, 429].includes(response.status) || !response.body) return { response: observeQuotaStream(response, plan, now, signal, expectEventStream), retries: hops + transportRetries };
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let done = false;
    // Bound inspection, then reconstruct the body exactly for the caller. A
    // large/streaming refusal is not evidence for quota switching.
    while (size <= 64 * 1024 && !done) {
      const part = await reader.read();
      done = part.done;
      if (part.value) { chunks.push(part.value); size += part.value.byteLength; }
    }
    const bytes = Buffer.concat(chunks.map((part) => Buffer.from(part)));
    const until = done && size <= 64 * 1024 ? chatGPTQuotaCooldown(response, bytes.toString("utf8"), now()) : undefined;
    const restored = new Response(new ReadableStream({
      start(controller) {
        if (bytes.length) controller.enqueue(bytes);
        if (done) { controller.close(); reader.releaseLock(); }
      },
      async pull(controller) {
        const part = await reader.read();
        if (part.done) { controller.close(); reader.releaseLock(); } else controller.enqueue(part.value);
      },
      async cancel(reason) { if (!done) { await reader.cancel(reason); reader.releaseLock(); } },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
    if (!until) return { response: restored, retries: hops + transportRetries };
    await plan.quota(until);
    if (signal?.aborted) { await restored.body.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (!plan.portable || !canRetry()) return { response: restored, retries: hops + transportRetries };
    try { await plan.next(); } catch (error) {
      if (signal?.aborted) { await restored.body.cancel().catch(() => {}); signal.throwIfAborted(); }
      // Preserve the last upstream refusal when every candidate is unavailable.
      return { response: restored, retries: hops + transportRetries };
    }
    await restored.body.cancel();
    hops += 1;
  }
}

// A semantic SSE refusal can arrive after HTTP 200 or partial output. Record
// the cooldown for subsequent turns, but never replay an accepted stream.
function observeQuotaStream(response, plan, now, signal, expectEventStream) {
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  // Match the native router's missing-type SSE contract only for successful,
  // explicitly streaming turns. Never reinterpret JSON or an HTTP refusal.
  if (!response.body || !(mediaType === "text/event-stream" || (!contentType && expectEventStream && response.ok))) return response;
  const decoder = new TextDecoder();
  let pending = "";
  let marked = false;
  return new Response(response.body.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      controller.enqueue(chunk);
      if (marked) return;
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      if (pending.length > 64 * 1024) pending = "";
      for (const line of lines) {
        if (!line.startsWith("data:") || line.length > 64 * 1024) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); }
        catch { continue; } // Non-JSON data and incomplete events are not quota evidence.
        if (!["response.failed", "error"].includes(event?.type)) continue;
        const error = event.response?.error || event.error || event;
        const until = chatGPTQuotaCooldown({ status: 429, headers: response.headers }, JSON.stringify({ error }), now());
        if (until) {
          // Persistence and cancellation failures must reach the stream caller.
          await plan.quota(until);
          signal?.throwIfAborted();
          marked = true;
          break;
        }
      }
    },
  })), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// This helper is called only for native encrypted agent messages. Check policy
// before relay/cache access, without reading any pooled profile credentials.
export async function knownChatGPTAccountRoutingHeaders({ headers, payload, signal, filePath = CHATGPT_ACCOUNT_ROUTING_PATH, callerScope } = {}) {
  if (discoveryDisabled()) return undefined;
  const state = await readChatGPTAccountRoutingAsync(filePath, { signal });
  if (discoveryDisabled()) throw unavailable("ChatGPT account routing requires credential discovery.");
  const key = sessionKey(headers, payload, false, callerScope);
  const parentKey = sessionKey(headers, payload, true, callerScope);
  const affinity = state.sessions[key] || (parentKey && state.sessions[parentKey]);
  if (state.enabled || (affinity && !affinity.native)) throw liveProofRequired();
  if (affinity?.native && affinity.identityHash === hash(headers["chatgpt-account-id"] || "")) return undefined;
  if (state.allowUntrackedHistory === false) throw unavailable("The account owning this encrypted history is unknown. Start a new conversation.");
  return undefined;
}
