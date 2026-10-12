import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

import { readChatGPTAccountPoolState, chatGPTSubscriptionAccountHome, isChatGPTAccountId, withChatGPTAccountPoolLock } from "./chatgpt-account-pool.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { acquireFileLock } from "./file-lock.mjs";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import { CHATGPT_ACCOUNT_POOL_PATH, CHATGPT_ACCOUNT_HOMES_DIR, STATE_DIR } from "./paths.mjs";

export const CHATGPT_ACCOUNT_ROUTING_PATH = process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_ROUTING || path.join(STATE_DIR, "chatgpt-account-routing.json");
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 4096;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const QUOTA_CODES = new Set(["usage_limit_reached", "insufficient_quota", "workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const safeHeader = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function unavailable(message = "No eligible ChatGPT account is available for this request.") {
  const error = new Error(message);
  error.status = 503;
  error.code = "chatgpt_account_routing_unavailable";
  return error;
}

// Never harden or refresh credentials from the request path. A login writer's
// lease (including unfinished finalization) excludes the entire profile.
function privateJson(filePath) {
  ensureNoSymlinkParents(path.dirname(filePath), { label: "ChatGPT routing state" });
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JSON_BYTES || !privateFileIsProtected(filePath)) throw unavailable();
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_JSON_BYTES || (process.platform !== "win32" && ((opened.mode & 0o777) !== 0o600 || opened.uid !== process.getuid()))) throw unavailable();
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
    if (Buffer.byteLength(contents) > MAX_JSON_BYTES || length !== opened.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || leaf.dev !== opened.dev || leaf.ino !== opened.ino) throw unavailable();
    return JSON.parse(contents);
  } finally {
    closeSync(descriptor);
  }
}

function emptyState() { return { version: 1, enabled: false, strategy: "round-robin", cursor: 0, sessions: {}, cooldowns: {}, allowUntrackedHistory: true }; }

export function readChatGPTAccountRouting(filePath = CHATGPT_ACCOUNT_ROUTING_PATH) {
  if (discoveryDisabled()) return emptyState();
  if (!existsSync(filePath)) return emptyState();
  const state = privateJson(filePath);
  if (state?.version !== 1 || typeof state.enabled !== "boolean" || !["round-robin", "fill-first"].includes(state.strategy) || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !state.sessions || typeof state.sessions !== "object" || Array.isArray(state.sessions) || !state.cooldowns || typeof state.cooldowns !== "object" || Array.isArray(state.cooldowns)) throw unavailable("The ChatGPT routing policy is invalid.");
  const sessions = Object.entries(state.sessions);
  if (sessions.length > MAX_SESSIONS || sessions.some(([key, entry]) => !/^[a-f0-9]{64}$/.test(key) || !isChatGPTAccountId(entry?.profileId) || !/^[a-f0-9]{64}$/.test(entry?.identityHash) || (entry.rootKey !== undefined && !/^[a-f0-9]{64}$/.test(entry.rootKey)) || (entry.hasChildren !== undefined && typeof entry.hasChildren !== "boolean"))) throw unavailable("The ChatGPT routing affinity state is invalid.");
  if (Object.entries(state.cooldowns).some(([id, until]) => !isChatGPTAccountId(id) || !Number.isSafeInteger(until) || until < 0)) throw unavailable("The ChatGPT routing cooldown state is invalid.");
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
    const state = readChatGPTAccountRouting(filePath);
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
  if (payload?.previous_response_id || payload?.conversation || headers["x-oai-attestation"]) return true;
  // Inspect the original body before native normalization removes references.
  const stack = [payload?.input, payload?.tools];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (value.encrypted_content || value.file_id || value.vector_store_ids?.length || (typeof value.container === "string" && value.container !== "auto") || value.type === "item_reference" || value.type === "compaction" || value.type === "input_compaction" || (value.type === "reasoning" && value.id)) return true;
    stack.push(...Object.values(value).filter((item) => item && typeof item === "object"));
  }
  return false;
}

function credential(account, homesDir, now) {
  if ((account.health?.state === "cooldown" && Date.parse(account.health.cooldownUntil) > now) || account.state !== "active" || account.paused || !safeHeader(account.identity?.accountId) || ["reauth-required", "failed"].includes(account.health?.state)) return undefined;
  try {
    const home = chatGPTSubscriptionAccountHome(account.id, { homesDir });
    ensureNoSymlinkParents(home);
    // Existing lease inspection may clear stale records. Routing stays read-only
    // and excludes any lease until the account manager settles it.
    if (readdirSync(home).some((name) => name === "router-login-lease.json" || name.startsWith("router-login-lease.relocated-"))) return undefined;
    const tokens = privateJson(path.join(home, "auth.json"))?.tokens;
    if (!safeHeader(tokens?.access_token, 64 * 1024) || !safeHeader(tokens?.account_id) || tokens.account_id !== account.identity.accountId) return undefined;
    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1] || "", "base64url").toString("utf8"));
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 120_000) return undefined;
    return { profileId: account.id, identityHash: hash(tokens.account_id), accountId: tokens.account_id, authorization: `Bearer ${tokens.access_token}` };
  } catch { return undefined; }
}

function sessionKey(headers, payload, parent = false, callerScope) {
  const session = headers["thread-id"] || payload?.client_metadata?.thread_id || headers.session_id || headers["session-id"] || payload?.client_metadata?.session_id || payload?.prompt_cache_key;
  const scope = callerScope || headers.authorization || "local-caller";
  // A caller without a conversation key shares one affinity. This deliberately
  // sacrifices balancing rather than losing the owner of encrypted history.
  const parentId = headers["x-codex-parent-thread-id"];
  if (parent && !safeHeader(parentId, 1024)) return undefined;
  return hash(JSON.stringify([scope, parent ? parentId : safeHeader(session, 1024) ? session : "caller"]));
}

export async function createChatGPTAccountRoutingPlan({ headers, payload, signal, filePath = CHATGPT_ACCOUNT_ROUTING_PATH, poolPath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = () => Date.now(), callerScope } = {}) {
  if (discoveryDisabled()) return undefined;
  const initial = readChatGPTAccountRouting(filePath);
  const key = sessionKey(headers, payload, false, callerScope);
  const bound = chatGPTAccountBoundHistory(payload, headers);
  if (!initial.enabled) {
    const affinity = initial.sessions[key] || initial.sessions[sessionKey(headers, payload, true, callerScope)];
    if ((affinity && affinity.identityHash !== hash(headers["chatgpt-account-id"] || "")) || (bound && !affinity && initial.allowUntrackedHistory === false)) {
      throw unavailable("This conversation belongs to a pooled ChatGPT account. Re-enable account routing or start a new conversation.");
    }
    return undefined;
  }
  const lockDirectory = path.join(path.dirname(filePath), "chatgpt-routing-sessions");
  ensureNoSymlinkParents(lockDirectory);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  // Serialize the complete turn, including the stream, across router processes.
  // The short policy lock below is never held across network I/O.
  const release = await acquireFileLock(path.join(lockDirectory, key), { realpath: false, stale: 600_000, retries: { retries: 1200, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await release(); } };
  let current;
  let treeBound = false;
  const attempted = new Set();
  const select = async () => withChatGPTAccountPoolLock(() => {
    signal?.throwIfAborted();
    const state = readChatGPTAccountRouting(filePath);
    if (!state.enabled) throw unavailable("ChatGPT account routing was disabled during this turn; retry the request.");
    if (existsSync(poolPath)) privateJson(poolPath);
    const pool = readChatGPTAccountPoolState(poolPath);
    if (!pool.policy.enabled) throw unavailable("The ChatGPT account pool is disabled.");
    const entries = Object.values(pool.accounts).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const identities = new Set();
    const candidates = entries.map((account) => credential(account, homesDir, now())).filter((entry) => {
      if (!entry || identities.has(entry.identityHash)) return false;
      identities.add(entry.identityHash);
      return !attempted.has(entry.profileId) && !(state.cooldowns[entry.profileId] > now());
    });
    const own = state.sessions[key];
    const parentKey = sessionKey(headers, payload, true, callerScope);
    const parent = parentKey && state.sessions[parentKey];
    const missingParent = parentKey && !parent;
    const rootKey = own?.rootKey || parent?.rootKey || parentKey || key;
    const root = state.sessions[rootKey];
    const affinity = own || parent;
    treeBound = Boolean(parentKey || root?.hasChildren || own?.rootKey);
    let selected = affinity && candidates.find((entry) => entry.profileId === affinity.profileId && entry.identityHash === affinity.identityHash);
    if (missingParent) {
      if (own && own.identityHash !== hash(headers["chatgpt-account-id"] || "")) throw unavailable("This collaboration thread cannot be rebound to an unknown parent account.");
      selected = candidates.find((entry) => entry.accountId === headers["chatgpt-account-id"]);
    }
    if ((bound || treeBound) && !selected) {
      // Unknown opaque history can only belong to the account presented by the
      // original caller. Never guess another profile or drop encrypted history.
      if (!affinity && state.allowUntrackedHistory !== false) selected = candidates.find((entry) => entry.accountId === headers["chatgpt-account-id"]);
      if (!selected) throw unavailable("This conversation has account-bound history and its original ChatGPT account is unavailable. Start a new conversation with an available account.");
    }
    if (!selected) selected = candidates[state.strategy === "fill-first" ? 0 : state.cursor % candidates.length];
    if (!selected) throw unavailable();
    const requiredSlots = Number(!own) + Number(Boolean(missingParent));
    if (Object.keys(state.sessions).length + requiredSlots > MAX_SESSIONS) throw unavailable("The ChatGPT routing affinity store is full.");
    if (!affinity || selected.profileId !== affinity.profileId) state.cursor = (state.cursor + 1) % 1_000_000_000;
    state.sessions[key] = { profileId: selected.profileId, identityHash: selected.identityHash, ...(treeBound ? { rootKey } : {}), ...(own?.hasChildren ? { hasChildren: true } : {}) };
    if (missingParent) state.sessions[parentKey] = { profileId: selected.profileId, identityHash: selected.identityHash, hasChildren: true };
    if (parentKey) state.sessions[rootKey].hasChildren = true;
    writePrivateJson(filePath, state, { directoryMode: 0o700 });
    current = selected;
    attempted.add(selected.profileId);
    return selected;
  }, { filePath });
  try {
    signal?.throwIfAborted();
    await select();
    return {
      get profileId() { return current.profileId; },
      get headers() { return { authorization: current.authorization, "chatgpt-account-id": current.accountId }; },
      get portable() { return !bound && !treeBound; },
      close,
      async quota(until) {
        await withChatGPTAccountPoolLock(() => {
          const state = readChatGPTAccountRouting(filePath);
          state.cooldowns[current.profileId] = Math.max(state.cooldowns[current.profileId] || 0, until);
          writePrivateJson(filePath, state, { directoryMode: 0o700 });
        }, { filePath });
      },
      next: select,
    };
  } catch (error) { await close(); throw error; }
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

// Only an explicit HTTP quota refusal permits another attempt. Success streams,
// ordinary 429s, auth errors, and network errors are never replayed here.
export async function fetchWithChatGPTAccountRouting(plan, url, init, { fetchImpl, canRetry = () => true, now = () => Date.now() } = {}) {
  let hops = 0;
  while (true) {
    init.signal?.throwIfAborted();
    const response = await fetchImpl(url, { ...init, headers: { ...init.headers, ...plan.headers } });
    if (init.signal?.aborted) { await response.body?.cancel(); init.signal.throwIfAborted(); }
    if (![402, 429].includes(response.status) || !response.body) return { response: observeQuotaStream(response, plan, now), retries: hops };
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
    if (!until) return { response: restored, retries: hops };
    await plan.quota(until);
    if (!plan.portable || !canRetry() || init.signal?.aborted) return { response: restored, retries: hops };
    try { await plan.next(); } catch (error) {
      if (init.signal?.aborted) { await restored.body.cancel(); throw error; }
      // Preserve the last upstream refusal when every candidate is unavailable.
      return { response: restored, retries: hops };
    }
    await restored.body.cancel();
    hops += 1;
  }
}

// A semantic SSE refusal can arrive after HTTP 200 or partial output. Record
// the cooldown for subsequent turns, but never replay an accepted stream.
function observeQuotaStream(response, plan, now) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
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
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (!["response.failed", "error"].includes(event.type)) continue;
          const error = event.response?.error || event.error || event;
          const until = chatGPTQuotaCooldown({ status: 429, headers: response.headers }, JSON.stringify({ error }), now());
          if (until) { marked = true; await plan.quota(until); break; }
        } catch { /* Non-JSON data and incomplete events are not quota evidence. */ }
      }
    },
  })), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// Routed agent-message decryption is fixed to the known native owner, never a
// new balanced choice. The returned values exist only in the process.
export async function knownChatGPTAccountRoutingHeaders({ headers, payload, filePath = CHATGPT_ACCOUNT_ROUTING_PATH, poolPath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now(), callerScope } = {}) {
  if (discoveryDisabled()) return undefined;
  const initial = readChatGPTAccountRouting(filePath);
  if (!initial.enabled && !Object.keys(initial.sessions).length && initial.allowUntrackedHistory !== false) return undefined;
  return withChatGPTAccountPoolLock(() => {
    const state = readChatGPTAccountRouting(filePath);
    const key = sessionKey(headers, payload, false, callerScope);
    const parentKey = sessionKey(headers, payload, true, callerScope);
    const affinity = state.sessions[key] || (parentKey && state.sessions[parentKey]);
    if (!affinity) {
      if (state.allowUntrackedHistory === false) throw unavailable("The account owning this encrypted history is unknown. Start a new conversation.");
      return undefined;
    }
    if (!state.enabled) throw unavailable("Re-enable ChatGPT account routing to use this conversation's encrypted history.");
    if (existsSync(poolPath)) privateJson(poolPath);
    const pool = readChatGPTAccountPoolState(poolPath);
    if (!pool.policy.enabled) throw unavailable("The ChatGPT account pool is disabled.");
    const account = pool.accounts[affinity.profileId];
    const owner = account && credential(account, homesDir, now);
    if (!owner || owner.identityHash !== affinity.identityHash || state.cooldowns[owner.profileId] > now) throw unavailable("The ChatGPT account owning this encrypted history is unavailable.");
    const rootKey = affinity.rootKey || (state.sessions[key] ? key : parentKey);
    if (!state.sessions[key]) {
      if (Object.keys(state.sessions).length >= MAX_SESSIONS) throw unavailable("The ChatGPT routing affinity store is full.");
      state.sessions[key] = { profileId: owner.profileId, identityHash: owner.identityHash, rootKey };
    }
    if (state.sessions[rootKey]) state.sessions[rootKey].hasChildren = true;
    writePrivateJson(filePath, state, { directoryMode: 0o700 });
    return { authorization: owner.authorization, "chatgpt-account-id": owner.accountId };
  }, { filePath });
}
