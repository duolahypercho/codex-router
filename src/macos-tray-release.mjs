import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { traySourceFingerprint } from "./install-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_UNAVAILABLE = 75;

export function macosReleaseAsset(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Codex Router version: ${version}`);
  }
  return `model-router-${version}-macos-universal.zip`;
}

export function releaseAssetUrl(version, asset, repository = "jiemocoder/codex-router") {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return `https://github.com/${repository}/releases/download/v${version}/${asset}`;
}

export function checksumForAsset(document, asset) {
  for (const line of String(document).split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS has no entry for ${asset}.`);
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

export function assertNoSymlinks(root) {
  const visit = (candidate) => {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) throw new Error("Downloaded macOS app contains a symbolic link.");
    if (stats.isDirectory()) {
      for (const name of readdirSync(candidate)) visit(path.join(candidate, name));
      return;
    }
    if (!stats.isFile()) throw new Error("Downloaded macOS app contains a special file.");
  };
  visit(root);
}

export function expectedTrayFingerprint(root = ROOT) {
  return traySourceFingerprint(root, "darwin");
}

export function plistValue(plist, key, { exec = execFileSync } = {}) {
  return String(exec("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })).trim();
}

export function verifyReleaseMetadata(app, { root = ROOT, exec = execFileSync } = {}) {
  const plist = path.join(app, "Contents", "Info.plist");
  const packageDocument = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const controlDocument = JSON.parse(
    readFileSync(path.join(root, "apps", "control-center", "package.json"), "utf8"),
  );
  const expectedVersion = String(packageDocument.version);
  const actualVersion = plistValue(plist, "CFBundleShortVersionString", { exec });
  const actualControlVersion = plistValue(plist, "ModelRouterControlVersion", { exec });
  const actualFingerprint = plistValue(plist, "ModelRouterTraySourceFingerprint", { exec });
  const identifier = plistValue(plist, "CFBundleIdentifier", { exec });
  if (identifier !== "io.github.codex-router.tray") {
    throw new Error(`Downloaded app has unexpected bundle identifier ${identifier}.`);
  }
  if (actualVersion !== expectedVersion.split("-")[0]) {
    throw new Error(`Downloaded app version ${actualVersion} does not match ${expectedVersion}.`);
  }
  if (actualControlVersion !== String(controlDocument.version)) {
    throw new Error(
      `Downloaded Control Center ${actualControlVersion} does not match ${controlDocument.version}.`,
    );
  }
  const expectedFingerprint = expectedTrayFingerprint(root);
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error("Downloaded macOS app does not match this checkout's tray sources.");
  }
  return { version: expectedVersion, fingerprint: expectedFingerprint };
}
