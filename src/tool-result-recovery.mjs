import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateFileAsync } from "./file-security.mjs";
import { acquireFileLock, runWithLockRelease } from "./file-lock.mjs";
import { ageToolResults } from "./tool-result-aging.mjs";
import {
  TOOL_RESULT_RETENTION_DIR, RETENTION_MAX_FILES, RETENTION_MAX_TOTAL_BYTES,
  expireRetainedToolResults, retainedToolResultsUsage,
} from "./tool-result-retention.mjs";
import { retentionTtlMs } from "./tool-result-aging-state.mjs";
import { SOURCE_ROOT } from "./paths.mjs";

const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const PROOF_TTL_MS = 30 * 60_000;
const PENDING = "[Router archive readback pending]";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function failure(code) {
  const error = new Error(`Retained tool result ${code}. Do not rerun the original tool to reconstruct it.`);
  error.code = code;
  return error;
}

function storeRoot(directory, create = false) {
  const root = path.resolve(directory);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("unsafe_store");
  return root;
}

function readRegular(file, maxBytes) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw failure("unsafe_file");
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes ||
        stat.ino !== before.ino || stat.dev !== before.dev) throw failure("unsafe_file");
    return { text: readFileSync(fd, "utf8"), stat };
  } finally {
    closeSync(fd);
  }
}

function identity(key, record) {
  return createHmac("sha256", key)
    .update(JSON.stringify([record.scope, record.callId, record.sha256])).digest("base64url");
}

function signProof(key, body) {
  return createHmac("sha256", key).update(`readback:${body}`).digest("base64url");
}

function readbackProof(key, scope, now) {
  const body = Buffer.from(JSON.stringify({ scope, expiresAt: now + PROOF_TTL_MS })).toString("base64url");
  return `${body}.${signProof(key, body)}`;
}

// A shell declaration does not establish filesystem access: a Codex restricted
// token may be unable to read owner-private files. Accept only a signed proof
// returned by a successful reader call in this conversation/permission context.
function* readbackTexts(value, depth = 0) {
  if (depth > 8) return;
  if (typeof value === "string") {
    yield value;
    // Desktop batched tools wrap exec output in JSON strings. Decode only
    // bounded, complete JSON envelopes; signatures and scope are still
    // checked below. Large/unknown formats simply keep the original text.
    if (value.length <= 64 * 1024 && Buffer.byteLength(value, "utf8") <= 64 * 1024) {
      try { yield* readbackTexts(JSON.parse(value), depth + 1); } catch { /* plain text */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) yield* readbackTexts(item, depth + 1);
  } else if (value && typeof value === "object") {
    for (const key of ["text", "output", "content", "value"]) {
      if (Object.hasOwn(value, key)) yield* readbackTexts(value[key], depth + 1);
    }
  }
}

export function hasVerifiedToolResultReadback(input, scope, { directory, now = Date.now() } = {}) {
  try {
    const key = readRegular(path.join(storeRoot(directory), ".retention-key"), 128).text;
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (!["function_call_output", "custom_tool_call_output"].includes(item?.type)) continue;
      for (const text of readbackTexts(item.output)) {
        for (const match of text.matchAll(/"readbackProof"\s*:\s*"([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})"/gu)) {
          const expected = Buffer.from(signProof(key, match[1]));
          const signature = Buffer.from(match[2]);
          if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) continue;
          const proof = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
          if (proof.scope === sha256(String(scope)) && Number.isSafeInteger(proof.expiresAt) &&
              proof.expiresAt > now && proof.expiresAt <= now + PROOF_TTL_MS) return true;
        }
      }
    }
  } catch { /* Missing/inaccessible proof is no permission to omit text. */ }
  return false;
}

export function toolResultRecoveryScope(threadId, payload) {
  const policy = (Array.isArray(payload.input) ? payload.input : [])
    .filter(item => ["developer", "system"].includes(item?.role));
  return JSON.stringify([String(threadId || ""), sha256(JSON.stringify([payload.instructions, policy, payload.tool_choice]))]);
}

// Responses Lite omits top-level tools and declares them in developer-role
// `additional_tools` input items instead. An explicit top-level list, even an
// empty one, still wins; tool_choice restrictions apply to either inventory.
function declaredTools(payload) {
  if (payload.tools !== undefined || !Array.isArray(payload.input)) return payload.tools;
  const declared = payload.input.filter(item => item?.type === "additional_tools" &&
    item.role === "developer" && Array.isArray(item.tools));
  return declared.length ? declared.flatMap(item => item.tools) : undefined;
}

export function toolResultReadbackTools(payload) {
  return payload.tool_choice === undefined || ["auto", "required"].includes(payload.tool_choice)
    ? declaredTools(payload) : [];
}

// Harden an EMPTY file first: no output bytes ever inhabit an inherited Windows
// ACL while the asynchronous ACL helper is starting. Publish only after fsync.
async function commit(file, text, writeEmpty = writePrivateFileAsync) {
  const stage = path.join(path.dirname(file), `.${path.basename(file)}.stage.${randomBytes(16).toString("hex")}`);
  let fd;
  try {
    await writeEmpty(stage, "", { directoryMode: 0o700 });
    fd = openSync(stage, constants.O_WRONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) throw failure("unsafe_file");
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(stage, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(stage); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** Immutable snapshots of the exact text received by Router, not a command's
 * possibly larger, already truncated stdout. Handles are install-keyed and
 * scoped to a conversation/call, never bare content hashes or arbitrary paths.
 */
export async function retainToolResult(text, {
  directory = TOOL_RESULT_RETENTION_DIR, scope = "", callId = "",
  ttlMs = retentionTtlMs(), now = Date.now(), maxFiles = RETENTION_MAX_FILES,
  maxBytes = RETENTION_MAX_TOTAL_BYTES, writeEmpty,
} = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_RESULT_BYTES ||
      Buffer.from(text, "utf8").toString("utf8") !== text) return undefined;
  const root = storeRoot(directory, true);
  // No waiting on request traffic: contention leaves the original in context.
  // The heartbeat covers ACL helpers; leases are shared across CLI/processes.
  let compromised = false;
  const release = await acquireFileLock(root, {
    realpath: false, lockfilePath: `${root}.lock`, retries: 0, stale: 120_000,
    onCompromised() { compromised = true; },
  });
  return runWithLockRelease(async () => {
    const write = async (...args) => {
      if (compromised) throw failure("store_locked");
      await (writeEmpty || writePrivateFileAsync)(...args);
      if (compromised) throw failure("store_locked");
    };
    const keyPath = path.join(root, ".retention-key");
    let key;
    try { key = readRegular(keyPath, 128).text; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      key = randomBytes(32).toString("hex");
      await commit(keyPath, key, write);
    }
    if (!/^[0-9a-f]{64}$/u.test(key)) throw failure("invalid_key");
    const record = { version: 1, scope: sha256(String(scope)), callId: String(callId), sha256: sha256(text), text };
    const handle = identity(key, record);
    const file = path.join(root, `${handle}.result`);
    try {
      const existing = readRegular(file, MAX_RESULT_BYTES * 6 + 4096);
      const saved = JSON.parse(existing.text);
      if (saved.version !== 1 || saved.text !== text || identity(key, saved) !== handle) throw failure("corrupt");
      // Exact content is immutable. Only its lease is renewed on history replay.
      utimesSync(file, new Date(now), new Date(now));
      return { handle, sha256: record.sha256, directory: root };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    expireRetainedToolResults({ directory: root, ttlMs, now });
    const usage = retainedToolResultsUsage({ directory: root });
    const serialized = JSON.stringify(record);
    if (usage.results >= maxFiles || usage.bytes + Buffer.byteLength(serialized) > maxBytes) return undefined;
    await commit(file, serialized, write);
    utimesSync(file, new Date(now), new Date(now));
    return { handle, sha256: record.sha256, directory: root };
  }, release);
}

export function readRetainedToolResult(handle, {
  directory = TOOL_RESULT_RETENTION_DIR, ttlMs = retentionTtlMs(), now = Date.now(),
  offset = 0, limit = 2000, find,
} = {}) {
  if (!HANDLE.test(handle)) throw failure("invalid_handle");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16_000) {
    throw failure("invalid_range");
  }
  let root, saved, key;
  try {
    root = storeRoot(directory);
    saved = readRegular(path.join(root, `${handle}.result`), MAX_RESULT_BYTES * 6 + 4096);
    key = readRegular(path.join(root, ".retention-key"), 128).text;
  } catch (error) {
    if (error.code === "ENOENT") throw failure("missing_or_expired");
    throw error;
  }
  if (ttlMs > 0 && now - saved.stat.mtimeMs > ttlMs) throw failure("expired");
  let record;
  try { record = JSON.parse(saved.text); } catch { throw failure("corrupt"); }
  if (record.version !== 1 || typeof record.text !== "string" ||
      sha256(record.text) !== record.sha256 || identity(key, record) !== handle) throw failure("corrupt");
  if (find !== undefined) {
    if (typeof find !== "string" || !find || find.length > 2000) throw failure("invalid_search");
    const found = record.text.indexOf(find, offset);
    if (found < 0) return { handle, sha256: record.sha256,
      readbackProof: readbackProof(key, record.scope, now), found: false };
    offset = Math.max(offset, found - 128);
    if (/[\uDC00-\uDFFF]/u.test(record.text[offset] || "")) offset -= 1;
  }
  if (offset > record.text.length || /[\uDC00-\uDFFF]/u.test(record.text[offset] || "")) throw failure("invalid_range");
  let end = Math.min(record.text.length, offset + limit);
  if (end < record.text.length && /[\uD800-\uDBFF]/u.test(record.text[end - 1])) end -= 1;
  if (end === offset && end < record.text.length) end += 2;
  return {
    handle, sha256: record.sha256, readbackProof: readbackProof(key, record.scope, now),
    bytes: Buffer.byteLength(record.text),
    offset, nextOffset: end, eof: end === record.text.length,
    text: record.text.slice(offset, end),
  };
}

// Explicit purge/expiry must not remove the install key between snapshot key
// creation and publication. Read-only previews need no lease and create no store.
export async function withRetainedToolResultsLock(operation, { directory = TOOL_RESULT_RETENTION_DIR } = {}) {
  let root;
  try { root = storeRoot(directory); }
  catch (error) { if (error.code === "ENOENT") return operation(); throw error; }
  const release = await acquireFileLock(root, {
    realpath: false, lockfilePath: `${root}.lock`, retries: 0, stale: 120_000,
  });
  return runWithLockRelease(operation, release);
}

export function searchRetainedToolResults(handle, {
  directory = TOOL_RESULT_RETENTION_DIR, ttlMs = retentionTtlMs(), now = Date.now(),
  find, limit = 2000, cursor = 0, index,
} = {}) {
  if (typeof find !== "string" || !find || find.length > 2000) throw failure("invalid_search");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16000 ||
      !Number.isSafeInteger(cursor) || cursor < 0) throw failure("invalid_range");
  const root = storeRoot(directory);
  // Reuse the existing authenticated reader for the reference and every
  // candidate. A reference handle grants lookup only in its own signed scope.
  const reference = readRetainedToolResult(handle, {directory: root, ttlMs, now, limit: 1});
  const proofScope = result => JSON.parse(Buffer.from(result.readbackProof.split(".")[0], "base64url").toString("utf8")).scope;
  const scope = proofScope(reference);
  const files = readdirSync(root).filter(name => /^[A-Za-z0-9_-]{43}\.result$/u.test(name)).sort();
  const fingerprint = sha256(JSON.stringify(files));
  if (cursor > files.length || (cursor > 0 && index !== fingerprint) ||
      (index !== undefined && index !== fingerprint)) throw failure("search_changed");
  const matches = [];
  let bytes = 0, characters = 0, searched = 0, unavailable = 0, position = cursor;
  const started = Date.now();
  for (; position < files.length; position += 1) {
    if (position > cursor && (bytes >= 16 * 1024 * 1024 || Date.now() - started > 1000 ||
        characters >= limit || matches.length >= 32)) break;
    const candidate = files[position].slice(0, -7);
    let result;
    try {
      bytes += lstatSync(path.join(root, files[position])).size;
      result = readRetainedToolResult(candidate, {directory: root, ttlMs, now, find,
        limit: Math.max(1, limit - characters)});
    } catch {
      // Unknown/corrupt/expired entries cannot establish absence. Do not leak
      // their handles or contents; report an incomplete search instead.
      unavailable += 1;
      continue;
    }
    if (proofScope(result) !== scope) continue;
    searched += 1;
    if (result.found === false) continue;
    characters += result.text.length;
    matches.push(Object.fromEntries(["handle","sha256","offset","nextOffset","eof","text"]
      .map(key => [key, result[key]])));
  }
  return {
    matches, searched, complete: position === files.length && unavailable === 0,
    nextCursor: position < files.length ? position : null, index: fingerprint,
    unavailable, matchPolicy: "first occurrence per archive; use individual --offset for later occurrences",
    readbackProof: reference.readbackProof,
  };
}

// Use only known local Codex execution tools. Remote-client and tool-less
// requests keep full results; a filesystem path alone is not usable recovery.
export function hasLocalReadbackTool(tools) {
  return Array.isArray(tools) && tools.some((tool) => {
    if (tool?.type === "namespace") return hasLocalReadbackTool(tool.tools);
    const name = tool?.name || tool?.function?.name;
    if (/^(?:(?:functions|tools)(?:\.|__|_))?exec$/u.test(name || "") &&
        /tools\.exec_command/u.test(tool.description || tool?.function?.description || "")) return true;
    return /^(?:(?:functions|tools)(?:\.|__|_))?(?:exec_command|shell_command|shell)$/u.test(name || "");
  });
}

function quote(value) { return `'${String(value).replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`; }

export function recoveryInstruction(snapshot) {
  const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(path.join(SOURCE_ROOT, "src", "tool-result-read.mjs"))} ${quote(snapshot.handle)} --store ${quote(snapshot.directory)}`;
  return `Exact archived result: sha256:${snapshot.sha256}. Read using the local ${process.platform === "win32" ? "PowerShell" : "POSIX shell"}: ${command}\n` +
    "Returns JSON with text, nextOffset and eof; use --offset N --limit N (UTF-16 characters) or --find 'literal text' for omitted content. " +
    "If the matching archive is unknown, use this handle with --scope-search --find 'literal text'; it searches only this conversation/permission scope. " +
    "An expired, missing or corrupt archive is unavailable evidence; do not repeat the original tool to reconstruct it.";
}

function hasFailedReadbackAttempt(input, scope, directories) {
  const completed = new Map(input.filter(item =>
    ["function_call_output", "custom_tool_call_output"].includes(item?.type))
    .map(item => [item.call_id, item]));
  return input.some(item => {
    if (!["function_call", "custom_tool_call"].includes(item?.type) || !completed.has(item.call_id)) return false;
    const args = typeof item.arguments === "string" ? item.arguments : String(item.input || "");
    if (!args.includes("tool-result-read.mjs")) return false;
    // A field name, forged token or expired/foreign receipt is not a successful
    // read. Suppress optional retries; exact text and its recovery footer remain
    // available. Only the existing verifier can establish omission permission.
    return !directories.some(directory => hasVerifiedToolResultReadback(
      [completed.get(item.call_id)], scope, { directory },
    ));
  });
}

export async function ageToolResultsWithRecovery(input, { tools, scope = "", retain = retainToolResult, readbackHint = false, minSavingsBytes = 0, ...options } = {}) {
  if (!hasLocalReadbackTool(tools)) return ageToolResults(input, options);
  // Plan in memory, commit snapshots, then apply only successful receipts. The
  // synchronous policy stays pure and cannot leak uncommitted handles upstream.
  const candidates = new Map();
  const keyFor = (text, info) => JSON.stringify([info.callId, sha256(text)]);
  const planned = ageToolResults(input, { ...options, retain(text, info) {
    candidates.set(keyFor(text, info), { text, info });
    return "Read the exact archived result.";
  } });
  // A probe and cache rebuild can cost more than a small omission saves.
  // For an explicitly configured threshold, fall back to the existing policy
  // before writing snapshots or changing the wire history when the potential
  // is too small. Defaults and callers without this opt-in are unchanged.
  if (Number.isFinite(minSavingsBytes) && minSavingsBytes > 0 &&
      planned.stats.toolResultBytesSaved < minSavingsBytes) {
    return ageToolResultsWithRecovery(input, { tools, scope, retain,
      ...options, minBytes: undefined, readbackHint: false });
  }
  const committed = new Map();
  const started = Date.now();
  let bytes = 0;
  for (const [key, { text, info }] of candidates) {
    bytes += Buffer.byteLength(text);
    if (Date.now() - started > 1000 || bytes > MAX_RESULT_BYTES) break;
    try {
      const snapshot = await retain(text, { scope, callId: info.callId });
      if (snapshot) committed.set(key, { snapshot, instruction: recoveryInstruction(snapshot), text, info });
    } catch {
      // Includes full disk, denied ACL, unsafe paths, corrupt existing entries
      // and lock contention. Never turn optional savings into a failed turn.
    }
  }
  const verified = new Map();
  for (const { snapshot } of committed.values()) {
    if (!verified.has(snapshot.directory)) verified.set(snapshot.directory,
      hasVerifiedToolResultReadback(input, scope, { directory: snapshot.directory }));
  }
  const result = ageToolResults(input, { ...options, retain: (text, info) => {
    const saved = committed.get(keyFor(text, info));
    return saved && verified.get(saved.snapshot.directory) ? saved.instruction : undefined;
  } });
  const pending = new Map();
  for (const { snapshot, instruction, text, info } of committed.values()) {
    if (verified.get(snapshot.directory) || text.includes(PENDING)) continue;
    const footer = `\n\n${PENDING} Full output is preserved until local readback succeeds. ` +
      `Before relying on omission, run this read-only command once:\n${instruction}`;
    const item = input[info.index];
    pending.set(info.index, { ...item, output: typeof item.output === "string"
      ? item.output + footer : [...item.output, { type: "input_text", text: footer }] });
  }
  if (pending.size) result.input = result.input.map((item, index) => pending.get(index) || item);
  if (readbackHint && pending.size && !hasFailedReadbackAttempt(input, scope, [...verified.keys()])) {
    // A per-model opt-in, constructed solely from this request's committed
    // snapshots. Keep the permission proof requirement; never synthesize one
    // from the router's own filesystem access. This notice is a wire-only
    // addition and does not mutate the client's persisted conversation.
    const first = [...committed.values()].find(({ snapshot, info }) =>
      pending.has(info.index) && !verified.get(snapshot.directory));
    if (first) result.input = [...result.input, {
      type: "message", role: "developer", content: [{ type: "input_text", text:
        "Router archive access check: before continuing, use an available local execution tool once " +
        "to run the exact read-only archive reader below with --limit 1. This verifies local access " +
        "so old results can be omitted safely in later requests. Then continue the user task. " +
        "For an unknown archive, use --scope-search --find with any shown handle instead of guessing handles. " +
        "Respect user restrictions and permission policy; if a local read is disallowed, continue with the full text. " +
        "Do not rerun historical commands merely to reconstruct archived output.\n" + first.instruction,
      }],
    }];
  }
  return result;
}
