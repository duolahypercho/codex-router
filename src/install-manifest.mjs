import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import {
  INSTALL_MANIFEST_PATH,
  SOURCE_ROOT,
  STATE_DIR,
} from "./paths.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";

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
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const temporary = `${INSTALL_MANIFEST_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, INSTALL_MANIFEST_PATH);
  protectPrivateFile(INSTALL_MANIFEST_PATH);
}

export function recordInstall() {
  const previous = readInstallManifest();
  const current = {
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
    packageVersion: packageVersion(),
    installedAt: new Date().toISOString(),
    sourceRoot: SOURCE_ROOT,
    platform: process.platform,
    providers: providerSelectionStatus().providers,
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
