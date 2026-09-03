import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { privateFileIsProtected, protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import { processStartIdentity, processStartIdentityProbe } from "./process-identity.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const LEASE_VERSION = 3;
const PREVIOUS_LEASE_VERSION = 2;
const LEGACY_LEASE_VERSION = 1;
const LEASE_FILE = "router-login-lease.json";
const RELOCATED_LEASE = /^router-login-lease\.relocated-[0-9a-f-]{36}\.json$/i;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LEASE_RECORDS = 32;
const MAX_AUTH_BYTES = 1024 * 1024;
export const CHATGPT_LOGIN_LEASE_MAX_AGE_MS = 15 * 60_000;

function accountId(value) {
  const id = String(value || "").trim();
  if (!ACCOUNT_ID.test(id)) throw new Error("Account id is invalid.");
  return id;
}

function verifiedAccountHome(value, {
  homesDir,
  accountHome,
} = {}) {
  const id = accountId(value);
  if (!homesDir && !accountHome) throw new Error("The ChatGPT login lease home is unavailable.");
  const home = path.resolve(accountHome || path.join(homesDir, id));
  const root = path.resolve(homesDir || path.dirname(home));
  if (path.basename(home) !== id || path.dirname(home) !== root) {
    throw new Error("The ChatGPT login lease escaped its account home.");
  }
  ensureNoSymlinkParents(root, { label: "ChatGPT login lease root" });
  ensureNoSymlinkParents(home, { label: "ChatGPT login lease account home" });
  for (const [target, label] of [[root, "root"], [home, "account home"]]) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`The ChatGPT login lease ${label} is not a private directory.`);
    }
  }
  const realRoot = realpathSync(root);
  if (path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("The ChatGPT login lease account home is not owned by its root.");
  }
  // Revalidate directly before the caller reads, creates, or clears its lease.
  ensureNoSymlinkParents(home, { label: "ChatGPT login lease account home" });
  if (realpathSync(root) !== realRoot || path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("The ChatGPT login lease account home changed during validation.");
  }
  return home;
}

export function chatGPTLoginLeasePath(value, options = {}) {
  return path.join(verifiedAccountHome(value, options), LEASE_FILE);
}

function validateLease(lease) {
  const versionValid = lease?.version === LEGACY_LEASE_VERSION
    || (lease?.version === PREVIOUS_LEASE_VERSION && typeof lease.leaseId === "string" && LEASE_ID.test(lease.leaseId))
    || (
      lease?.version === LEASE_VERSION
      && typeof lease.leaseId === "string"
      && LEASE_ID.test(lease.leaseId)
      && ["reserved", "running"].includes(lease.phase)
      && (lease.authDigestBefore === null || /^[0-9a-f]{64}$/.test(lease.authDigestBefore))
    );
  if (
    !lease
    || typeof lease !== "object"
    || Array.isArray(lease)
    || !versionValid
    || !Number.isSafeInteger(lease.pid)
    || lease.pid < 1
    || typeof lease.processIdentity !== "string"
    || !lease.processIdentity
    || !Number.isFinite(lease.createdAt)
  ) {
    throw new Error("The ChatGPT browser-login lease is invalid.");
  }
  return lease;
}

function loginAuthDigest(value, options = {}, { strict = false } = {}) {
  const home = verifiedAccountHome(value, options);
  const authPath = path.join(home, "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    ensureNoSymlinkParents(home, { label: "ChatGPT login lease account home" });
    const file = lstatSync(authPath);
    if (file.isSymbolicLink() || !file.isFile() || file.size > MAX_AUTH_BYTES) {
      throw new Error("The ChatGPT login profile is not a bounded owner-only file.");
    }
    if (!privateFileIsProtected(authPath)) {
      if (!strict) return undefined;
      protectPrivateFile(authPath);
      if (!privateFileIsProtected(authPath)) {
        throw new Error("The ChatGPT login profile is not a bounded owner-only file.");
      }
    }
    return createHash("sha256").update(readFileSync(authPath)).digest("hex");
  } catch (error) {
    if (strict) throw error;
    return undefined;
  }
}

export function chatGPTLoginAuthChanged(value, lease, options = {}) {
  const expected = validateLease(lease);
  if (expected.version !== LEASE_VERSION) return true;
  const current = loginAuthDigest(value, options);
  return current === undefined || current !== expected.authDigestBefore;
}

function readLeaseAt(leasePath) {
  const stat = lstatSync(leasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("The ChatGPT browser-login lease is invalid.");
  }
  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch (error) {
    throw new Error("The ChatGPT browser-login lease could not be read.", { cause: error });
  }
  return validateLease(lease);
}

function leaseRecords(value, options = {}) {
  const home = verifiedAccountHome(value, options);
  const names = readdirSync(home)
    .filter((name) => name === LEASE_FILE || RELOCATED_LEASE.test(name))
    .sort((left, right) => left === LEASE_FILE ? -1 : right === LEASE_FILE ? 1 : left.localeCompare(right));
  if (names.length > MAX_LEASE_RECORDS) {
    throw new Error("Too many ChatGPT browser-login lease records were found.");
  }
  const records = [];
  for (const name of names) {
    const leasePath = path.join(home, name);
    try {
      records.push({ leasePath, fixed: name === LEASE_FILE, lease: readLeaseAt(leasePath) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return records;
}

function sameLease(left, right) {
  return Boolean(
    left
    && right
    && left.version === right.version
    && left.pid === right.pid
    && left.processIdentity === right.processIdentity
    && left.createdAt === right.createdAt
    && left.leaseId === right.leaseId
    && left.phase === right.phase
    && left.authDigestBefore === right.authDigestBefore
  );
}

export function chatGPTLoginLeaseMatches(value, expected, options = {}) {
  if (!expected) return false;
  const records = leaseRecords(value, options);
  return records.length === 1 && sameLease(records[0].lease, expected);
}

function relocatedLeasePath(leasePath) {
  const home = path.dirname(leasePath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = path.join(home, `router-login-lease.relocated-${randomUUID()}.json`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Could not allocate a ChatGPT browser-login lease relocation.");
}

export function createChatGPTLoginLease(value, pid, {
  identity = processStartIdentity,
  now = Date.now(),
  phase = "running",
  ...options
} = {}) {
  if (!["reserved", "running"].includes(phase)) {
    throw new Error("The ChatGPT login lease phase is invalid.");
  }
  const processIdentity = identity(pid);
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof processIdentity !== "string" || !processIdentity) {
    throw new Error("Codex login started, but its process ownership could not be verified.");
  }
  const leasePath = chatGPTLoginLeasePath(value, options);
  const lease = {
    version: LEASE_VERSION,
    leaseId: randomUUID(),
    pid,
    processIdentity,
    createdAt: now,
    phase,
    authDigestBefore: loginAuthDigest(value, options, { strict: true }),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = chatGPTLoginLeaseStatus(value, { identity, now, ...options });
    if (status.active) {
      throw new Error("A browser sign-in is already in progress for this ChatGPT account.");
    }
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(
        leasePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(lease)}\n`, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      protectPrivateFile(leasePath);
      // A prior owner's cleanup can relocate this generation while it is
      // being claimed. Relocated records remain authoritative, but any other
      // generation means this claimant lost exclusivity and must withdraw.
      if (leaseRecords(value, options).some(({ lease: candidate }) => !sameLease(candidate, lease))) {
        clearChatGPTLoginLease(value, lease, options);
        throw new Error("A browser sign-in is already in progress for this ChatGPT account.");
      }
      return lease;
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (created) {
        // A failed write or owner-only protection must not leave a claim that
        // this caller reports as failed. Match the record before removal so a
        // replacement owner is never deleted by cleanup from this attempt.
        try { clearChatGPTLoginLease(value, lease, options); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("The ChatGPT browser-login lease changed while it was being claimed.");
}

export function attachChatGPTLoginLease(value, expected, pid, {
  identity = processStartIdentity,
  ...options
} = {}) {
  const processIdentity = identity(pid);
  if (
    expected?.version !== LEASE_VERSION
    || expected.phase !== "reserved"
    || !Number.isSafeInteger(pid)
    || pid < 1
    || typeof processIdentity !== "string"
    || !processIdentity
    || !chatGPTLoginLeaseMatches(value, expected, options)
  ) {
    throw new Error("The ChatGPT login reservation changed before process attachment.");
  }
  const attached = { ...expected, phase: "running", pid, processIdentity };
  writePrivateJson(chatGPTLoginLeasePath(value, options), attached, { directoryMode: 0o700 });
  if (!chatGPTLoginLeaseMatches(value, attached, options)) {
    throw new Error("The ChatGPT login process attachment could not be verified.");
  }
  return attached;
}

export function clearChatGPTLoginLease(value, expected, options = {}) {
  if (!expected) return false;
  for (const record of leaseRecords(value, options)) {
    let { leasePath } = record;
    if (record.fixed) options.beforeRelocate?.(record.lease);
    const relocated = relocatedLeasePath(leasePath);
    try {
      // Move first, inspect second. If another generation replaced the one
      // the caller observed, it is preserved at a name every reader scans;
      // this caller never unlinks a reusable path. Relocate already-relocated
      // records as well so the final unlink targets a fresh, operation-owned
      // random name rather than one another cleanup previously observed.
      renameSync(leasePath, relocated);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    leasePath = relocated;
    let lease;
    try {
      lease = readLeaseAt(leasePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!sameLease(lease, expected)) continue;
    try {
      unlinkSync(leasePath);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

export function chatGPTLoginLeaseStatus(value, {
  identity = processStartIdentity,
  identityProbe = processStartIdentityProbe,
  now = Date.now(),
  maxAgeMs = CHATGPT_LOGIN_LEASE_MAX_AGE_MS,
  ...options
} = {}) {
  let stale = false;
  for (let pass = 0; pass < 3; pass += 1) {
    const records = leaseRecords(value, options);
    if (records.length === 0) return { active: false, stale };
    let changed = false;
    for (const { lease } of records) {
      const observed = identity === processStartIdentity
        ? identityProbe(lease.pid)
        : (() => {
            const currentIdentity = identity(lease.pid);
            return typeof currentIdentity === "string" && currentIdentity
              ? { state: "alive", identity: currentIdentity }
              : { state: "unknown" };
          })();
      const currentIdentity = observed.state === "alive" ? observed.identity : undefined;
      if (currentIdentity === lease.processIdentity) {
        return { active: true, stale: false, pid: lease.pid };
      }
      const expired = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now - lease.createdAt > maxAgeMs;
      const ownerDefinitelyEnded = observed.state === "absent"
        || (typeof currentIdentity === "string" && currentIdentity !== lease.processIdentity);
      if (ownerDefinitelyEnded) {
        if (lease.version === LEASE_VERSION) {
          const currentDigest = loginAuthDigest(value, options);
          if (currentDigest === undefined || currentDigest !== lease.authDigestBefore) {
            return {
              active: true,
              stale: true,
              ...(lease.phase === "running"
                ? { completionPending: true }
                : { attentionRequired: true }),
              pid: lease.pid,
            };
          }
          if (lease.phase === "reserved") {
            // The reserving parent can die after spawning a detached child but
            // before attaching its process identity. Unchanged auth does not
            // prove that child is gone; keep the only durable exclusion rather
            // than admitting a second writer that can race its later callback.
            return {
              active: true,
              stale: true,
              attentionRequired: true,
              pid: lease.pid,
            };
          }
        }
        if (clearChatGPTLoginLease(value, lease, options)) {
          stale = true;
          changed = true;
          continue;
        }
        return { active: true, stale: false, uncertain: true };
      }
      // An unavailable process probe is never proof of exit. Age only changes
      // the operator-facing diagnosis; it cannot authorize clearing or
      // finalizing credentials while the writer may still be alive.
      return {
        active: true,
        stale: false,
        pid: lease.pid,
        uncertain: true,
        ...(expired ? { attentionRequired: true } : {}),
      };
    }
    if (!changed) break;
  }
  return leaseRecords(value, options).length === 0
    ? { active: false, stale }
    : { active: true, stale: false, uncertain: true };
}

export function chatGPTLoginLeaseCompletionCandidate(value, options = {}) {
  const status = chatGPTLoginLeaseStatus(value, options);
  if (!status.completionPending) return undefined;
  const records = leaseRecords(value, options);
  if (records.length !== 1 || records[0].lease.version !== LEASE_VERSION) {
    throw new Error("The ChatGPT login completion lease is ambiguous.");
  }
  return records[0].lease;
}

export function assertChatGPTLoginLeaseInactive(value, { message, ...options } = {}) {
  if (chatGPTLoginLeaseStatus(value, options).active) {
    throw new Error(message || "Cannot remove a ChatGPT account while its browser sign-in is in progress.");
  }
}
