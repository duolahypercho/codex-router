// Install the codex-router skill pack into the Codex app's user-skill
// directory. The pack teaches custom routed models how to use the app's
// native tools; it never touches official plugins or any other user skill.
//
// A visible marker is not ownership proof: users and other tools can create
// that filename too. Replacement and removal require a random token to match
// both the marker and a protected ownership file under codex-router's private
// state directory. Unknown files, symlinks, directories, and legacy markers
// are always preserved.
//
// CLI: node src/skills-install.mjs install|uninstall
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { CODEX_HOME, SKILL_OWNERSHIP_PATH } from "./paths.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".codex-router-managed";
const OWNERSHIP_VERSION = 1;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

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

function readOwnership(codexHome) {
  const target = skillOwnershipPath(codexHome);
  const targetStat = lstat(target);
  if (!targetStat) {
    return { exists: false, valid: true, path: target, skills: emptySkills() };
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    return { exists: true, valid: false, path: target, skills: emptySkills() };
  }
  if (!privateFileIsProtected(target)) {
    return { exists: true, valid: false, path: target, skills: emptySkills() };
  }
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (
      parsed?.version !== OWNERSHIP_VERSION ||
      !parsed.skills ||
      typeof parsed.skills !== "object" ||
      Array.isArray(parsed.skills)
    ) {
      return { exists: true, valid: false, path: target, skills: emptySkills() };
    }
    const skills = emptySkills();
    let valid = true;
    for (const [name, record] of Object.entries(parsed.skills)) {
      if (!validSkillName(name) || !validToken(record?.token)) {
        valid = false;
        continue;
      }
      skills[name] = { token: record.token };
    }
    return {
      exists: true,
      valid,
      path: target,
      skills: valid ? skills : emptySkills(),
    };
  } catch {
    return { exists: true, valid: false, path: target, skills: emptySkills() };
  }
}

function writeOwnership(target, skills) {
  const stateDir = path.dirname(target);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: OWNERSHIP_VERSION, skills }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

function parseMarker(target) {
  const markerPath = path.join(target, MARKER);
  const markerStat = lstat(markerPath);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
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

function ownershipEvidence(codexHome, name, ownership) {
  const record = ownership.skills[name];
  if (!record) return { owned: false, reason: "not recorded" };
  const target = path.join(codexSkillsDir(codexHome), name);
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

function sameDirContent(source, target, root = true) {
  try {
    const sourceStat = lstatSync(source);
    const targetStat = lstatSync(target);
    if (
      !sourceStat.isDirectory() ||
      sourceStat.isSymbolicLink() ||
      !targetStat.isDirectory() ||
      targetStat.isSymbolicLink()
    ) {
      return false;
    }
    const entries = (dir) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !(root && entry.name === MARKER))
        .map((entry) => entry.name)
        .sort();
    const sourceNames = entries(source);
    const targetNames = entries(target);
    if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) return false;
    for (const name of sourceNames) {
      const sourcePath = path.join(source, name);
      const targetPath = path.join(target, name);
      const a = lstatSync(sourcePath);
      const b = lstatSync(targetPath);
      if (a.isSymbolicLink() || b.isSymbolicLink()) return false;
      if (a.isDirectory() || b.isDirectory()) {
        if (!a.isDirectory() || !b.isDirectory()) return false;
        if (!sameDirContent(sourcePath, targetPath, false)) return false;
      } else if (a.isFile() || b.isFile()) {
        if (!a.isFile() || !b.isFile()) return false;
        if (!readFileSync(sourcePath).equals(readFileSync(targetPath))) return false;
      } else {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function skillPackStatus(codexHome) {
  const pack = packSkillNames();
  const ownership = readOwnership(codexHome);
  const managed = Object.keys(ownership.skills)
    .filter((name) => ownershipEvidence(codexHome, name, ownership).owned)
    .sort();
  const managedSet = new Set(managed);
  const missing = pack.filter((name) => !managedSet.has(name));
  const collisions = pack.filter(
    (name) => lstat(path.join(codexSkillsDir(codexHome), name)) && !managedSet.has(name),
  );
  const staleOwnership = Object.keys(ownership.skills)
    .filter((name) => !managedSet.has(name) || !pack.includes(name))
    .sort();
  const stale = managed.filter(
    (name) =>
      pack.includes(name) &&
      !sameDirContent(path.join(skillsSource(), name), path.join(codexSkillsDir(codexHome), name)),
  );
  return {
    pack,
    managed,
    missing,
    collisions,
    stale,
    staleOwnership,
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

export function installSkills(codexHome, { quiet = false } = {}) {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) {
    if (!quiet) {
      console.error("codex-router: no skills/ directory in this checkout; nothing to install.");
    }
    return { installed: 0, skipped: 0 };
  }
  const target = codexSkillsDir(codexHome);
  mkdirSync(target, { recursive: true });
  const ownership = readOwnership(codexHome);
  const sourceNames = new Set();
  const provenance = sourceProvenance();
  let installed = 0;
  let skipped = 0;
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
    const token = evidence.owned ? ownership.skills[entry.name].token : randomBytes(32).toString("hex");
    if (destStat) rmSync(dest, { recursive: true, force: true });
    cpSync(source, dest, { recursive: true });
    writeFileSync(path.join(dest, MARKER), markerContent(entry.name, token, provenance));
    ownership.skills[entry.name] = { token };
    stateChanged = true;
    installed += 1;
  }
  for (const name of Object.keys(ownership.skills)) {
    if (sourceNames.has(name)) continue;
    const evidence = ownershipEvidence(codexHome, name, ownership);
    if (evidence.owned) {
      rmSync(path.join(target, name), { recursive: true, force: true });
      if (!quiet) console.error(`codex-router: removed stale managed skill "${name}".`);
    } else if (!quiet) {
      console.error(
        `codex-router: stale ownership for "${name}" was cleared (${evidence.reason}); existing content preserved.`,
      );
    }
    delete ownership.skills[name];
    stateChanged = true;
  }
  if (stateChanged || ownership.exists) writeOwnership(ownership.path, ownership.skills);
  return { installed, skipped };
}

export function uninstallSkills(codexHome, { quiet = false } = {}) {
  const ownership = readOwnership(codexHome);
  let removed = 0;
  for (const name of Object.keys(ownership.skills)) {
    const evidence = ownershipEvidence(codexHome, name, ownership);
    if (evidence.owned) {
      rmSync(path.join(codexSkillsDir(codexHome), name), { recursive: true, force: true });
      removed += 1;
    } else if (!quiet) {
      console.error(
        `codex-router: not removing skill "${name}" (${evidence.reason}); existing content preserved.`,
      );
    }
    delete ownership.skills[name];
  }
  if (ownership.exists || removed > 0 || !ownership.valid) {
    writeOwnership(ownership.path, ownership.skills);
  }
  if (!quiet && removed > 0) {
    console.error(`codex-router: removed ${removed} verified managed skill(s).`);
  }
  return removed;
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
if (invokedDirectly && (command === "install" || command === "uninstall")) {
  try {
    if (command === "install") {
      const { installed, skipped } = installSkills(codexHome());
      console.error(
        `codex-router: installed ${installed} skill(s) into ${codexSkillsDir(codexHome())}${
          skipped ? `, skipped ${skipped} (existing content preserved)` : ""
        }.`,
      );
    } else {
      uninstallSkills(codexHome());
      console.error("codex-router: codex-router skills removed.");
    }
  } catch (error) {
    // Best effort: a skill install failure must never roll back the router.
    console.error(`codex-router: skill ${command} failed: ${error.message}`);
  }
  process.exit(0);
}
