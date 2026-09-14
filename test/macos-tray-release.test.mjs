import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checksumForAsset,
  assertNoSymlinks,
  expectedTrayFingerprint,
  macosReleaseAsset,
  releaseAssetUrl,
  sha256File,
  verifyReleaseMetadata,
} from "../src/macos-tray-release.mjs";

test("macOS release asset names are versioned and architecture-neutral", () => {
  assert.equal(
    macosReleaseAsset("1.2.3"),
    "model-router-1.2.3-macos-universal.zip",
  );
  assert.throws(() => macosReleaseAsset("latest"), /Invalid Codex Router version/);
});

test("release URLs are pinned to the matching GitHub tag and asset", () => {
  assert.equal(
    releaseAssetUrl("1.2.3", "SHA256SUMS"),
    "https://github.com/duolahypercho/codex-router/releases/download/v1.2.3/SHA256SUMS",
  );
  assert.throws(
    () => releaseAssetUrl("1.2.3", "asset.zip", "https://example.com/repo"),
    /Invalid GitHub repository/,
  );
});

test("checksum parsing requires one exact release asset name", () => {
  const digest = "a".repeat(64);
  assert.equal(
    checksumForAsset(`${digest}  model-router-1.2.3-macos-universal.zip\n`,
      "model-router-1.2.3-macos-universal.zip"),
    digest,
  );
  assert.throws(
    () => checksumForAsset(`${digest}  other.zip\n`, "app.zip"),
    /has no entry/,
  );
});

test("file checksum uses SHA-256 without loading the complete archive", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "macos-tray-release-test-"));
  try {
    const file = path.join(directory, "asset.zip");
    writeFileSync(file, "codex-router", "utf8");
    assert.equal(
      await sha256File(file),
      "1f3a612c1e044c4dc5d83c23fba177f39e6635e58cc0180ff1f5d9f691abb12a",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("downloaded app trees reject symbolic links", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "macos-tray-tree-test-"));
  try {
    const app = path.join(directory, "Codex Router.app");
    mkdirSync(app);
    writeFileSync(path.join(app, "regular"), "ok", "utf8");
    assert.doesNotThrow(() => assertNoSymlinks(app));
    symlinkSync("regular", path.join(app, "linked"));
    assert.throws(() => assertNoSymlinks(app), /symbolic link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release metadata binds app, Control Center, and tray sources", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "macos-tray-metadata-test-"));
  try {
    mkdirSync(path.join(root, "apps", "control-center"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}\n', "utf8");
    writeFileSync(
      path.join(root, "apps", "control-center", "package.json"),
      '{"version":"1.2.3"}\n',
      "utf8",
    );
    const fingerprint = expectedTrayFingerprint(root);
    const values = new Map([
      ["CFBundleIdentifier", "io.github.codex-router.tray"],
      ["CFBundleShortVersionString", "1.2.3"],
      ["ModelRouterControlVersion", "1.2.3"],
      ["ModelRouterTraySourceFingerprint", fingerprint],
    ]);
    const exec = (_command, args) => `${values.get(args[1].slice("Print :".length))}\n`;
    assert.deepEqual(verifyReleaseMetadata("/staged/Codex Router.app", { root, exec }), {
      version: "1.2.3",
      fingerprint,
    });
    values.set("ModelRouterTraySourceFingerprint", "0".repeat(64));
    assert.throws(
      () => verifyReleaseMetadata("/staged/Codex Router.app", { root, exec }),
      /does not match this checkout's tray sources/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
