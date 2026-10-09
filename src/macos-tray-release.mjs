import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { traySourceFingerprint } from "./install-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_UNAVAILABLE = 75;
// Set only after the maintainer verifies the project's Developer ID team.
export const MACOS_RELEASE_TEAM_ID = "";
export const MACOS_RELEASE_REPOSITORY = "duolahypercho/codex-router";

export function releaseSignatureRequirement(teamId = MACOS_RELEASE_TEAM_ID) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("No trusted macOS release signing team is configured.");
  return `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

export function macosReleaseAsset(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Codex Router version: ${version}`);
  }
  return `model-router-${version}-macos-universal.zip`;
}

export function releaseAssetUrl(version, asset) {
  if (![macosReleaseAsset(version), "SHA256SUMS"].includes(asset)) throw new Error("Unexpected macOS release asset.");
  return `https://github.com/${MACOS_RELEASE_REPOSITORY}/releases/download/v${version}/${asset}`;
}

export function checksumForAsset(document, asset) {
  const matches = [];
  for (const line of String(document).split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === asset) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) throw new Error(`SHA256SUMS must have exactly one entry for ${asset}.`);
  return matches[0];
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

export function assertContainedBundle(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error("Downloaded app root is a symbolic link.");
  const base = realpathSync(root);
  const visit = (candidate) => {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(candidate);
      const resolved = realpathSync(candidate);
      if (path.isAbsolute(target) || !resolved.startsWith(`${base}${path.sep}`)) {
        throw new Error("Downloaded macOS app contains an escaping symbolic link.");
      }
      return;
    }
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
    const error = new Error("Downloaded macOS app does not match this checkout's tray sources; using a local build.");
    error.exitCode = RELEASE_UNAVAILABLE;
    throw error;
  }
  return { version: expectedVersion, fingerprint: expectedFingerprint };
}
