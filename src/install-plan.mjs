// Every update runs the whole installer, so the expensive dependency steps are
// gated on a fingerprint of the inputs they consume. A code-only update then
// costs a service restart instead of a full `npm ci` plus a fresh PyPI
// resolution of the LiteLLM proxy tree.
//
// Each stamp lives next to the artifact it describes (`node_modules/`,
// `.venv/`), so deleting the artifact invalidates the stamp automatically and
// no state directory has to stay in sync with the checkout.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { legacyCompanionActions, trayBundleDir } from "./tray-install.mjs";
import {
  automaticTraySupervisionAllowed,
  readTraySupervisionPreference,
  traySupervisionPreferencePath,
} from "./tray-supervision-preference.mjs";
import { venvRuntimeProblem } from "./venv-runtime.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// litellm still needs fastapi<0.140: `get_flat_dependant` was removed in 0.140
// and `litellm/proxy/management_endpoints/management_v1/common.py` imports it,
// so the proxy dies on startup with an ImportError. Its own metadata does not
// say so -- 1.96.0 declares `fastapi<1.0,>=0.136.3` -- which is why the cap is
// held here and why lifting it needs the gateway *booted*, not just resolved.
// Verified against 1.96.0 by starting the proxy on both pins.
//
// The litellm pin itself is a security floor as much as a version: 1.95.0
// required `cryptography>=48.0.1,<49.0`, which no patched cryptography can
// satisfy (GHSA-g6cj-pr64-35w5 is fixed in 50.0.0). Do not move it back.
export const PYTHON_REQUIREMENTS = ["litellm[proxy]==1.96.0", "fastapi==0.139.2"];

// Pinning the two direct requirements left their whole transitive tree floating:
// every install re-resolved `litellm[proxy]` against PyPI and executed whatever
// it got. `requirements/python.txt` is the hash-verified closure of the pins
// above, and both installers now install *from that file* with
// `--require-hashes` instead of naming the packages themselves. That is also
// why the version literals no longer appear in the shell scripts: #114 was
// three copies of one rule drifting apart, and the fix is fewer copies rather
// than more comments asking people to keep them in step.
//
// Slash-separated on purpose. These strings are matched against the text of
// `bin/install` and `install.ps1`, so they must not pick up backslashes when
// the test suite runs on Windows.
export const PYTHON_LOCK = "requirements/python.txt";
export const PYTHON_LOCK_INPUT = "requirements/python.in";

// The lock is universal: one file covering macOS, Linux, and Windows on
// CPython 3.10+, with environment markers selecting per-platform entries. A
// regeneration that drops `--universal` still produces a valid-looking file
// that only resolves on the machine that generated it, so `pythonLockDrift`
// checks the flags uv records in the header as well as the pins. The compile
// command itself lives in `bin/lock-python` and nowhere else.
export const PYTHON_LOCK_SCRIPT = "bin/lock-python";

function repoPath(root, relative) {
  return path.join(root, ...relative.split("/"));
}

const STAMP_NAME = ".codex-router-install.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readFile(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function fileDigest(target) {
  try {
    return sha256(readFileSync(target));
  } catch {
    return sha256("");
  }
}

function regularFileExists(target) {
  try {
    const stat = lstatSync(target);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function realDirectoryExists(target) {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function requirementParts(requirement) {
  const [specifier, version] = String(requirement).split("==");
  return { name: specifier.replace(/\[[^\]]*\]$/, "").trim(), version: (version || "").trim() };
}

function sitePackages(root, platform) {
  if (platform === "win32") return [path.join(root, ".venv", "Lib", "site-packages")];
  const libraries = path.join(root, ".venv", "lib");
  try {
    return readdirSync(libraries)
      .filter((entry) => entry.startsWith("python"))
      .map((entry) => path.join(libraries, entry, "site-packages"));
  } catch {
    return [];
  }
}

// Distribution directories normalize the project name, so `litellm[proxy]`
// installs as `litellm-1.95.0.dist-info`.
export function installedDistributionVersion(name, { root = SOURCE_ROOT, platform = process.platform } = {}) {
  const normalized = name.toLowerCase().replace(/[-_.]+/g, "_");
  for (const directory of sitePackages(root, platform)) {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dist-info")) continue;
      const base = entry.slice(0, -".dist-info".length);
      const separator = base.lastIndexOf("-");
      if (separator <= 0) continue;
      if (base.slice(0, separator).toLowerCase().replace(/[-_.]+/g, "_") === normalized) {
        return base.slice(separator + 1);
      }
    }
  }
  return undefined;
}

function venvPython(root, platform) {
  return platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
}

// uv writes `version_info`, the stdlib venv module writes `version`.
function venvPythonVersion(root) {
  const config = readFile(path.join(root, ".venv", "pyvenv.cfg")) || "";
  const match = config.match(/^\s*version(?:_info)?\s*=\s*(\d+\.\d+)/m);
  return match ? match[1] : "unknown";
}

// The venv records the base interpreter it was created from. If that
// directory was cleared -- macOS periodically wipes /private/tmp, and an
// installer that recorded a temporary Python as the venv home leaves the
// interpreter dangling after reboot -- the venv is unusable even when
// `.venv/bin/python` still resolves through a copied binary. Treat an
// unresolvable home as "not installed" so every install/update rebuilds it.
export function venvPythonHomeUsable(root = SOURCE_ROOT) {
  const config = readFile(path.join(root, ".venv", "pyvenv.cfg")) || "";
  const match = config.match(/^\s*home\s*=\s*(.+)$/m);
  if (!match) return true; // unknown; the interpreter probe decides
  const home = match[1].trim();
  return existsSync(home);
}

// The companion is one bundle per user, not one per checkout: a `dist/` target
// inside the repository produces a separate tray for every clone and leaves
// launchd pointing at whichever one installed last.
function sourceFilesIn(dir, extensions) {
  try {
    return readdirSync(dir)
      .sort()
      .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
      .map((entry) => path.join(dir, entry));
  } catch {
    // A checkout without that companion still answers "no sources".
    return [];
  }
}

function sourceTreeFiles(dir, extensions) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceTreeFiles(candidate, extensions);
        return extensions.length === 0
          || extensions.some((extension) => entry.name.endsWith(extension))
          ? [candidate]
          : [];
      });
  } catch {
    return [];
  }
}

function controlCenterSources(root) {
  const base = path.join(root, "apps", "control-center");
  return [
    // The build entrypoints decide the packaged shape just as much as the
    // renderer and Electron sources do. A changed staging/swap contract must
    // invalidate an installed companion on every platform it can build.
    path.join(root, "scripts", "build-electron-companion.sh"),
    path.join(root, "scripts", "build-electron-companion.ps1"),
    path.join(base, "package.json"),
    path.join(base, "package-lock.json"),
    path.join(base, "electron-builder.yml"),
    path.join(root, "src", "spawnable-command.mjs"),
    path.join(root, "src", "chatgpt-login-lease.mjs"),
    path.join(root, "src", "file-security.mjs"),
    path.join(root, "src", "path-security.mjs"),
    path.join(root, "src", "process-identity.mjs"),
    path.join(base, "index.html"),
    path.join(base, "main.mjs"),
    path.join(base, "vite.config.ts"),
    path.join(base, "tsconfig.json"),
    path.join(base, "tsconfig.node.json"),
    ...sourceTreeFiles(path.join(base, "electron"), [".mjs", ".cjs"]),
    ...sourceTreeFiles(path.join(base, "src"), [
      ".js",
      ".mjs",
      ".json",
      ".ts",
      ".tsx",
      ".css",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
    ]),
    path.join(base, "assets", "icon.png"),
    path.join(base, "assets", "icon.ico"),
  ];
}

// trayDecision offers the companion on macOS, Linux *and* Windows, so all
// three need a staleness answer here. Covering only some would leave the rest
// with the exact drift this gating exists to stop: a companion built once and
// never rebuilt, running against router code it no longer matches. Windows was
// the gap -- recordTrayBuild() threw there, so the one platform whose tray has
// to be built deliberately was also the one that never recorded having been.
const TRAY_PLATFORMS = {
  darwin: {
    sources: (root) => {
      const base = path.join(root, "apps", "macos", "ModelRouterTray");
      const widget = path.join(root, "apps", "macos", "RouterUsageWidget");
      return [
        path.join(root, "scripts", "build-macos-tray-app.sh"),
        path.join(root, "scripts", "build-macos-widget.sh"),
        path.join(root, "src", "macos-developer-tools.mjs"),
        path.join(base, "Package.swift"),
        path.join(base, "Resources", "Info.plist"),
        path.join(base, "Resources", "ModelRouterTray.entitlements"),
        path.join(base, "Resources", "AppIcon.icns"),
        ...sourceFilesIn(path.join(base, "Sources"), [".swift"]),
        // SwiftPM copies this tree recursively into the resource bundle. Every
        // file is a build input regardless of extension, including future icon
        // formats that are not known to this installer yet.
        ...sourceTreeFiles(path.join(base, "Sources", "Resources"), []),
        ...sourceTreeFiles(widget, [
          ".swift",
          ".plist",
          ".entitlements",
          ".pbxproj",
          ".xcscheme",
          ".yml",
        ]),
        ...controlCenterSources(root),
      ];
    },
    artifactRoot: (root, home) => trayBundleDir("darwin", home),
    artifacts: (root, home) => {
      const bundle = trayBundleDir("darwin", home);
      const embedded = path.join(
        bundle,
        "Contents",
        "Resources",
        "Control Center.app",
        "Contents",
      );
      return [
        path.join(bundle, "Contents", "MacOS", "ModelRouterTray"),
        path.join(
          bundle,
          "Contents",
          "PlugIns",
          "RouterUsageWidget.appex",
          "Contents",
          "MacOS",
          "RouterUsageWidget",
        ),
        path.join(embedded, "MacOS", "Codex Router"),
        path.join(embedded, "Resources", "app.asar"),
      ];
    },
    // The source fingerprint is mutable router state, not an app resource.
    // Keeping it inside Contents would invalidate the completed bundle seal.
    stamp: (root, home) => path.join(home, ".codex", "codex-router", "tray-build.json"),
    // Companions built before the per-user move live inside the checkout.
    legacy: (root, home) => [
      path.join(root, "dist", "Model Router.app", "Contents", "MacOS", "ModelRouterTray"),
      path.join(home, "Applications", "Model Router.app"),
    ],
  },
  linux: {
    sources: controlCenterSources,
    artifactRoot: (root) =>
      path.join(root, "apps", "control-center", "release", "linux-unpacked"),
    artifactDirectories: (root) => {
      const apps = path.join(root, "apps");
      const controlCenter = path.join(apps, "control-center");
      const releaseRoot = path.join(controlCenter, "release");
      const release = path.join(releaseRoot, "linux-unpacked");
      return [apps, controlCenter, releaseRoot, release, path.join(release, "resources")];
    },
    artifacts: (root) => {
      const release = path.join(root, "apps", "control-center", "release", "linux-unpacked");
      return [
        path.join(release, "codex-router-control-center"),
        path.join(release, "resources", "app.asar"),
      ];
    },
    // A checkout can contain packages for both operating systems (for
    // example on a shared dual-boot volume). One platform's successful build
    // must not certify the other platform's still-old executable.
    stamp: (root) =>
      path.join(root, "apps", "control-center", ".codex-router-install-linux.json"),
    legacy: (root) => legacyCompanionActions("linux", root).map((action) => action.execute),
  },
  // Same packaged Control Center as Linux; only the artifact path differs.
  win32: {
    sources: controlCenterSources,
    artifactRoot: (root) =>
      path.join(root, "apps", "control-center", "release", "win-unpacked"),
    artifactDirectories: (root) => {
      const apps = path.join(root, "apps");
      const controlCenter = path.join(apps, "control-center");
      const releaseRoot = path.join(controlCenter, "release");
      const release = path.join(releaseRoot, "win-unpacked");
      return [apps, controlCenter, releaseRoot, release, path.join(release, "resources")];
    },
    artifacts: (root) => {
      const release = path.join(root, "apps", "control-center", "release", "win-unpacked");
      return [
        path.join(release, "Codex Router.exe"),
        path.join(release, "resources", "app.asar"),
      ];
    },
    stamp: (root) =>
      path.join(root, "apps", "control-center", ".codex-router-install-win32.json"),
    legacy: (root) => legacyCompanionActions("win32", root).map((action) => action.execute),
  },
};

export function traySourceFingerprint(root = SOURCE_ROOT, platform = process.platform) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) return "";
  return sha256(
    definition
      .sources(root)
      // Hash bytes before combining them. Reading icons as UTF-8 collapsed
      // distinct invalid byte sequences to the same replacement character,
      // so a changed packaged asset could incorrectly look current.
      .map((file) => `${path.relative(root, file)}\0${fileDigest(file)}`)
      .join("\0"),
  );
}

export const STEPS = {
  "node-deps": {
    stamp: (root) => path.join(root, "node_modules", STAMP_NAME),
    fingerprint: (root) =>
      sha256(
        [
          `node:${process.versions.node.split(".")[0]}`,
          readFile(path.join(root, "package-lock.json")) ?? "",
        ].join("\0"),
      ),
    // npm writes this tree summary on every successful install; a partially
    // deleted `node_modules` therefore reads as "not installed".
    installed: (root) => existsSync(path.join(root, "node_modules", ".package-lock.json")),
    skipMessage: "Node dependencies already match package-lock.json; skipping npm ci.",
  },
  "python-deps": {
    stamp: (root) => path.join(root, ".venv", STAMP_NAME),
    // The lock is an input now, not just the two pins. A regenerated lock moves
    // transitive versions while PYTHON_REQUIREMENTS stays put, and without the
    // lock in the fingerprint that update would be skipped as "already matches".
    fingerprint: (root) =>
      sha256(
        [
          `python:${venvPythonVersion(root)}`,
          ...PYTHON_REQUIREMENTS,
          readFile(repoPath(root, PYTHON_LOCK)) ?? "",
        ].join("\0"),
      ),
    installed: (root, platform, { runtimeProblem = venvRuntimeProblem } = {}) => {
      // A venv whose interpreter home was cleared (macOS wipes /private/tmp,
      // and installers that recorded a temporary Python as the venv home end
      // up with a dangling interpreter) must read as "not installed" so the
      // next install/update rebuilds it instead of skipping a broken venv.
      if (!venvPythonHomeUsable(root)) return false;
      const python = venvPython(root, platform);
      if (!existsSync(python)) return false;
      // A launcher can remain after its stdlib or recorded interpreter home
      // has disappeared. Use the same startup probe as doctor/start so an
      // update repairs a venv that exists on disk but cannot execute Python.
      if (runtimeProblem(python)) return false;
      return PYTHON_REQUIREMENTS.every((requirement) => {
        const { name, version } = requirementParts(requirement);
        return installedDistributionVersion(name, { root, platform }) === version;
      });
    },
    skipMessage: "LiteLLM already matches the pinned versions; skipping the Python install.",
  },
};

// Deliberately not a STEPS entry: those treat "artifact missing" as "run", and
// a missing tray means the user never asked for one. An update keeps whatever
// companion the user chose in sync; it never installs a new one.
//   unsupported - no desktop companion for this platform
//   absent      - no companion installed, leave it that way
//   disabled    - the operator explicitly disabled macOS tray supervision
//   unavailable - its managed preference is damaged/unreadable; fail closed
//   skip        - installed and already matches its sources
//   rebuild     - installed but built from different sources
export function trayRebuildPlan({
  root = SOURCE_ROOT,
  platform = process.platform,
  home = os.homedir(),
  supervisionPreference,
} = {}) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) return "unsupported";
  if (platform === "darwin") {
    const preference = supervisionPreference ?? readTraySupervisionPreference({
      file: traySupervisionPreferencePath({ home }),
    });
    if (preference.state === "disabled") return "disabled";
    if (!automaticTraySupervisionAllowed(preference)) return "unavailable";
  }
  const artifacts = definition.artifacts(root, home);
  const artifactDirectories = definition.artifactDirectories?.(root, home) ?? [];
  const complete = artifactDirectories.every((directory) => realDirectoryExists(directory))
    && artifacts.every((artifact) => regularFileExists(artifact));
  if (!complete) {
    // A package root or any one required file is installation evidence. Treat
    // the missing remainder as corruption and rebuild it; calling a partial
    // package "absent" would abandon a tray the user already opted into.
    if (
      existsSync(definition.artifactRoot(root, home))
      || artifacts.some((artifact) => existsSync(artifact))
    ) return "rebuild";
    // A companion at a superseded location still counts as installed, so the
    // update migrates it rather than reading as "absent" and abandoning it.
    const legacy = definition.legacy?.(root, home);
    const candidates = Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
    return candidates.some((candidate) => existsSync(candidate)) ? "rebuild" : "absent";
  }
  const stamp = readFile(definition.stamp(root, home));
  if (!stamp) return "rebuild";
  try {
    return JSON.parse(stamp)?.fingerprint === traySourceFingerprint(root, platform)
      ? "skip"
      : "rebuild";
  } catch {
    return "rebuild";
  }
}

export function recordTrayBuild({
  root = SOURCE_ROOT,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) throw new Error(`The desktop companion is not built on ${platform}.`);
  const target = definition.stamp(root, home);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(
    target,
    `${JSON.stringify({ version: 1, step: "tray", fingerprint: traySourceFingerprint(root, platform) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return target;
}

export function stepStatus(
  step,
  {
    root = SOURCE_ROOT,
    platform = process.platform,
    runtimeProblem = venvRuntimeProblem,
  } = {},
) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  if (!definition.installed(root, platform, { runtimeProblem })) return "run";
  const stamp = readFile(definition.stamp(root));
  if (!stamp) return "run";
  try {
    const parsed = JSON.parse(stamp);
    return parsed?.fingerprint === definition.fingerprint(root) ? "skip" : "run";
  } catch {
    return "run";
  }
}

export function recordStep(step, { root = SOURCE_ROOT } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  const target = definition.stamp(root);
  writeFileSync(
    target,
    `${JSON.stringify({ version: 1, step, fingerprint: definition.fingerprint(root) }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return target;
}

// A pinned line in a pip requirements file: `name[extra]==version`, optionally
// followed by an environment marker and the backslash that continues into the
// `--hash=` lines. A universal lock names the same package more than once when
// the resolution differs per Python version, so versions collect into a list.
const LOCK_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==([^\s;\\]+)/;
const LOCK_HASH = /--hash=sha256:[0-9a-f]{64}/;

// PyPI treats `-`, `_`, and `.` as the same character in a project name, so the
// lock and PYTHON_REQUIREMENTS can spell one package two ways.
function normalizeProject(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// Returns one entry per pinned line: its project, version, and whether the line
// carries at least one hash. An entry without hashes is the failure this whole
// mechanism exists to prevent, so it is reported rather than skipped.
export function parseLock(contents) {
  const entries = [];
  let current;
  for (const line of String(contents).split("\n")) {
    const pin = LOCK_PIN.exec(line);
    if (pin) {
      current = { project: normalizeProject(pin[1]), version: pin[3], hashes: 0 };
      if (LOCK_HASH.test(line)) current.hashes += 1;
      entries.push(current);
      continue;
    }
    if (current && LOCK_HASH.test(line)) current.hashes += 1;
    // A blank line ends the continuation, so a later `--hash` cannot be
    // credited to a requirement it does not belong to.
    if (!line.trim()) current = undefined;
  }
  return entries;
}

// Requirement lines of the compile input, comments and blanks removed.
export function lockInputRequirements(root = SOURCE_ROOT) {
  return (readFile(repoPath(root, PYTHON_LOCK_INPUT)) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// Every way the lock can stop describing PYTHON_REQUIREMENTS. Drift is what
// killed the first attempt at this (#52 pinned a LiteLLM twelve minor versions
// behind main and nothing failed), so each condition returns a sentence rather
// than a boolean.
export function pythonLockDrift(root = SOURCE_ROOT) {
  const problems = [];
  const contents = readFile(repoPath(root, PYTHON_LOCK));
  if (contents === undefined) {
    return [`${PYTHON_LOCK} is missing; regenerate it with ${PYTHON_LOCK_SCRIPT}`];
  }

  const input = lockInputRequirements(root);
  if (input.join("\n") !== PYTHON_REQUIREMENTS.join("\n")) {
    problems.push(
      `${PYTHON_LOCK_INPUT} declares [${input.join(", ")}] but PYTHON_REQUIREMENTS is ` +
        `[${PYTHON_REQUIREMENTS.join(", ")}]`,
    );
  }

  // A lock compiled for one platform installs fine on that platform and fails
  // everywhere else, so the recorded command is part of what has to match.
  const header = contents.split("\n").slice(0, 8).join(" ");
  for (const flag of ["--universal", "--generate-hashes"]) {
    if (!header.includes(flag)) {
      problems.push(`${PYTHON_LOCK} was not generated with ${flag}`);
    }
  }

  const entries = parseLock(contents);
  if (!entries.length) problems.push(`${PYTHON_LOCK} pins no distributions`);
  const unhashed = entries.filter((entry) => entry.hashes === 0);
  if (unhashed.length) {
    problems.push(
      `${PYTHON_LOCK} has ${unhashed.length} requirement(s) without a hash: ` +
        unhashed.map((entry) => `${entry.project}==${entry.version}`).join(", "),
    );
  }

  for (const requirement of PYTHON_REQUIREMENTS) {
    const { name, version } = requirementParts(requirement);
    const locked = entries.filter((entry) => entry.project === normalizeProject(name));
    if (!locked.length) {
      problems.push(`${PYTHON_LOCK} does not pin ${name}`);
      continue;
    }
    const wrong = locked.filter((entry) => entry.version !== version);
    if (wrong.length) {
      problems.push(
        `${PYTHON_LOCK} pins ${name}==${wrong.map((entry) => entry.version).join("/")} ` +
          `but PYTHON_REQUIREMENTS asks for ${version}`,
      );
    }
  }
  return problems;
}

// Each installer installs the Python tree twice: once through uv, once through
// pip for machines without it. Both invocations have to name the lock *and*
// check hashes, so they are counted rather than merely looked for — a script
// where only the uv branch was converted still leaves everyone else unverified.
// Matching on the command shape also keeps prose about `--require-hashes` in
// the surrounding comments from passing for an install.
export function installerPythonInstalls(script) {
  return String(script)
    .split("\n")
    .filter((line) => !/^\s*(#|\s*<#)/.test(line))
    .filter((line) => line.includes("--require-hashes") && line.includes(`-r ${PYTHON_LOCK}`));
}

// The installers no longer repeat the version literals — they install the lock.
export function installerRequirementDrift(root = SOURCE_ROOT) {
  return [path.join("bin", "install"), "install.ps1"].filter(
    (script) => installerPythonInstalls(readFile(path.join(root, script)) ?? "").length !== 2,
  );
}

// Slash-separated for the same reason PYTHON_LOCK is: these are repository
// paths, resolved through repoPath, not host paths.
export const INSTALLER_SCRIPTS = { posix: "bin/install", windows: "install.ps1" };

// Which of the two extracted lines belongs to which branch. `uv pip install`
// and `<python> -m pip install` are disjoint by construction, so neither
// pattern can claim the other's line.
const INSTALL_TOOLS = {
  uv: /(?:^|\s)uv\s+pip\s+install\s/,
  pip: /(?:^|\s)-m\s+pip\s+install\s/,
};

// CI installs the lock by running the installer's *own* command rather than a
// hand-written pip line, so the job cannot pass while the shipped installer
// fails. The line is extracted verbatim by the same matcher
// `installerRequirementDrift` uses, and it is returned ready to execute in the
// checkout root: the posix lines already name `.venv/bin/python`, and the
// PowerShell lines expect the `$Python` that install.ps1 itself defines.
export function pythonInstallCommand(tool, { root = SOURCE_ROOT, platform = "posix" } = {}) {
  const script = INSTALLER_SCRIPTS[platform];
  if (!script) {
    throw new Error(`Unknown installer platform: ${platform} (expected posix or windows)`);
  }
  const pattern = INSTALL_TOOLS[tool];
  if (!pattern) throw new Error(`Unknown install tool: ${tool} (expected uv or pip)`);
  const contents = readFile(repoPath(root, script));
  if (contents === undefined) throw new Error(`${script} is missing`);
  const matches = installerPythonInstalls(contents)
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));
  if (matches.length !== 1) {
    throw new Error(
      `${script} has ${matches.length} hash-checked ${tool} install command(s); expected exactly 1`,
    );
  }
  return matches[0];
}

function main(argv) {
  const [command, step] = argv;
  if (command === "status") {
    // Fail open: an unexpected error must run the step, never skip it.
    let status = "run";
    try {
      status = stepStatus(step);
    } catch {
      status = "run";
    }
    process.stdout.write(`${status}\n`);
    return 0;
  }
  if (command === "record") {
    recordStep(step);
    return 0;
  }
  if (command === "tray-plan") {
    // Fail closed, unlike `status`: an unexpected error must leave the
    // companion alone rather than trigger a Swift build during an update.
    let plan = "absent";
    try {
      plan = trayRebuildPlan();
    } catch {
      plan = "absent";
    }
    process.stdout.write(`${plan}\n`);
    return 0;
  }
  if (command === "record-tray") {
    recordTrayBuild();
    return 0;
  }
  if (command === "requirements") {
    process.stdout.write(`${PYTHON_REQUIREMENTS.join("\n")}\n`);
    return 0;
  }
  // `venv-home-ok` — 0/1 whether the recorded venv interpreter home still
  // exists. The installers use this to decide whether a *present* venv must
  // be cleared and recreated: `status python-deps` already returns "run" for
  // a broken home, but the uv branch only recreates the venv when the python
  // launcher itself is absent, so an existing-but-broken venv would otherwise
  // be pip-installed into without ever rewriting pyvenv.cfg.
  if (command === "venv-home-ok") {
    process.stdout.write(venvPythonHomeUsable() ? "ok\n" : "damaged\n");
    return venvPythonHomeUsable() ? 0 : 1;
  }
  // `python-install-command <uv|pip> [posix|windows]` — what CI runs so that it
  // exercises the shipped installer's command rather than a copy of it.
  if (command === "python-install-command") {
    process.stdout.write(`${pythonInstallCommand(step, { platform: argv[2] || "posix" })}\n`);
    return 0;
  }
  console.error(
    "Usage: install-plan.mjs status|record <node-deps|python-deps> | tray-plan | record-tray | " +
      "requirements | venv-home-ok | python-install-command <uv|pip> [posix|windows]",
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
