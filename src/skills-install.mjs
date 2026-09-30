// Install the codex-router skill pack into the Codex app's user-skill
// directory. The pack teaches custom routed models how to use the app's
// native tools; it never touches official plugins or any other user skill.
//
// A visible marker is not ownership proof: users and other tools can create
// that filename too. Replacement and removal require a random token to match
// both the marker and a protected ownership file under codex-router's private
// state directory. Unknown files, symlinks, directories, and legacy markers
// are always preserved. Reviewed external skill directories can be explicitly
// approved by exact content digest without granting router ownership.
//
// CLI: node src/skills-install.mjs install|uninstall|approve-external|revoke-external
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { CODEX_HOME, SKILL_OWNERSHIP_PATH } from "./paths.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".codex-router-managed";
const OWNERSHIP_VERSION = 1;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_MAX_ENTRIES = 4_096;
const DIGEST_MAX_BYTES = 64 * 1024 * 1024;
const DIGEST_MAX_DEPTH = 64;
const DIGEST_READ_CHUNK_BYTES = 64 * 1024;
const MARKER_MAX_BYTES = 64 * 1024;
const OWNERSHIP_MAX_BYTES = 1024 * 1024;
const OWNERSHIP_MAX_ENTRIES = 4_096;
const RETIRE_PREFIX = ".codex-router-retire-";
const RETIRE_JOURNAL = ".codex-router-retirement.json";
const RETIRE_CONTENT = "content";
const RETIRE_PUBLICATION = "publication";
const RETIRE_JOURNAL_MAX_BYTES = 16 * 1024;
const ACTIVE_RETIREMENT_MAX_AGE_MS = 5 * 60 * 1000;
const PUBLISH_MARKER = ".codex-router-publishing";
const SKILL_OPERATION_LOCK_WAIT_MS = 30_000;

// The pack source directory. Overridable for tests via the environment.
function skillsSource() {
  return process.env.CODEX_ROUTER_SKILLS_DIR || path.join(SOURCE_ROOT, "skills");
}

function sourceProvenance() {
  let packageVersion = null;
  try {
    packageVersion =
      JSON.parse(readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")).version || null;
  } catch {
    // Provenance is diagnostic; ownership is the random token.
  }
  let commit = null;
  try {
    commit =
      execFileSync("git", ["-C", SOURCE_ROOT, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // Packaged installs may not have a git directory.
  }
  return { packageVersion, commit };
}

function markerContent(name, token, source) {
  return `${JSON.stringify({ version: 1, name, token, source }, null, 2)}\n`;
}

export function codexSkillsDir(codexHome) {
  return path.join(codexHome, "skills");
}

export function skillOwnershipPath(codexHome) {
  return path.resolve(codexHome) === path.resolve(CODEX_HOME)
    ? SKILL_OWNERSHIP_PATH
    : path.join(codexHome, "codex-router", "managed-skills.json");
}

function validSkillName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function validToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

function emptySkills() {
  return Object.create(null);
}

function lstat(target) {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

function sameFileIdentity(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

function readBoundedStableFile(target, maxBytes) {
  const before = lstat(target);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size < 0 ||
    before.size > maxBytes
  ) {
    return undefined;
  }
  let descriptor;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(target, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size > maxBytes) {
      return undefined;
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const read = readSync(descriptor, content, offset, opened.size - offset, offset);
      if (read <= 0) return undefined;
      offset += read;
    }
    if (
      !sameFileIdentity(opened, fstatSync(descriptor)) ||
      !sameFileIdentity(before, lstat(target))
    ) {
      return undefined;
    }
    return content;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close cannot make an unreadable file trusted.
      }
    }
  }
}

function directoryDigest(target, { ignoreRootEntries = [] } = {}) {
  try {
    const hash = createHash("sha256");
    const budget = { entries: 0, bytes: 0 };
    const ignoredAtRoot = new Set(ignoreRootEntries);

    function hashFile(full, relative, before) {
      if (before.size > DIGEST_MAX_BYTES - budget.bytes) return false;
      let descriptor;
      try {
        const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
        descriptor = openSync(full, constants.O_RDONLY | noFollow);
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || !sameFileIdentity(before, opened)) return false;
        hash.update(`F\0${relative}\0${opened.size}\0`);
        const buffer = Buffer.allocUnsafe(DIGEST_READ_CHUNK_BYTES);
        let offset = 0;
        while (offset < opened.size) {
          const length = Math.min(buffer.length, opened.size - offset);
          const read = readSync(descriptor, buffer, 0, length, offset);
          if (read <= 0) return false;
          hash.update(buffer.subarray(0, read));
          offset += read;
        }
        const afterRead = fstatSync(descriptor);
        const afterPath = lstat(full);
        if (!sameFileIdentity(opened, afterRead) || !sameFileIdentity(before, afterPath)) {
          return false;
        }
        budget.bytes += opened.size;
        return true;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }

    function walk(directory, relative = "", depth = 0) {
      if (depth > DIGEST_MAX_DEPTH) return false;
      const before = lstat(directory);
      if (!before?.isDirectory() || before.isSymbolicLink()) return false;
      hash.update(`D\0${relative}\0`);
      const entries = [];
      const handle = opendirSync(directory);
      try {
        let entry;
        while ((entry = handle.readSync())) {
          if (depth === 0 && ignoredAtRoot.has(entry.name)) continue;
          budget.entries += 1;
          if (budget.entries > DIGEST_MAX_ENTRIES) return false;
          entries.push(entry);
        }
      } finally {
        handle.closeSync();
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childStat = lstat(full);
        if (!childStat || childStat.isSymbolicLink()) return false;
        if (childStat.isDirectory()) {
          if (!walk(full, childRelative, depth + 1)) return false;
        } else if (childStat.isFile()) {
          if (!hashFile(full, childRelative, childStat)) return false;
        } else {
          return false;
        }
      }
      return sameFileIdentity(before, lstat(directory));
    }

    return walk(target) ? hash.digest("hex") : undefined;
  } catch {
    // Unreadable or concurrently replaced trees invalidate an approval. They
    // must never abort doctor/install or turn an unverified tree into owned
    // content.
    return undefined;
  }
}

function invalidOwnership(path, exists = true) {
  return {
    exists,
    valid: false,
    path,
    skills: emptySkills(),
    external: emptySkills(),
  };
}

function readOwnership(codexHome) {
  const target = skillOwnershipPath(codexHome);
  const targetStat = lstat(target);
  if (!targetStat) {
    return {
      exists: false,
      valid: true,
      path: target,
      skills: emptySkills(),
      external: emptySkills(),
    };
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) return invalidOwnership(target);
  if (!privateFileIsProtected(target)) return invalidOwnership(target);
  try {
    const content = readBoundedStableFile(target, OWNERSHIP_MAX_BYTES);
    if (!content) return invalidOwnership(target);
    const parsed = JSON.parse(content.toString("utf8"));
    if (
      parsed?.version !== OWNERSHIP_VERSION ||
      !parsed.skills ||
      typeof parsed.skills !== "object" ||
      Array.isArray(parsed.skills) ||
      (parsed.external !== undefined &&
        (!parsed.external || typeof parsed.external !== "object" || Array.isArray(parsed.external)))
    ) {
      return invalidOwnership(target);
    }
    const skillEntries = Object.entries(parsed.skills);
    const externalEntries = Object.entries(parsed.external || {});
    if (skillEntries.length + externalEntries.length > OWNERSHIP_MAX_ENTRIES) {
      return invalidOwnership(target);
    }
    const skills = emptySkills();
    const external = emptySkills();
    let valid = true;
    for (const [name, record] of skillEntries) {
      if (!validSkillName(name) || !validToken(record?.token)) {
        valid = false;
        continue;
      }
      skills[name] = { token: record.token };
    }
    for (const [name, record] of externalEntries) {
      if (
        !validSkillName(name) ||
        !validToken(record?.targetDigest) ||
        !validToken(record?.sourceDigest)
      ) {
        valid = false;
        continue;
      }
      external[name] = {
        targetDigest: record.targetDigest,
        sourceDigest: record.sourceDigest,
      };
    }
    if (Object.keys(external).some((name) => skills[name])) valid = false;
    return {
      exists: true,
      valid,
      path: target,
      skills: valid ? skills : emptySkills(),
      external: valid ? external : emptySkills(),
    };
  } catch {
    return invalidOwnership(target);
  }
}

function writeOwnership(target, skills, external = emptySkills()) {
  const stateDir = path.dirname(target);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${target}.tmp.${process.pid}`;
  const state = { version: OWNERSHIP_VERSION, skills };
  if (Object.keys(external).length > 0) state.external = external;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

function parseMarker(target) {
  const markerPath = path.join(target, MARKER);
  try {
    const content = readBoundedStableFile(markerPath, MARKER_MAX_BYTES);
    if (!content) return undefined;
    const parsed = JSON.parse(content.toString("utf8"));
    if (
      parsed?.version !== 1 ||
      !validSkillName(parsed.name) ||
      !validToken(parsed.token) ||
      !parsed.source ||
      typeof parsed.source !== "object" ||
      Array.isArray(parsed.source)
    ) {
      return undefined;
    }
    const { packageVersion, commit } = parsed.source;
    if (packageVersion !== null && typeof packageVersion !== "string") return undefined;
    if (commit !== null && typeof commit !== "string") return undefined;
    return parsed;
  } catch {
    // Invalid markers never authorize replacement or removal.
  }
  return undefined;
}

function ownershipEvidenceAt(target, name, record) {
  if (!record) return { owned: false, reason: "not recorded" };
  const targetStat = lstat(target);
  if (!targetStat) return { owned: false, reason: "target missing" };
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return { owned: false, reason: "target is not a real directory" };
  }
  const marker = parseMarker(target);
  if (!marker) return { owned: false, reason: "marker is missing or invalid" };
  if (marker.name !== name || marker.token !== record.token) {
    return { owned: false, reason: "marker does not match private ownership state" };
  }
  return { owned: true, reason: "verified" };
}

function ownershipEvidence(codexHome, name, ownership) {
  return ownershipEvidenceAt(
    path.join(codexSkillsDir(codexHome), name),
    name,
    ownership.skills[name],
  );
}

function retirementJournalContent(
  name,
  { publicationToken = null, managedToken = null, managedDigest = null } = {},
) {
  return `${JSON.stringify(
    {
      version: 1,
      name,
      pid: process.pid,
      startedAt: Date.now(),
      publicationToken,
      managedToken,
      managedDigest,
    },
    null,
    2,
  )}\n`;
}

function readRetirementJournal(quarantine) {
  const journalPath = path.join(quarantine, RETIRE_JOURNAL);
  if (!privateFileIsProtected(journalPath)) return undefined;
  const content = readBoundedStableFile(journalPath, RETIRE_JOURNAL_MAX_BYTES);
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    if (
      parsed?.version !== 1 ||
      !validSkillName(parsed.name) ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !Number.isSafeInteger(parsed.startedAt) ||
      parsed.startedAt <= 0 ||
      (parsed.publicationToken !== null && !validToken(parsed.publicationToken)) ||
      (parsed.managedToken !== null && !validToken(parsed.managedToken)) ||
      (parsed.managedDigest !== null && !validToken(parsed.managedDigest))
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function finishQuarantine(quarantine) {
  const journal = path.join(quarantine, RETIRE_JOURNAL);
  const entries = readdirSync(quarantine).sort();
  if (entries.length === 0) {
    rmdirSync(quarantine);
    return;
  }
  if (entries.length !== 1 || entries[0] !== RETIRE_JOURNAL) {
    throw new Error(`Unexpected content remains in skill transaction ${quarantine}.`);
  }
  const journalStat = lstat(journal);
  if (!journalStat?.isFile() || journalStat.isSymbolicLink()) {
    throw new Error(`Invalid skill transaction journal at ${journal}.`);
  }
  unlinkSync(journal);
  rmdirSync(quarantine);
}

function preservedSkillPath(target) {
  for (;;) {
    const candidate = `${target}.codex-router-preserved-${randomBytes(8).toString("hex")}`;
    if (!lstat(candidate)) return candidate;
  }
}

function restoreOrPreservePath(content, target) {
  // Node has no cross-platform rename-no-replace primitive for directories;
  // POSIX rename can silently replace a concurrently claimed empty directory.
  // A fresh random sibling is therefore the only fail-closed destination.
  const preserved = preservedSkillPath(target);
  renameSync(content, preserved);
  return { restored: false, preserved };
}

function restoreOrPreserveQuarantinedSkill(content, target, quarantine) {
  const recovery = restoreOrPreservePath(content, target);
  finishQuarantine(quarantine);
  return recovery;
}

function journalPublicationEvidence(target, journal) {
  if (!journal.publicationToken) return { owned: false, complete: false };
  const publicationMarker = readBoundedStableFile(path.join(target, PUBLISH_MARKER), 256);
  if (publicationMarker?.toString("utf8") === `${journal.publicationToken}\n`) {
    return { owned: true, complete: false };
  }
  if (!journal.managedToken || !journal.managedDigest) {
    return { owned: false, complete: false };
  }
  if (!ownershipEvidenceAt(target, journal.name, { token: journal.managedToken }).owned) {
    return { owned: false, complete: false };
  }
  const digest = directoryDigest(target, { ignoreRootEntries: [PUBLISH_MARKER] });
  return {
    owned: digest === journal.managedDigest,
    complete: digest === journal.managedDigest,
  };
}

function ownershipStateAcceptsPublication(codexHome, journal) {
  if (!journal.managedToken) return false;
  const ownership = readOwnership(codexHome);
  return ownership.valid && ownership.skills[journal.name]?.token === journal.managedToken;
}

function recoverOperationPublication(codexHome, target, publication, journal) {
  if (lstat(publication)) {
    const evidence = journalPublicationEvidence(publication, journal);
    if (!evidence.owned) {
      restoreOrPreservePath(publication, target);
      return;
    }
    if (evidence.complete && ownershipStateAcceptsPublication(codexHome, journal)) {
      restoreOrPreservePath(publication, target);
      return;
    }
    // This is the exact incomplete or uncommitted publication named by the
    // durable journal, revalidated after it left the shared public path.
    rmSync(publication, { recursive: true, force: true });
    return;
  }

  const before = journalPublicationEvidence(target, journal);
  if (!before.owned) return;
  if (before.complete && ownershipStateAcceptsPublication(codexHome, journal)) {
    return;
  }
  try {
    renameSync(target, publication);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const after = journalPublicationEvidence(publication, journal);
  if (!after.owned || after.complete !== before.complete) {
    restoreOrPreservePath(publication, target);
    return;
  }
  rmSync(publication, { recursive: true, force: true });
}

function recoverAbandonedSkillRetirements(codexHome) {
  const skillsDir = codexSkillsDir(codexHome);
  const rootStat = lstat(skillsDir);
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Cannot recover skill transactions because ${skillsDir} is not a real directory.`);
  }
  const names = readdirSync(skillsDir)
    .filter((name) => name.startsWith(RETIRE_PREFIX))
    .sort();
  for (const name of names) {
    const quarantine = path.join(skillsDir, name);
    const quarantineStat = lstat(quarantine);
    if (!quarantineStat?.isDirectory() || quarantineStat.isSymbolicLink()) {
      throw new Error(`Unsafe abandoned skill transaction at ${quarantine}; refusing mutation.`);
    }
    const entries = readdirSync(quarantine).sort();
    if (entries.length === 0) {
      rmdirSync(quarantine);
      continue;
    }
    if (
      entries.some(
        (entry) => ![RETIRE_CONTENT, RETIRE_JOURNAL, RETIRE_PUBLICATION].includes(entry),
      )
    ) {
      throw new Error(`Unrecognized abandoned skill transaction at ${quarantine}; refusing mutation.`);
    }
    const journal = readRetirementJournal(quarantine);
    if (!journal) {
      throw new Error(`Invalid abandoned skill transaction at ${quarantine}; refusing mutation.`);
    }
    const target = path.join(skillsDir, journal.name);
    const content = path.join(quarantine, RETIRE_CONTENT);
    const publication = path.join(quarantine, RETIRE_PUBLICATION);
    const age = Date.now() - journal.startedAt;
    if (
      age >= 0 &&
      age < ACTIVE_RETIREMENT_MAX_AGE_MS &&
      processIsAlive(journal.pid)
    ) {
      throw new Error(
        `Skill transaction ${quarantine} is still active in process ${journal.pid}; retry later.`,
      );
    }
    recoverOperationPublication(codexHome, target, publication, journal);
    if (!lstat(content)) {
      // The old target was never moved, was already recovered, or its verified
      // deletion completed before process exit. No user content remains here.
      finishQuarantine(quarantine);
      continue;
    }
    // Recovery never deletes abandoned content. It restores the original name
    // when free, or exposes the exact tree under a visible preserved sibling.
    restoreOrPreserveQuarantinedSkill(content, target, quarantine);
  }
}

function beginSkillTransaction(
  codexHome,
  name,
  { publicationToken = null, managedToken = null, managedDigest = null } = {},
) {
  const skillsDir = codexSkillsDir(codexHome);
  mkdirSync(skillsDir, { recursive: true });
  const target = path.join(skillsDir, name);
  const quarantine = mkdtempSync(path.join(skillsDir, RETIRE_PREFIX));
  chmodSync(quarantine, 0o700);
  const journal = path.join(quarantine, RETIRE_JOURNAL);
  const content = path.join(quarantine, RETIRE_CONTENT);
  try {
    writeFileSync(
      journal,
      retirementJournalContent(name, { publicationToken, managedToken, managedDigest }),
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
        flush: true,
      },
    );
    protectPrivateFile(journal);
    return { name, target, content, quarantine };
  } catch (error) {
    if (lstat(journal)) unlinkSync(journal);
    try {
      rmdirSync(quarantine);
    } catch {
      // Preserve anything unexpected in the transaction directory.
    }
    throw error;
  }
}

function beginManagedSkillRetirement(
  codexHome,
  name,
  ownership,
  {
    onQuarantined,
    publicationToken,
    managedToken,
    managedDigest,
  } = {},
) {
  const record = ownership.skills[name];
  if (!record) return { retired: false, reason: "not recorded" };
  const skillsDir = codexSkillsDir(codexHome);
  const target = path.join(skillsDir, name);
  if (!lstat(target)) return { retired: false, reason: "target missing" };
  const preflight = ownershipEvidenceAt(target, name, record);
  if (!preflight.owned) return { retired: false, reason: preflight.reason };
  const transaction = beginSkillTransaction(codexHome, name, {
    publicationToken,
    managedToken,
    managedDigest,
  });
  const { quarantine, content } = transaction;
  try {
    renameSync(target, content);
  } catch (error) {
    if (!lstat(content)) {
      try {
        finishQuarantine(quarantine);
      } catch {
        // Preserve anything unexpected in the transaction directory.
      }
    }
    if (error?.code === "ENOENT") {
      return { retired: false, reason: "target changed before retirement" };
    }
    throw error;
  }
  try {
    onQuarantined?.({ name, target, staged: content, quarantine });
    const evidence = ownershipEvidenceAt(content, name, record);
    if (!evidence.owned) {
      const recovery = restoreOrPreserveQuarantinedSkill(content, target, quarantine);
      return {
        retired: false,
        reason: recovery.restored
          ? evidence.reason
          : `${evidence.reason}; content preserved at ${recovery.preserved}`,
      };
    }
    return {
      retired: true,
      reason: "verified and quarantined",
      transaction: { ...transaction, record },
    };
  } catch (error) {
    if (lstat(content)) {
      restoreOrPreserveQuarantinedSkill(content, target, quarantine);
    }
    else if (lstat(quarantine)) finishQuarantine(quarantine);
    throw error;
  }
}

function abandonRetirement(transaction) {
  if (!transaction) return undefined;
  if (!lstat(transaction.content)) {
    if (lstat(transaction.quarantine)) finishQuarantine(transaction.quarantine);
    return undefined;
  }
  return restoreOrPreserveQuarantinedSkill(
    transaction.content,
    transaction.target,
    transaction.quarantine,
  );
}

function commitRetirement(transaction) {
  if (!transaction) return false;
  if (!lstat(transaction.content)) {
    finishQuarantine(transaction.quarantine);
    return true;
  }
  const evidence = ownershipEvidenceAt(
    transaction.content,
    transaction.name,
    transaction.record,
  );
  if (!evidence.owned) {
    restoreOrPreserveQuarantinedSkill(
      transaction.content,
      transaction.target,
      transaction.quarantine,
    );
    return false;
  }
  // Recursive deletion is confined to the exact verified directory atomically
  // moved under our private, randomly named quarantine.
  rmSync(transaction.content, { recursive: true, force: true });
  finishQuarantine(transaction.quarantine);
  return true;
}

function stageManagedSkill(source, target, name, token, provenance, { onStaged } = {}) {
  const staging = mkdtempSync(path.join(path.dirname(target), ".codex-router-install-"));
  chmodSync(staging, 0o700);
  const content = path.join(staging, "content");
  try {
    cpSync(source, content, { recursive: true });
    writeFileSync(path.join(content, MARKER), markerContent(name, token, provenance));
    if (
      !ownershipEvidenceAt(content, name, { token }).owned ||
      !sameDirContent(source, content)
    ) {
      throw new Error(`Could not validate staged skill "${name}".`);
    }
    const digest = directoryDigest(content);
    if (!digest) throw new Error(`Could not digest staged skill "${name}".`);
    onStaged?.({ name, target, staged: content });
    return { staging, content, digest };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// Copies a validated tree into a directory this operation has already claimed,
// one top-level entry at a time, so every `cpSync` destination is a path that
// does not exist yet. Copying the tree root onto the claimed directory relied
// on `cpSync` merging into an existing directory under `errorOnExist`, and
// Node 26.10 made that option refuse the directory itself (nodejs/node#64124):
// every publication failed with ERR_FS_CP_EEXIST naming the target this
// operation had just created. A pre-existing file is still refused, never
// overwritten; a pre-existing directory is refused on 26.10 and merged into on
// older Node, where the digest comparison below then rejects the result.
function copyIntoClaimedDirectory(source, target) {
  for (const name of readdirSync(source).sort()) {
    cpSync(path.join(source, name), path.join(target, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function discardStagedSkill(staged) {
  if (staged && lstat(staged.staging)) {
    // This tree was copied only from the current checkout and never occupied a
    // public skill path, so it cannot contain pre-existing user content.
    rmSync(staged.staging, { recursive: true, force: true });
  }
}

function publishStagedSkill(staged, target, publicationToken, { onPublicationClaimed } = {}) {
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { published: false, reason: "target appeared during install" };
    }
    throw error;
  }
  try {
    writeFileSync(path.join(target, PUBLISH_MARKER), `${publicationToken}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    onPublicationClaimed?.({ target });
    copyIntoClaimedDirectory(staged.content, target);
    const stagedDigest = directoryDigest(staged.content);
    const targetDigest = directoryDigest(target, { ignoreRootEntries: [PUBLISH_MARKER] });
    if (!stagedDigest || stagedDigest !== targetDigest) {
      throw new Error("published skill did not match its validated staging tree");
    }
    unlinkSync(path.join(target, PUBLISH_MARKER));
    return { published: true };
  } catch (error) {
    // Claiming the path with mkdir is a true no-replace operation on every
    // supported platform. If publication fails, remove only a directory that
    // still carries this operation's random marker; otherwise preserve it.
    const marker = readBoundedStableFile(path.join(target, PUBLISH_MARKER), 256);
    if (marker?.toString("utf8") === `${publicationToken}\n`) {
      const cleanup = mkdtempSync(path.join(path.dirname(target), RETIRE_PREFIX));
      chmodSync(cleanup, 0o700);
      const cleanupContent = path.join(cleanup, RETIRE_CONTENT);
      try {
        const cleanupJournal = path.join(cleanup, RETIRE_JOURNAL);
        writeFileSync(cleanupJournal, retirementJournalContent(path.basename(target)), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
          flush: true,
        });
        protectPrivateFile(cleanupJournal);
        renameSync(target, cleanupContent);
        const movedMarker = readBoundedStableFile(
          path.join(cleanupContent, PUBLISH_MARKER),
          256,
        );
        if (movedMarker?.toString("utf8") === `${publicationToken}\n`) {
          rmSync(cleanupContent, { recursive: true, force: true });
          finishQuarantine(cleanup);
        } else {
          restoreOrPreserveQuarantinedSkill(cleanupContent, target, cleanup);
        }
      } catch {
        // A changed public target is safer preserved than guessed away.
        try {
          if (lstat(cleanupContent)) {
            restoreOrPreserveQuarantinedSkill(cleanupContent, target, cleanup);
          } else if (lstat(cleanup)) {
            finishQuarantine(cleanup);
          }
        } catch {
          // The durable journal lets the next mutation recover this path.
        }
      }
    }
    throw error;
  }
}

// The pack names this checkout ships: source directories with a SKILL.md,
// excluding hidden directories.
export function packSkillNames() {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) return [];
  try {
    return readdirSync(sourceRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          validSkillName(entry.name) &&
          existsSync(path.join(sourceRoot, entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function managedSkillNames(codexHome) {
  const ownership = readOwnership(codexHome);
  return Object.keys(ownership.skills)
    .filter((name) => ownershipEvidence(codexHome, name, ownership).owned)
    .sort();
}

function externalEvidence(codexHome, name, ownership) {
  const record = ownership.external[name];
  if (!record) return { approved: false, reason: "not approved" };
  const target = path.join(codexSkillsDir(codexHome), name);
  const targetDigest = directoryDigest(target);
  if (!targetDigest) return { approved: false, reason: "target is not a real directory tree" };
  if (targetDigest !== record.targetDigest) {
    return { approved: false, reason: "external skill changed since approval" };
  }
  const sourceDigest = directoryDigest(path.join(skillsSource(), name));
  if (!sourceDigest) return { approved: false, reason: "router skill source is unavailable" };
  if (sourceDigest !== record.sourceDigest) {
    return { approved: false, reason: "router skill changed since approval" };
  }
  return { approved: true, reason: "verified exact approved contents" };
}

function approveExternalSkillsUnlocked(codexHome, names, { quiet = false } = {}) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("Name at least one external skill to approve.");
  }
  recoverAbandonedSkillRetirements(codexHome);
  const requested = [...new Set(names)];
  const pack = new Set(packSkillNames());
  const ownership = readOwnership(codexHome);
  if (!ownership.valid) {
    throw new Error("Cannot approve external skills while private skill state is malformed.");
  }
  const approvals = [];
  for (const name of requested) {
    if (!validSkillName(name) || !pack.has(name)) {
      throw new Error(`Cannot approve unknown router skill "${name}".`);
    }
    if (ownershipEvidence(codexHome, name, ownership).owned) {
      throw new Error(`Cannot approve "${name}" as external because codex-router owns it.`);
    }
    const target = path.join(codexSkillsDir(codexHome), name);
    const skillFile = path.join(target, "SKILL.md");
    const skillStat = lstat(skillFile);
    if (!skillStat?.isFile() || skillStat.isSymbolicLink()) {
      throw new Error(`Cannot approve "${name}": external SKILL.md is missing or not a real file.`);
    }
    const targetDigest = directoryDigest(target);
    const sourceDigest = directoryDigest(path.join(skillsSource(), name));
    if (!targetDigest || !sourceDigest) {
      throw new Error(`Cannot approve "${name}": skill tree contains an unsupported entry.`);
    }
    approvals.push({ name, targetDigest, sourceDigest });
  }
  for (const { name, targetDigest, sourceDigest } of approvals) {
    // Approval explicitly transfers responsibility away from codex-router.
    // Keeping a stale managed token beside the approval could let a replayed
    // marker authorize a later uninstall of the external directory.
    delete ownership.skills[name];
    ownership.external[name] = { targetDigest, sourceDigest };
  }
  writeOwnership(ownership.path, ownership.skills, ownership.external);
  if (!quiet) {
    console.error(
      `codex-router: approved ${approvals.length} external skill(s); exact content changes require re-approval.`,
    );
  }
  return approvals.map(({ name }) => name);
}

function revokeExternalSkillsUnlocked(codexHome, names, { quiet = false } = {}) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("Name at least one external skill approval to revoke.");
  }
  recoverAbandonedSkillRetirements(codexHome);
  const ownership = readOwnership(codexHome);
  if (!ownership.valid) {
    throw new Error("Cannot revoke external skills while private skill state is malformed.");
  }
  const removed = [];
  for (const name of [...new Set(names)]) {
    if (!validSkillName(name)) throw new Error(`Invalid skill name "${name}".`);
    if (ownership.external[name]) {
      delete ownership.external[name];
      removed.push(name);
    }
  }
  if (removed.length > 0 || ownership.exists) {
    writeOwnership(ownership.path, ownership.skills, ownership.external);
  }
  if (!quiet && removed.length > 0) {
    console.error(`codex-router: revoked ${removed.length} external skill approval(s).`);
  }
  return removed;
}

// Compare the installed pack against the checkout. Returns the names of
// skills whose installed content differs from the source (missing, changed,
// or extra files). The root ownership marker alone is ignored.
export function installedSkillsFresh(codexHome) {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) return { fresh: true, stale: [] };
  const stale = [];
  for (const name of packSkillNames()) {
    if (!sameDirContent(path.join(sourceRoot, name), path.join(codexSkillsDir(codexHome), name))) {
      stale.push(name);
    }
  }
  return { fresh: stale.length === 0, stale };
}

function sameDirContent(source, target) {
  const sourceDigest = directoryDigest(source);
  const targetDigest = directoryDigest(target, {
    ignoreRootEntries: [MARKER],
  });
  return Boolean(sourceDigest) && sourceDigest === targetDigest;
}

export function skillPackStatus(codexHome) {
  const pack = packSkillNames();
  const ownership = readOwnership(codexHome);
  const managed = Object.keys(ownership.skills)
    .filter((name) => ownershipEvidence(codexHome, name, ownership).owned)
    .sort();
  const managedSet = new Set(managed);
  const external = pack
    .filter(
      (name) =>
        !managedSet.has(name) && externalEvidence(codexHome, name, ownership).approved,
    )
    .sort();
  const externalSet = new Set(external);
  const missing = pack.filter((name) => !managedSet.has(name) && !externalSet.has(name));
  const collisions = pack.filter(
    (name) =>
      lstat(path.join(codexSkillsDir(codexHome), name)) &&
      !managedSet.has(name) &&
      !externalSet.has(name),
  );
  const staleOwnership = Object.keys(ownership.skills)
    .filter((name) => !managedSet.has(name) || !pack.includes(name))
    .sort();
  const staleExternal = Object.keys(ownership.external)
    .filter((name) => !externalSet.has(name) || !pack.includes(name))
    .sort();
  const stale = managed.filter(
    (name) =>
      pack.includes(name) &&
      !sameDirContent(path.join(skillsSource(), name), path.join(codexSkillsDir(codexHome), name)),
  );
  return {
    pack,
    managed,
    external,
    missing,
    collisions,
    stale,
    staleOwnership,
    staleExternal,
    ownershipStateValid: ownership.valid,
  };
}

export function skillRequiredFields() {
  const source = path.join(skillsSource(), "codex-app-threads", "SKILL.md");
  try {
    const text = readFileSync(source, "utf8");
    const match = /<!--\s*codex-router-required-fields:\s*(\{[\s\S]*?\})\s*-->/.exec(text);
    if (!match) return undefined;
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (Object.keys(parsed).length === 0) return undefined;
    const fields = {};
    for (const [name, required] of Object.entries(parsed)) {
      if (
        !validSkillName(name) ||
        !Array.isArray(required) ||
        required.some((field) => typeof field !== "string" || !field)
      ) {
        return undefined;
      }
      fields[name] = [...new Set(required)];
    }
    return fields;
  } catch {
    return undefined;
  }
}

function installSkillsUnlocked(
  codexHome,
  {
    quiet = false,
    onQuarantined,
    onStaged,
    onPublicationClaimed,
  } = {},
) {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) {
    if (!quiet) {
      console.error("codex-router: no skills/ directory in this checkout; nothing to install.");
    }
    return { installed: 0, skipped: 0, external: 0 };
  }
  const target = codexSkillsDir(codexHome);
  recoverAbandonedSkillRetirements(codexHome);
  mkdirSync(target, { recursive: true });
  const ownership = readOwnership(codexHome);
  const sourceNames = new Set();
  const provenance = sourceProvenance();
  let installed = 0;
  let skipped = 0;
  let external = 0;
  let stateChanged = !ownership.valid;
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || !validSkillName(entry.name)) continue;
    const source = path.join(sourceRoot, entry.name);
    if (!existsSync(path.join(source, "SKILL.md"))) {
      if (!quiet) console.error(`codex-router: skipping ${entry.name} (no SKILL.md).`);
      continue;
    }
    sourceNames.add(entry.name);
    const dest = path.join(target, entry.name);
    const destStat = lstat(dest);
    const evidence = ownershipEvidence(codexHome, entry.name, ownership);
    const coexistence = externalEvidence(codexHome, entry.name, ownership);
    if (destStat && !evidence.owned && coexistence.approved) {
      if (ownership.skills[entry.name]) {
        delete ownership.skills[entry.name];
        stateChanged = true;
      }
      external += 1;
      if (!quiet) {
        console.error(
          `codex-router: using approved external skill "${entry.name}"; content preserved.`,
        );
      }
      continue;
    }
    if (destStat && !evidence.owned) {
      if (ownership.skills[entry.name]) {
        delete ownership.skills[entry.name];
        stateChanged = true;
      }
      if (!quiet) {
        console.error(
          `codex-router: not overwriting existing skill "${entry.name}" (${evidence.reason}); existing content preserved.`,
        );
      }
      skipped += 1;
      continue;
    }
    const token = evidence.owned
      ? ownership.skills[entry.name].token
      : randomBytes(32).toString("hex");
    // Build and validate the complete replacement before moving a working
    // managed skill out of the public namespace.
    const staged = stageManagedSkill(source, dest, entry.name, token, provenance, { onStaged });
    const publicationToken = randomBytes(32).toString("hex");
    let retirement;
    let published = false;
    let ownershipDurable = false;
    try {
      if (destStat) {
        const retired = beginManagedSkillRetirement(codexHome, entry.name, ownership, {
          onQuarantined,
          publicationToken,
          managedToken: token,
          managedDigest: staged.digest,
        });
        if (!retired.retired) {
          delete ownership.skills[entry.name];
          stateChanged = true;
          skipped += 1;
          if (!quiet) {
            console.error(
              `codex-router: not replacing skill "${entry.name}" (${retired.reason}); existing content preserved.`,
            );
          }
          continue;
        }
        retirement = retired.transaction;
      } else {
        retirement = {
          ...beginSkillTransaction(codexHome, entry.name, {
            publicationToken,
            managedToken: token,
            managedDigest: staged.digest,
          }),
          record: undefined,
        };
      }
      const publication = publishStagedSkill(staged, dest, publicationToken, {
        onPublicationClaimed,
      });
      if (!publication.published) {
        const recovery = abandonRetirement(retirement);
        retirement = undefined;
        if (!recovery?.restored) delete ownership.skills[entry.name];
        stateChanged = true;
        skipped += 1;
        if (!quiet) {
          console.error(
            `codex-router: not replacing skill "${entry.name}" (${publication.reason}); existing content preserved.`,
          );
        }
        continue;
      }
      published = true;
      ownership.skills[entry.name] = { token };
      if (ownership.external[entry.name]) delete ownership.external[entry.name];
      // Ownership becomes durable before the previous verified tree is
      // deleted. A crash at either side of this write leaves recoverable data.
      writeOwnership(ownership.path, ownership.skills, ownership.external);
      ownership.exists = true;
      ownership.valid = true;
      stateChanged = false;
      ownershipDurable = true;
      commitRetirement(retirement);
      retirement = undefined;
      installed += 1;
    } catch (error) {
      if (published && !ownershipDurable) {
        const newOwnership = {
          skills: { [entry.name]: { token } },
        };
        const cleanup = beginManagedSkillRetirement(codexHome, entry.name, newOwnership);
        if (cleanup.retired) commitRetirement(cleanup.transaction);
      }
      abandonRetirement(retirement);
      retirement = undefined;
      throw error;
    } finally {
      discardStagedSkill(staged);
      if (retirement) abandonRetirement(retirement);
    }
  }
  for (const name of Object.keys(ownership.skills)) {
    if (sourceNames.has(name)) continue;
    const retired = beginManagedSkillRetirement(codexHome, name, ownership, {
      onQuarantined,
    });
    if (!retired.retired) {
      delete ownership.skills[name];
      stateChanged = true;
      if (!quiet) {
        console.error(
          `codex-router: stale ownership for "${name}" was cleared (${retired.reason}); existing content preserved.`,
        );
      }
      continue;
    }
    try {
      delete ownership.skills[name];
      writeOwnership(ownership.path, ownership.skills, ownership.external);
      ownership.exists = true;
      ownership.valid = true;
      stateChanged = false;
    } catch (error) {
      abandonRetirement(retired.transaction);
      throw error;
    }
    const removed = commitRetirement(retired.transaction);
    if (!quiet) {
      console.error(
        removed
          ? `codex-router: removed stale managed skill "${name}".`
          : `codex-router: stale managed skill "${name}" changed during removal and was preserved.`,
      );
    }
  }
  for (const name of Object.keys(ownership.external)) {
    if (sourceNames.has(name)) continue;
    delete ownership.external[name];
    stateChanged = true;
    if (!quiet) {
      console.error(
        `codex-router: revoked obsolete external approval for "${name}"; existing content preserved.`,
      );
    }
  }
  if (stateChanged || ownership.exists) {
    writeOwnership(ownership.path, ownership.skills, ownership.external);
  }
  return { installed, skipped, external };
}

function uninstallSkillsUnlocked(
  codexHome,
  { quiet = false, onQuarantined } = {},
) {
  recoverAbandonedSkillRetirements(codexHome);
  const ownership = readOwnership(codexHome);
  let removed = 0;
  for (const name of Object.keys(ownership.skills)) {
    const retired = beginManagedSkillRetirement(codexHome, name, ownership, {
      onQuarantined,
    });
    if (!retired.retired) {
      delete ownership.skills[name];
      if (!quiet) {
        console.error(
          `codex-router: not removing skill "${name}" (${retired.reason}); existing content preserved.`,
        );
      }
      continue;
    }
    try {
      delete ownership.skills[name];
      writeOwnership(ownership.path, ownership.skills, ownership.external);
      ownership.exists = true;
      ownership.valid = true;
    } catch (error) {
      abandonRetirement(retired.transaction);
      throw error;
    }
    if (commitRetirement(retired.transaction)) {
      removed += 1;
    } else if (!quiet) {
      console.error(
        `codex-router: not removing skill "${name}" (content changed after quarantine); existing content preserved.`,
      );
    }
  }
  if (ownership.exists || removed > 0 || !ownership.valid) {
    writeOwnership(ownership.path, ownership.skills, ownership.external);
  }
  if (!quiet && removed > 0) {
    console.error(`codex-router: removed ${removed} verified managed skill(s).`);
  }
  return removed;
}

export function approveExternalSkills(codexHome, names, options) {
  return withAtomicStateLock(
    skillOwnershipPath(codexHome),
    () => approveExternalSkillsUnlocked(codexHome, names, options),
    { waitMs: SKILL_OPERATION_LOCK_WAIT_MS },
  );
}

export function revokeExternalSkills(codexHome, names, options) {
  return withAtomicStateLock(
    skillOwnershipPath(codexHome),
    () => revokeExternalSkillsUnlocked(codexHome, names, options),
    { waitMs: SKILL_OPERATION_LOCK_WAIT_MS },
  );
}

export function installSkills(codexHome, options) {
  return withAtomicStateLock(
    skillOwnershipPath(codexHome),
    () => installSkillsUnlocked(codexHome, options),
    { waitMs: SKILL_OPERATION_LOCK_WAIT_MS },
  );
}

export function uninstallSkills(codexHome, options) {
  return withAtomicStateLock(
    skillOwnershipPath(codexHome),
    () => uninstallSkillsUnlocked(codexHome, options),
    { waitMs: SKILL_OPERATION_LOCK_WAIT_MS },
  );
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// The guard matters: `install-manifest.mjs` imports this module, so without
// it any command that transitively pulls the manifest in -- and happens to have
// been invoked with `install` or `uninstall` as its own subcommand -- would
// install the skill pack and `process.exit(0)` before its own work ran.
const [, , command] = process.argv;
const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const commands = ["install", "uninstall", "approve-external", "revoke-external"];
  if (!commands.includes(command)) {
    console.error(
      "Usage: skills-install.mjs install|uninstall|approve-external|revoke-external [SKILL ...]",
    );
    process.exitCode = 2;
  } else {
    try {
      if (command === "install") {
        const { installed, skipped, external } = installSkills(codexHome());
        console.error(
          `codex-router: installed ${installed} skill(s) into ${codexSkillsDir(codexHome())}${
            external ? `, using ${external} approved external skill(s)` : ""
          }${skipped ? `, skipped ${skipped} (existing content preserved)` : ""}.`,
        );
      } else if (command === "uninstall") {
        uninstallSkills(codexHome());
        console.error("codex-router: codex-router skills removed.");
      } else if (command === "approve-external") {
        approveExternalSkills(codexHome(), process.argv.slice(3));
      } else {
        revokeExternalSkills(codexHome(), process.argv.slice(3));
      }
    } catch (error) {
      console.error(`codex-router: skill ${command} failed: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
