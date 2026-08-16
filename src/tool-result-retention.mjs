import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

// Where compaction parks the exact original bytes of a tool result it has
// rewritten. The directory is owner-private, is excluded from support bundles,
// and is the first place this router persists model-visible *content* to disk.
// Nothing here writes to it -- this module only reads it and empties it -- so
// the path is resolved exactly the way the retention writer resolves it,
// including the environment override, or a purge would look in a directory the
// writer never used.
export const TOOL_RESULT_RETENTION_DIR =
  process.env.MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR ||
  path.join(STATE_DIR, "retained-tool-results");

// Retention is bounded rather than evicting: at either cap the store stops
// accepting new results and eligible results pass through uncompacted. That is
// a safe failure, but it is also permanent until somebody empties the store,
// so it is the one state worth reporting louder than "here is a directory".
export const RETENTION_MAX_FILES = 512;
export const RETENTION_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// The three name shapes retention itself produces. Purge removes nothing else:
// a name the writer could not have produced is somebody else's file that
// happens to sit in this directory, and deleting it is not this command's
// business. These mirror the writer's own validation.
const RESULT_FILE_PATTERN = /^[A-Za-z0-9_-]{43}\.result$/u;
const STAGE_FILE_PATTERN = /^\.[^/\\]+\.stage\.[0-9a-f]{32}$/u;
const RETENTION_KEY_NAME = ".retention-key";

const DAY_MS = 24 * 60 * 60 * 1000;

function isRetentionEntry(name) {
  if (name === RETENTION_KEY_NAME) return true;
  return RESULT_FILE_PATTERN.test(name) || STAGE_FILE_PATTERN.test(name);
}

// A directory entry name is not a path. Joining one that is `..`, or that
// carries a separator on a filesystem that allowed it, would let a purge reach
// outside the store, so the join is checked rather than trusted: the parent of
// the resolved target must be the retention directory itself.
function retentionEntryPath(root, name) {
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Retained-result storage contains an unusable entry name: ${name}`);
  }
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root || path.basename(target) !== name) {
    throw new Error("Retained-result purge refused a path outside the retention directory.");
  }
  return target;
}

export function formatRetentionBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function describeRetentionAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.round(ageMs / 60_000))}m`;
  if (ageMs < DAY_MS) return `${Math.round(ageMs / (60 * 60 * 1000))}h`;
  return `${Math.round(ageMs / DAY_MS)}d`;
}

/**
 * What is on disk right now, without changing any of it.
 *
 * `results` counts retained originals; `files` counts everything retention
 * wrote, including the key and any interrupted stage. `foreign` counts entries
 * this store did not write, which purge will refuse to touch and which are
 * worth naming rather than silently ignoring.
 */
export function retainedToolResultsUsage({
  directory = TOOL_RESULT_RETENTION_DIR,
  now = Date.now(),
} = {}) {
  const root = path.resolve(directory);
  const empty = {
    path: root,
    exists: false,
    results: 0,
    files: 0,
    bytes: 0,
    foreign: [],
    oldestMs: undefined,
    oldestAgeMs: undefined,
    entries: [],
    capacityReached: false,
  };
  let listing;
  try {
    listing = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    // A store that was never created is the normal state on an install that
    // has never compacted a result, not a fault to report.
    if (error?.code === "ENOENT") return empty;
    if (error?.code === "ENOTDIR") {
      return { ...empty, exists: true, foreign: [path.basename(root)] };
    }
    throw error;
  }
  const entries = [];
  const foreign = [];
  let results = 0;
  let bytes = 0;
  let oldestMs;
  for (const entry of listing) {
    const name = entry.name;
    let stat;
    try {
      // lstat, never stat: a symlink parked in this directory is not a
      // retained result, and following one is how a purge ends up reading or
      // reporting a file that lives somewhere else entirely.
      stat = lstatSync(path.join(root, name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !isRetentionEntry(name)) {
      foreign.push(name);
      continue;
    }
    entries.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    bytes += stat.size;
    if (RESULT_FILE_PATTERN.test(name)) {
      results += 1;
      if (oldestMs === undefined || stat.mtimeMs < oldestMs) oldestMs = stat.mtimeMs;
    }
  }
  return {
    path: root,
    exists: true,
    results,
    files: entries.length,
    bytes,
    foreign,
    oldestMs,
    oldestAgeMs: oldestMs === undefined ? undefined : Math.max(0, now - oldestMs),
    entries,
    capacityReached: results >= RETENTION_MAX_FILES || bytes >= RETENTION_MAX_TOTAL_BYTES,
  };
}

/**
 * Empty the store, or report what emptying it would remove.
 *
 * The directory itself is left in place: it is created and permission-hardened
 * by the writer, and removing it under a concurrent write buys nothing that
 * removing its contents does not.
 */
export function purgeRetainedToolResults({
  directory = TOOL_RESULT_RETENTION_DIR,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const usage = retainedToolResultsUsage({ directory, now });
  const summary = {
    path: usage.path,
    exists: usage.exists,
    dryRun: dryRun === true,
    results: usage.results,
    files: usage.files,
    bytes: usage.bytes,
    foreign: usage.foreign,
    oldestAgeMs: usage.oldestAgeMs,
    removed: 0,
    reclaimedBytes: 0,
    failed: [],
  };
  if (!usage.exists || usage.files === 0) return summary;
  for (const entry of usage.entries) {
    const target = retentionEntryPath(usage.path, entry.name);
    if (summary.dryRun) {
      summary.removed += 1;
      summary.reclaimedBytes += entry.bytes;
      continue;
    }
    try {
      unlinkSync(target);
      summary.removed += 1;
      summary.reclaimedBytes += entry.bytes;
    } catch (error) {
      // Something removed it between the scan and the unlink; that is the
      // outcome this command wanted anyway.
      if (error?.code === "ENOENT") continue;
      summary.failed.push({
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
