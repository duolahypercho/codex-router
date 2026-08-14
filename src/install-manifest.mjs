import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import {
  INSTALL_MANIFEST_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";
import { packSkillNames } from "./skills-install.mjs";

function gitValue(args) {
  try {
    return execFileSync("git", ["-C", SOURCE_ROOT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function packageVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

export function readInstallManifest() {
  if (!existsSync(INSTALL_MANIFEST_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(INSTALL_MANIFEST_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function atomicWrite(value) {
  writePrivateJson(INSTALL_MANIFEST_PATH, value, { directoryMode: 0o700 });
}

export function recordInstall() {
  const previous = readInstallManifest();
  // The skills field is derived from the checkout's skills/ directory, not
  // from post-install filesystem state: bin/install records the manifest
  // before the skills step runs, so managedSkillNames() would report the
  // previous run's state. The checkout source is deterministic at this point
  // and correct for provenance, because the skills installed moments later
  // come from that same checkout.
  const skills = {
    names: packSkillNames(),
    count: packSkillNames().length,
  };
  const current = {
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
    packageVersion: packageVersion(),
    installedAt: new Date().toISOString(),
    sourceRoot: SOURCE_ROOT,
    target: TARGET,
    platform: process.platform,
    packageManager: process.env.CODEX_ROUTER_PACKAGE_MANAGER || null,
    providers: providerSelectionStatus().providers,
    skills,
  };
  const previousEntry = previous?.current;
  const history = [
    ...(previousEntry && previousEntry.commit !== current.commit ? [previousEntry] : []),
    ...(previous?.history || []),
  ].slice(0, 10);
  const manifest = { version: 1, current, history };
  atomicWrite(manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  if (command === "record") {
    process.stdout.write(`${JSON.stringify(recordInstall(), null, 2)}\n`);
  } else if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(readInstallManifest() || { installed: false }, null, 2)}\n`,
    );
  } else {
    console.error("Usage: install-manifest.mjs record|status");
    process.exit(2);
  }
}
