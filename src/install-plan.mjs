// Every update runs the whole installer, so the expensive dependency steps are
// gated on a fingerprint of the inputs they consume. A code-only update then
// costs a service restart instead of a full `npm ci` plus a fresh PyPI
// resolution of the LiteLLM proxy tree.
//
// Each stamp lives next to the artifact it describes (`node_modules/`,
// `.venv/`), so deleting the artifact invalidates the stamp automatically and
// no state directory has to stay in sync with the checkout.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// litellm 1.95.0 needs fastapi<0.140 (get_flat_dependant was removed); re-test
// before lifting either pin. bin/install and install.ps1 repeat these literals
// so both scripts stay readable; `installerRequirementDrift` fails the test
// suite if a copy is edited alone.
export const PYTHON_REQUIREMENTS = ["litellm[proxy]==1.95.0", "fastapi==0.139.2"];

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
    fingerprint: (root) =>
      sha256([`python:${venvPythonVersion(root)}`, ...PYTHON_REQUIREMENTS].join("\0")),
    installed: (root, platform) => {
      if (!existsSync(venvPython(root, platform))) return false;
      return PYTHON_REQUIREMENTS.every((requirement) => {
        const { name, version } = requirementParts(requirement);
        return installedDistributionVersion(name, { root, platform }) === version;
      });
    },
    skipMessage: "LiteLLM already matches the pinned versions; skipping the Python install.",
  },
};

export function stepStatus(step, { root = SOURCE_ROOT, platform = process.platform } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  if (!definition.installed(root, platform)) return "run";
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

// The installers hold the pins as literals so the shell stays readable; this
// check keeps those copies identical to PYTHON_REQUIREMENTS.
export function installerRequirementDrift(root = SOURCE_ROOT) {
  return [path.join("bin", "install"), "install.ps1"].filter((script) => {
    const contents = readFile(path.join(root, script)) ?? "";
    return !PYTHON_REQUIREMENTS.every((requirement) => contents.includes(requirement));
  });
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
  if (command === "requirements") {
    process.stdout.write(`${PYTHON_REQUIREMENTS.join("\n")}\n`);
    return 0;
  }
  console.error("Usage: install-plan.mjs status|record <node-deps|python-deps> | requirements");
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
