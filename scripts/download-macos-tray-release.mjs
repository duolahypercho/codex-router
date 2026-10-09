#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checksumForAsset,
  assertContainedBundle,
  MACOS_RELEASE_TEAM_ID,
  macosReleaseAsset,
  RELEASE_UNAVAILABLE,
  releaseAssetUrl,
  releaseSignatureRequirement,
  sha256File,
  verifyReleaseMetadata,
} from "../src/macos-tray-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (process.platform !== "darwin" || !target || !path.isAbsolute(target)) {
  console.error("Usage: download-macos-tray-release.mjs /absolute/path/Codex Router.app");
  process.exit(2);
}

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!MACOS_RELEASE_TEAM_ID) {
  console.error("No trusted macOS release signing team is configured; using a local build.");
  process.exit(RELEASE_UNAVAILABLE);
}
const asset = macosReleaseAsset(version);
const temporary = mkdtempSync(path.join(os.tmpdir(), "codex-router-macos-release-"));

function curl(url, output, maxBytes) {
  const result = spawnSync("/usr/bin/curl", [
    "--silent", "--show-error", "--location",
    "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--output", output,
    "--connect-timeout", "15", "--max-time", "180", "--max-filesize", String(maxBytes),
    "--write-out", "%{http_code}", url,
  ], { encoding: "utf8", timeout: 185_000 });
  return { ...result, httpStatus: Number.parseInt(result.stdout, 10) };
}

function download(asset, output) {
  const result = curl(releaseAssetUrl(version, asset), output, asset === "SHA256SUMS" ? 1024 * 1024 : 1024 ** 3);
  if (result.error || result.status !== 0 || result.httpStatus !== 200) {
    const error = new Error(`macOS release ${asset} is unavailable; using a local build.`);
    error.exitCode = RELEASE_UNAVAILABLE;
    throw error;
  }
}

try {
  const sums = path.join(temporary, "SHA256SUMS");
  const archive = path.join(temporary, asset);
  download("SHA256SUMS", sums);
  download(asset, archive);
  const expected = checksumForAsset(readFileSync(sums, "utf8"), asset);
  const actual = await sha256File(archive);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}.`);

  const extracted = path.join(temporary, "extracted");
  mkdirSync(extracted, { mode: 0o700 });
  // bsdtar rejects traversal and refuses writes through archive-created directory links.
  execFileSync("/usr/bin/tar", ["-xf", archive, "-C", extracted, "--no-same-owner"], { stdio: "inherit", timeout: 180_000 });
  const entries = readdirSync(extracted);
  if (entries.length !== 1 || entries[0] !== "Codex Router.app") {
    throw new Error("Downloaded macOS archive does not contain exactly Codex Router.app.");
  }
  const app = path.join(extracted, entries[0]);
  assertContainedBundle(app);
  execFileSync("/usr/bin/codesign", [
    "--verify", "--deep", "--strict", "--verbose=2", app,
  ], { stdio: "inherit", timeout: 60_000 });
  execFileSync("/usr/bin/codesign", [
    "--verify", "--deep", "--strict",
    "--requirements", releaseSignatureRequirement(),
    app,
  ], { stdio: "inherit", timeout: 60_000 });
  execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app], {
    stdio: "inherit", timeout: 60_000,
  });
  verifyReleaseMetadata(app, { root });
  if (existsSync(target)) throw new Error(`Refusing to overwrite staged target ${target}.`);
  execFileSync("/usr/bin/ditto", [app, target], { stdio: "inherit", timeout: 60_000 });
  process.stdout.write(`Downloaded and verified ${asset}.\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error.exitCode === RELEASE_UNAVAILABLE ? RELEASE_UNAVAILABLE : 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
