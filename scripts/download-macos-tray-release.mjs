#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checksumForAsset,
  assertNoSymlinks,
  macosReleaseAsset,
  RELEASE_UNAVAILABLE,
  releaseAssetUrl,
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
const repository = process.env.CODEX_ROUTER_RELEASE_REPOSITORY || "duolahypercho/codex-router";
const asset = macosReleaseAsset(version);
const temporary = mkdtempSync(path.join(os.tmpdir(), "codex-router-macos-release-"));

function curl(url, output) {
  const result = spawnSync("/usr/bin/curl", [
    "--silent", "--show-error", "--location",
    "--proto", "=https", "--tlsv1.2", "--output", output,
    "--write-out", "%{http_code}", url,
  ], { encoding: "utf8" });
  return { ...result, httpStatus: Number.parseInt(result.stdout, 10) };
}

try {
  const sums = path.join(temporary, "SHA256SUMS");
  const archive = path.join(temporary, asset);
  const sumsResult = curl(releaseAssetUrl(version, "SHA256SUMS", repository), sums);
  if (sumsResult.error || sumsResult.status !== 0) {
    throw sumsResult.error || new Error(sumsResult.stderr.trim() || "macOS checksum download failed");
  }
  if (sumsResult.httpStatus !== 200) {
    throw new Error(`GitHub returned HTTP ${sumsResult.httpStatus} for the release checksums.`);
  }
  const assetResult = curl(releaseAssetUrl(version, asset, repository), archive);
  if (assetResult.httpStatus === 404) {
    console.error(`No published macOS companion is available for v${version}; using a local build.`);
    process.exit(RELEASE_UNAVAILABLE);
  }
  if (assetResult.error || assetResult.status !== 0) {
    throw assetResult.error || new Error(assetResult.stderr.trim() || "macOS companion download failed");
  }
  if (assetResult.httpStatus !== 200) {
    throw new Error(`GitHub returned HTTP ${assetResult.httpStatus} for ${asset}.`);
  }
  const expected = checksumForAsset(readFileSync(sums, "utf8"), asset);
  const actual = await sha256File(archive);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}.`);

  const extracted = path.join(temporary, "extracted");
  mkdirSync(extracted, { mode: 0o700 });
  execFileSync("/usr/bin/ditto", ["-x", "-k", archive, extracted], { stdio: "inherit" });
  const entries = readdirSync(extracted);
  if (entries.length !== 1 || entries[0] !== "Codex Router.app") {
    throw new Error("Downloaded macOS archive does not contain exactly Codex Router.app.");
  }
  const app = path.join(extracted, entries[0]);
  assertNoSymlinks(app);
  verifyReleaseMetadata(app, { root });
  execFileSync("/usr/bin/codesign", [
    "--verify", "--deep", "--strict", "--verbose=2", app,
  ], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", [
    "--verify", "--deep", "--strict",
    "--requirements", "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    app,
  ], { stdio: "inherit" });
  execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app], {
    stdio: "inherit",
  });
  if (existsSync(target)) throw new Error(`Refusing to overwrite staged target ${target}.`);
  execFileSync("/usr/bin/ditto", [app, target], { stdio: "inherit" });
  process.stdout.write(`Downloaded and verified ${asset}.\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
