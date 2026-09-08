import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  recordTrayBuild,
  traySourceFingerprint,
  trayRebuildPlan,
} from "../src/install-plan.mjs";
import { trayBundleDir } from "../src/tray-install.mjs";
import {
  inspectMacosTrayCommittedBundle,
  inspectMacosTrayLiveBundle,
  inspectMacosTrayTransaction,
  planMacosTrayRecovery,
} from "../src/macos-tray-transaction.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "tray-rebuild-"));
}

function writePrivateLine(file, value) {
  writeFileSync(file, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

function macosTransactionFixture({
  phase = "replacement-installed",
  hadPrevious = true,
  live = true,
  previous = true,
  failed = false,
  targetName,
  artifactSet,
} = {}) {
  const parent = scratch();
  const transaction = path.join(parent, ".model-router-tray-transaction");
  const bundle = path.join(parent, "Codex Router.app");
  mkdirSync(transaction, { mode: 0o700 });
  chmodSync(transaction, 0o700);
  mkdirSync(path.join(transaction, "staged"), { mode: 0o700 });
  chmodSync(path.join(transaction, "staged"), 0o700);
  writePrivateLine(path.join(transaction, "phase"), phase);
  writePrivateLine(path.join(transaction, "had-previous"), hadPrevious ? "1" : "0");
  if (targetName !== undefined) {
    writePrivateLine(path.join(transaction, "target-name"), targetName);
  }
  if (artifactSet !== undefined) {
    writePrivateLine(path.join(transaction, "artifact-set"), artifactSet);
  }
  if (live) mkdirSync(bundle, { mode: 0o755 });
  if (previous) mkdirSync(path.join(transaction, "previous"), { mode: 0o755 });
  if (failed) mkdirSync(path.join(transaction, "failed"), { mode: 0o755 });
  return { parent, transaction, bundle };
}

function installCompleteMacosTrayBundle(bundle, { includeWidget = true } = {}) {
  mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    path.join(bundle, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>io.github.codex-router.tray</string></dict></plist>",
    "utf8",
  );
  const nativeBinary = path.join(bundle, "Contents", "MacOS", "ModelRouterTray");
  writeFileSync(nativeBinary, "binary", "utf8");
  chmodSync(nativeBinary, 0o755);
  if (includeWidget) {
    const widgetBinary = path.join(
      bundle,
      "Contents",
      "PlugIns",
      "RouterUsageWidget.appex",
      "Contents",
      "MacOS",
      "RouterUsageWidget",
    );
    mkdirSync(path.dirname(widgetBinary), { recursive: true });
    writeFileSync(
      path.join(
        bundle,
        "Contents",
        "PlugIns",
        "RouterUsageWidget.appex",
        "Contents",
        "Info.plist",
      ),
      "<plist><dict><key>CFBundleIdentifier</key><string>io.github.codex-router.tray.widget</string></dict></plist>",
      "utf8",
    );
    writeFileSync(widgetBinary, "widget", "utf8");
    chmodSync(widgetBinary, 0o755);
  }
  const embedded = path.join(
    bundle,
    "Contents",
    "Resources",
    "Control Center.app",
    "Contents",
  );
  mkdirSync(path.join(embedded, "MacOS"), { recursive: true });
  mkdirSync(path.join(embedded, "Resources"), { recursive: true });
  const embeddedBinary = path.join(embedded, "MacOS", "Codex Router");
  writeFileSync(embeddedBinary, "binary", "utf8");
  chmodSync(embeddedBinary, 0o755);
  writeFileSync(path.join(embedded, "Resources", "app.asar"), "archive", "utf8");
  return bundle;
}

function installTrayAt(home) {
  return installCompleteMacosTrayBundle(trayBundleDir("darwin", home));
}

function installPackagedControlCenter(fakeRoot, platform) {
  const [directory, executable] = platform === "win32"
    ? ["win-unpacked", "Codex Router.exe"]
    : ["linux-unpacked", "codex-router-control-center"];
  const release = path.join(fakeRoot, "apps", "control-center", "release", directory);
  mkdirSync(path.join(release, "resources"), { recursive: true });
  writeFileSync(path.join(release, executable), "binary", "utf8");
  writeFileSync(path.join(release, "resources", "app.asar"), "archive", "utf8");
  return release;
}

test("a machine without a companion is left without one", () => {
  const home = scratch();
  // A clean root, not the repository: a developer checkout may still hold a
  // pre-migration dist/ bundle, which legitimately reads as "rebuild".
  const fakeRoot = scratch();
  try {
    // An update keeps whatever the user chose in sync. It must never install a
    // menu-bar app for someone who never asked for one.
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "darwin", home }), "absent");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("an installed companion matching its sources is not rebuilt", () => {
  const home = scratch();
  try {
    installTrayAt(home);
    recordTrayBuild({ root, platform: "darwin", home });
    assert.equal(trayRebuildPlan({ root, platform: "darwin", home }), "skip");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("changed Swift sources make an installed companion stale", () => {
  const home = scratch();
  const fakeRoot = scratch();
  const sources = path.join(fakeRoot, "apps", "macos", "ModelRouterTray", "Sources");
  try {
    mkdirSync(sources, { recursive: true });
    writeFileSync(path.join(sources, "App.swift"), "let version = 1\n", "utf8");
    installTrayAt(home);
    recordTrayBuild({ root: fakeRoot, platform: "darwin", home });
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "darwin", home }), "skip");

    writeFileSync(path.join(sources, "App.swift"), "let version = 2\n", "utf8");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "darwin", home }), "rebuild");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("a companion left inside a checkout is migrated, not abandoned", () => {
  const home = scratch();
  const fakeRoot = scratch();
  try {
    // Builds from before the per-user move live at <checkout>/dist. Reading
    // those as "absent" would leave an unmanaged copy running forever.
    const legacy = path.join(fakeRoot, "dist", "Model Router.app", "Contents", "MacOS");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "ModelRouterTray"), "old binary", "utf8");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "darwin", home }), "rebuild");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("the old user-level app name is migration evidence, not an absent tray", () => {
  const home = scratch();
  const fakeRoot = scratch();
  try {
    mkdirSync(path.join(home, "Applications", "Model Router.app"), { recursive: true });
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "darwin", home }), "rebuild");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

// Windows has a companion now, and it is the one platform whose tray must be
// built deliberately -- so it was also the one that never recorded having been
// built, and every update would have rebuilt it from scratch.
test("a Windows companion is kept in sync like the others", () => {
  const home = scratch();
  const fakeRoot = scratch();
  const release = path.join(fakeRoot, "apps", "control-center", "release", "win-unpacked");
  const electron = path.join(fakeRoot, "apps", "control-center", "electron");
  try {
    mkdirSync(electron, { recursive: true });
    writeFileSync(path.join(electron, "main.mjs"), "const version = 1;\n", "utf8");

    // Nothing built yet: an update must not install one unasked.
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "win32", home }), "absent");

    installPackagedControlCenter(fakeRoot, "win32");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "win32", home }), "rebuild");

    recordTrayBuild({ root: fakeRoot, platform: "win32", home });
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "win32", home }), "skip");

    writeFileSync(path.join(electron, "main.mjs"), "const version = 2;\n", "utf8");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "win32", home }), "rebuild");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("a platform with no companion at all stays unsupported", () => {
  assert.equal(trayRebuildPlan({ root, platform: "aix", home: scratch() }), "unsupported");
});

// trayDecision offers the companion on Linux too. Answering "unsupported"
// there left Linux users with the drift this gating exists to prevent.
test("a Linux companion is kept in sync like the macOS one", () => {
  const home = scratch();
  const fakeRoot = scratch();
  const release = path.join(fakeRoot, "apps", "control-center", "release", "linux-unpacked");
  const electron = path.join(fakeRoot, "apps", "control-center", "electron");
  try {
    mkdirSync(electron, { recursive: true });
    writeFileSync(path.join(electron, "main.mjs"), "const version = 1;\n", "utf8");

    // Nothing built yet: an update must not install one unasked, same as macOS.
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "absent");

    installPackagedControlCenter(fakeRoot, "linux");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "rebuild");

    recordTrayBuild({ root: fakeRoot, platform: "linux", home });
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "skip");

    writeFileSync(path.join(electron, "main.mjs"), "const version = 2;\n", "utf8");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "rebuild");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("a complete legacy Electron runtime is migration evidence, never deletion evidence", () => {
  const home = scratch();
  const fakeRoot = scratch();
  try {
    for (const [platform, executable] of [["linux", "electron"], ["win32", "electron.exe"]]) {
      const dependency = path.join(
        fakeRoot,
        "apps",
        "electron",
        "node_modules",
        "electron",
        "dist",
        executable,
      );
      mkdirSync(path.dirname(dependency), { recursive: true });
      writeFileSync(dependency, "npm dependency", "utf8");
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: platform, home }),
        "rebuild",
        `${platform} must migrate the repository-known legacy Electron action`,
      );
      rmSync(dependency, { force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("a stamped but incomplete packaged companion is rebuilt on every desktop platform", () => {
  const cases = [
    {
      platform: "darwin",
      install(fakeRoot, home) {
        const bundle = installTrayAt(home);
        return path.join(
          bundle,
          "Contents",
          "Resources",
          "Control Center.app",
          "Contents",
          "Resources",
          "app.asar",
        );
      },
    },
    {
      platform: "linux",
      install(fakeRoot) {
        const release = installPackagedControlCenter(fakeRoot, "linux");
        return path.join(release, "resources", "app.asar");
      },
    },
    {
      platform: "win32",
      install(fakeRoot) {
        const release = installPackagedControlCenter(fakeRoot, "win32");
        return path.join(release, "resources", "app.asar");
      },
    },
  ];

  for (const item of cases) {
    const fakeRoot = scratch();
    const home = scratch();
    try {
      const requiredArtifact = item.install(fakeRoot, home);
      recordTrayBuild({ root: fakeRoot, platform: item.platform, home });
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: item.platform, home }),
        "skip",
        `${item.platform} complete package should match its stamp`,
      );
      rmSync(requiredArtifact, { force: true });
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: item.platform, home }),
        "rebuild",
        `${item.platform} must not trust a stamp after app.asar disappears`,
      );
      mkdirSync(requiredArtifact, { recursive: true });
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: item.platform, home }),
        "rebuild",
        `${item.platform} must not treat an app.asar directory as a packaged archive`,
      );
      rmSync(requiredArtifact, { recursive: true, force: true });
      writeFileSync(requiredArtifact, "");
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: item.platform, home }),
        "rebuild",
        `${item.platform} must not treat an empty app.asar as a complete package`,
      );
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("Windows and Linux never trust linked package ancestors or resources", () => {
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  for (const platform of ["linux", "win32"]) {
    const fakeRoot = scratch();
    const home = scratch();
    const externalPackageRoot = scratch();
    const externalResources = scratch();
    const externalReleaseRoot = scratch();
    try {
      const [directory, executable] = platform === "win32"
        ? ["win-unpacked", "Codex Router.exe"]
        : ["linux-unpacked", "codex-router-control-center"];
      const releaseParent = path.join(fakeRoot, "apps", "control-center", "release");
      const packageRoot = path.join(releaseParent, directory);
      mkdirSync(releaseParent, { recursive: true });

      mkdirSync(path.join(externalPackageRoot, "resources"), { recursive: true });
      writeFileSync(path.join(externalPackageRoot, executable), "binary");
      writeFileSync(path.join(externalPackageRoot, "resources", "app.asar"), "archive");
      symlinkSync(externalPackageRoot, packageRoot, directoryLinkType);
      recordTrayBuild({ root: fakeRoot, platform, home });
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: platform, home }),
        "rebuild",
        `${platform} must not certify a linked package root`,
      );

      rmSync(packageRoot, { force: true });
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(packageRoot, executable), "binary");
      writeFileSync(path.join(externalResources, "app.asar"), "archive");
      symlinkSync(externalResources, path.join(packageRoot, "resources"), directoryLinkType);
      recordTrayBuild({ root: fakeRoot, platform, home });
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: platform, home }),
        "rebuild",
        `${platform} must not certify a linked resources directory`,
      );

      rmSync(releaseParent, { recursive: true, force: true });
      const externalPackage = path.join(externalReleaseRoot, directory);
      mkdirSync(path.join(externalPackage, "resources"), { recursive: true });
      writeFileSync(path.join(externalPackage, executable), "binary");
      writeFileSync(path.join(externalPackage, "resources", "app.asar"), "archive");
      symlinkSync(externalReleaseRoot, releaseParent, directoryLinkType);
      recordTrayBuild({ root: fakeRoot, platform, home });
      assert.equal(
        trayRebuildPlan({ root: fakeRoot, platform: platform, home }),
        "rebuild",
        `${platform} must not certify a linked release ancestor`,
      );
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(externalPackageRoot, { recursive: true, force: true });
      rmSync(externalResources, { recursive: true, force: true });
      rmSync(externalReleaseRoot, { recursive: true, force: true });
    }
  }
});

test("each companion fingerprints its own sources", () => {
  // A shared fingerprint would make a Swift edit look like a reason to rebuild
  // the Tauri app, and vice versa.
  assert.notEqual(
    traySourceFingerprint(root, "darwin"),
    traySourceFingerprint(root, "linux"),
  );
  assert.notEqual(
    traySourceFingerprint(root, "darwin"),
    traySourceFingerprint(root, "win32"),
  );
  // Windows and Linux package the same Control Center, so they deliberately
  // agree: one Electron or renderer edit makes both stale.
  assert.equal(
    traySourceFingerprint(root, "win32"),
    traySourceFingerprint(root, "linux"),
  );
  assert.notEqual(traySourceFingerprint(root, "win32"), "");
  // A platform with no companion has nothing to fingerprint.
  assert.equal(traySourceFingerprint(root, "aix"), "");
});

test("the macOS tray fingerprint includes its full-Xcode resolver", () => {
  const fakeRoot = scratch();
  try {
    const resolver = path.join(fakeRoot, "src", "macos-developer-tools.mjs");
    mkdirSync(path.dirname(resolver), { recursive: true });
    writeFileSync(resolver, "before\n", "utf8");
    const before = traySourceFingerprint(fakeRoot, "darwin");
    writeFileSync(resolver, "after\n", "utf8");
    assert.notEqual(traySourceFingerprint(fakeRoot, "darwin"), before);
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("one companion location: the Node and shell sides name the same directory", () => {
  // Three copies of this path drifted apart before -- paths.mjs, the build
  // script default, and trayBundleDir -- which is how a machine ends up with a
  // separate tray per checkout and launchd pointing at whichever built last.
  const script = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  assert.match(script, /bundle_dir=\$\{1:-"\$HOME\/Applications\/Codex Router\.app"\}/);
  assert.equal(trayBundleDir("darwin", "/Users/example"), "/Users/example/Applications/Codex Router.app");
  assert.doesNotMatch(script, /\$repo_dir\/dist\/Model Router\.app"\}/);
});

test("the macOS tray is signed only after its resources are assembled", () => {
  const script = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  const resource = script.indexOf('Add :ModelRouterSourceRoot string $repo_dir');
  const storageMode = script.indexOf('Set :ModelRouterWidgetStorageMode $widget_storage_mode');
  const firstSign = script.indexOf('/usr/bin/codesign --force --deep --sign "$signing_identity"');
  const sign = script.indexOf('--entitlements "$tray_dir/Resources/ModelRouterTray.entitlements"');
  const verify = script.indexOf('/usr/bin/codesign --verify --deep --strict "$bundle_dir"');
  assert.ok(resource >= 0, "the checkout link must be placed in the bundle");
  assert.match(script, /trap cleanup_electron_output EXIT/);
  assert.match(script, /trap 'exit 129' HUP/);
  assert.match(script, /trap 'exit 130' INT/);
  assert.match(script, /trap 'exit 143' TERM/);
  assert.doesNotMatch(script, /trap cleanup_electron_output EXIT HUP INT TERM/);
  assert.match(script, /Contents\/Resources\/Control Center\.app/);
  assert.match(script, /electron-builder[\s\S]*--mac dir/);
  assert.match(script, /Control Center\.app\/Contents\/Resources\/router-root/);
  assert.match(script, /MODEL_ROUTER_CODESIGN_IDENTITY/);
  assert.match(script, /widget_storage_mode=local/);
  assert.match(script, /RouterUsageWidget\.local\.entitlements/);
  assert.match(script, /widget_storage_mode=app-group/);
  assert.match(script, /RouterUsageWidget\.entitlements/);
  assert.ok(storageMode > resource, "the signed storage mode must follow bundle assembly");
  assert.ok(firstSign > storageMode, "no nested signature may precede the final plist mutation");
  assert.ok(sign > resource, "signing must happen after the final resource write");
  assert.ok(verify > sign, "the completed signature must be verified");
  assert.doesNotMatch(
    script,
    /cp -R .*ModelRouterTray_ModelRouterTray\.bundle" "\$bundle_dir\/"/,
    "the SwiftPM resource bundle belongs only under Contents/Resources",
  );
});

test("the macOS tray fingerprint stays outside the signed app bundle", () => {
  const home = scratch();
  try {
    installTrayAt(home);
    const stamp = recordTrayBuild({ root, platform: "darwin", home });
    assert.equal(stamp, path.join(home, ".codex", "codex-router", "tray-build.json"));
    assert.doesNotMatch(stamp, /Model Router\.app/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the macOS swap recovery planner stays deterministic without filesystem semantics", () => {
  assert.equal(
    planMacosTrayRecovery({
      phase: "replacement-installed",
      hadPrevious: true,
      previous: true,
      failed: false,
    }, { liveExists: true }),
    "replace-live-with-previous",
  );
  assert.equal(
    planMacosTrayRecovery({
      phase: "staged",
      hadPrevious: true,
      previous: false,
      failed: false,
    }, { liveExists: true }),
    "keep-live-intact",
  );
  assert.equal(
    planMacosTrayRecovery({
      phase: "staged",
      hadPrevious: true,
      previous: false,
      failed: false,
    }, { liveExists: false, legacyLiveExists: true }),
    "keep-live-intact",
    "an unmarked pre-rename journal keeps its legacy live bundle before the swap",
  );
  for (const phase of ["restoring-previous", "previous-restored"]) {
    assert.equal(
      planMacosTrayRecovery({
        phase,
        hadPrevious: true,
        previous: false,
        failed: false,
      }, { liveExists: true }),
      "finish-restored",
      `${phase} must retry supervision after the previous bundle is already live`,
    );
  }
  assert.equal(
    planMacosTrayRecovery({
      phase: "committed",
      hadPrevious: true,
      previous: true,
      failed: false,
    }, { liveExists: true, liveComplete: true }),
    "finalize",
  );
  assert.throws(
    () => planMacosTrayRecovery({
      phase: "committed",
      hadPrevious: true,
      previous: true,
      failed: false,
    }, { liveExists: true, liveComplete: false }),
    /committed live bundle is incomplete/,
  );
  assert.throws(
    () => planMacosTrayRecovery({
      phase: "replacement-installed",
      hadPrevious: true,
      previous: false,
      failed: false,
    }, { liveExists: false }),
    /previous bundle backup is missing/,
  );
});

test("macOS transaction target and artifact markers are fixed-enum and old journals remain identifiable", {
  skip: process.platform === "win32",
}, async () => {
  const legacy = macosTransactionFixture({ targetName: undefined });
  const current = macosTransactionFixture({ targetName: "codex-router", artifactSet: "widget-v1" });
  const unknown = macosTransactionFixture({ targetName: "guess-a-target" });
  const unknownArtifacts = macosTransactionFixture({ artifactSet: "guess-artifacts" });
  try {
    const legacyTransaction = await inspectMacosTrayTransaction(legacy.transaction);
    assert.equal(legacyTransaction.targetName, null);
    assert.equal(legacyTransaction.artifactSet, null);
    const currentTransaction = await inspectMacosTrayTransaction(current.transaction);
    assert.equal(currentTransaction.targetName, "codex-router");
    assert.equal(currentTransaction.artifactSet, "widget-v1");
    await assert.rejects(
      inspectMacosTrayTransaction(unknown.transaction),
      /target-name contains an unknown value/,
    );
    await assert.rejects(
      inspectMacosTrayTransaction(unknownArtifacts.transaction),
      /artifact-set contains an unknown value/,
    );
  } finally {
    for (const fixture of [legacy, current, unknown, unknownArtifacts]) {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("macOS swap journals produce a deterministic crash-recovery plan", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = macosTransactionFixture();
  try {
    const transaction = await inspectMacosTrayTransaction(fixture.transaction);
    const liveExists = await inspectMacosTrayLiveBundle(fixture.bundle);
    assert.equal(
      planMacosTrayRecovery(transaction, { liveExists }),
      "replace-live-with-previous",
    );

    rmSync(path.join(fixture.transaction, "phase"));
    writePrivateLine(path.join(fixture.transaction, "phase.next"), "replacement-installed");
    const interruptedWrite = await inspectMacosTrayTransaction(fixture.transaction);
    assert.equal(interruptedWrite.nextAction, "promote");
    assert.equal(
      planMacosTrayRecovery(interruptedWrite, { liveExists }),
      "replace-live-with-previous",
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }

  for (const phase of ["restoring-previous", "previous-restored"]) {
    const resumed = macosTransactionFixture({ phase, previous: false, live: true });
    try {
      const transaction = await inspectMacosTrayTransaction(resumed.transaction);
      assert.equal(
        planMacosTrayRecovery(transaction, { liveExists: true }),
        "finish-restored",
        `${phase} must resume after the previous bundle was already moved live`,
      );
    } finally {
      rmSync(resumed.parent, { recursive: true, force: true });
    }
  }
});

test("committed macOS recovery keeps rollback until every versioned bundle artifact is complete", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = macosTransactionFixture({ phase: "committed", artifactSet: "widget-v1" });
  const artifacts = [
    "Contents/MacOS/ModelRouterTray",
    "Contents/PlugIns/RouterUsageWidget.appex/Contents/Info.plist",
    "Contents/PlugIns/RouterUsageWidget.appex/Contents/MacOS/RouterUsageWidget",
    "Contents/Resources/Control Center.app/Contents/MacOS/Codex Router",
    "Contents/Resources/Control Center.app/Contents/Resources/app.asar",
  ];
  const executableArtifacts = [artifacts[0], artifacts[2], artifacts[3]];
  try {
    installCompleteMacosTrayBundle(fixture.bundle);
    const transaction = await inspectMacosTrayTransaction(fixture.transaction);
    const liveExists = await inspectMacosTrayLiveBundle(fixture.bundle);
    assert.equal(await inspectMacosTrayCommittedBundle(fixture.bundle), true);
    assert.equal(
      planMacosTrayRecovery(transaction, { liveExists, liveComplete: true }),
      "finalize",
    );
    const transactionCli = path.join(root, "src", "macos-tray-transaction.mjs");
    const completePlan = spawnSync(
      process.execPath,
      [transactionCli, "plan", fixture.transaction, fixture.bundle],
      { encoding: "utf8" },
    );
    assert.equal(completePlan.status, 0, completePlan.stderr);
    assert.equal(completePlan.stdout, "finalize none\n");

    for (const relative of artifacts) {
      const artifact = path.join(fixture.bundle, relative);
      writeFileSync(artifact, "");
      await assert.rejects(
        inspectMacosTrayCommittedBundle(fixture.bundle),
        new RegExp(`${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is empty`),
      );
      writeFileSync(artifact, "complete");
    }

    for (const relative of executableArtifacts) {
      const executable = path.join(fixture.bundle, relative);
      chmodSync(executable, 0o644);
      await assert.rejects(
        inspectMacosTrayCommittedBundle(fixture.bundle),
        /is not executable by its owner/,
      );
      chmodSync(executable, 0o755);
    }

    const widgetInfo = path.join(fixture.bundle, artifacts[1]);
    rmSync(widgetInfo);
    assert.equal(await inspectMacosTrayCommittedBundle(fixture.bundle), false);
    const missingInfoPlan = spawnSync(
      process.execPath,
      [transactionCli, "plan", fixture.transaction, fixture.bundle],
      { encoding: "utf8" },
    );
    assert.notEqual(missingInfoPlan.status, 0);
    assert.match(missingInfoPlan.stderr, /committed live bundle is incomplete/);
    const externalInfo = path.join(fixture.parent, "external-widget-info.plist");
    writeFileSync(externalInfo, "outside");
    symlinkSync(externalInfo, widgetInfo);
    await assert.rejects(
      inspectMacosTrayCommittedBundle(fixture.bundle),
      /RouterUsageWidget\.appex\/Contents\/Info\.plist is not a regular file/,
    );
    rmSync(widgetInfo);
    writeFileSync(widgetInfo, "complete");
    chmodSync(widgetInfo, 0o666);
    await assert.rejects(
      inspectMacosTrayCommittedBundle(fixture.bundle),
      /RouterUsageWidget\.appex\/Contents\/Info\.plist has unsafe permissions 666/,
    );
    chmodSync(widgetInfo, 0o644);

    const archive = path.join(fixture.bundle, artifacts.at(-1));
    rmSync(archive);
    assert.equal(await inspectMacosTrayCommittedBundle(fixture.bundle), false);
    const incompletePlan = spawnSync(
      process.execPath,
      [transactionCli, "plan", fixture.transaction, fixture.bundle],
      { encoding: "utf8" },
    );
    assert.notEqual(incompletePlan.status, 0);
    assert.match(incompletePlan.stderr, /committed live bundle is incomplete/);
    const external = path.join(fixture.parent, "external-app.asar");
    writeFileSync(external, "outside");
    symlinkSync(external, archive);
    await assert.rejects(
      inspectMacosTrayCommittedBundle(fixture.bundle),
      /app\.asar is not a regular file/,
    );
    rmSync(archive);
    writeFileSync(archive, "complete");
    chmodSync(archive, 0o666);
    await assert.rejects(
      inspectMacosTrayCommittedBundle(fixture.bundle),
      /app\.asar has unsafe permissions 666/,
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("a committed pre-widget journal validates the legacy artifact set after upgrade", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = macosTransactionFixture({ phase: "committed" });
  try {
    installCompleteMacosTrayBundle(fixture.bundle, { includeWidget: false });
    const transaction = await inspectMacosTrayTransaction(fixture.transaction);
    assert.equal(transaction.artifactSet, null);
    assert.equal(
      await inspectMacosTrayCommittedBundle(fixture.bundle, { requireWidget: false }),
      true,
    );
    assert.equal(await inspectMacosTrayCommittedBundle(fixture.bundle), false);
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "macos-tray-transaction.mjs"), "plan", fixture.transaction, fixture.bundle],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "finalize none\n");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("macOS swap journals reject symlinks, unsafe modes, unknown entries, and impossible states", {
  skip: process.platform === "win32",
}, async () => {
  const cases = [];
  const symlinked = macosTransactionFixture();
  const external = path.join(symlinked.parent, "external-phase");
  writePrivateLine(external, "replacement-installed");
  rmSync(path.join(symlinked.transaction, "phase"));
  symlinkSync(external, path.join(symlinked.transaction, "phase"));
  cases.push(symlinked);

  const unsafeMode = macosTransactionFixture();
  chmodSync(path.join(unsafeMode.transaction, "phase"), 0o666);
  cases.push(unsafeMode);

  const unknownEntry = macosTransactionFixture();
  writeFileSync(path.join(unknownEntry.transaction, "surprise"), "x");
  cases.push(unknownEntry);

  const invalidPhase = macosTransactionFixture();
  writePrivateLine(path.join(invalidPhase.transaction, "phase"), "guess-and-continue");
  cases.push(invalidPhase);

  try {
    for (const fixture of cases) {
      await assert.rejects(
        inspectMacosTrayTransaction(fixture.transaction),
        /refusing ambiguous macOS Codex Router transaction/,
      );
    }

    const missingBackup = macosTransactionFixture({ previous: false });
    try {
      const transaction = await inspectMacosTrayTransaction(missingBackup.transaction);
      assert.throws(
        () => planMacosTrayRecovery(transaction, { liveExists: true }),
        /previous bundle backup is missing/,
      );
    } finally {
      rmSync(missingBackup.parent, { recursive: true, force: true });
    }

    const prematureDuplicate = macosTransactionFixture({ phase: "previous-moved" });
    try {
      const transaction = await inspectMacosTrayTransaction(prematureDuplicate.transaction);
      assert.throws(
        () => planMacosTrayRecovery(transaction, { liveExists: true }),
        /both previous and live bundles exist/,
      );
    } finally {
      rmSync(prematureDuplicate.parent, { recursive: true, force: true });
    }

    const missingCommitted = macosTransactionFixture({ phase: "committed", live: false });
    try {
      const transaction = await inspectMacosTrayTransaction(missingCommitted.transaction);
      assert.throws(
        () => planMacosTrayRecovery(transaction, { liveExists: false }),
        /committed live bundle is missing/,
      );
    } finally {
      rmSync(missingCommitted.parent, { recursive: true, force: true });
    }
  } finally {
    for (const fixture of cases) rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("tray updates journal every macOS swap before replacing the live app", () => {
  const script = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  const mac = script.slice(script.indexOf("  Darwin)"), script.indexOf("  Linux)"));
  const recover = mac.indexOf("recover_macos_transaction");
  const createJournal = mac.indexOf('mkdir -m 700 "$transaction_dir"');
  const build = mac.indexOf('build-macos-tray-app.sh" "$staged_bundle"');
  const draining = mac.indexOf("write_macos_phase draining", build);
  const terminate = mac.indexOf("if ! terminate_router_apps", draining);
  const drained = mac.indexOf("write_macos_phase drained", terminate);
  const stop = mac.indexOf('tray-service.mjs" stop', drained);
  const previousMoving = mac.indexOf("write_macos_phase previous-moving", stop);
  const previousMove = mac.indexOf('mv "$bundle_dir" "$previous_bundle"', previousMoving);
  const legacyPreviousMove = mac.indexOf('mv "$legacy_user_bundle" "$previous_bundle"', previousMove);
  const replacementMoving = mac.indexOf("write_macos_phase replacement-moving", legacyPreviousMove);
  const replacementMove = mac.indexOf('mv "$staged_bundle" "$bundle_dir"', replacementMoving);
  const serviceInstall = mac.indexOf('tray-service.mjs" install', replacementMove);
  const outerReady = mac.indexOf("write_macos_phase replacement-ready", serviceInstall);
  const embeddedReady = mac.indexOf("write_macos_phase embedded-ready", outerReady);
  const commit = mac.indexOf("write_macos_phase committed", embeddedReady);
  const removeJournal = mac.indexOf('rm -rf "$transaction_dir"', commit);

  assert.match(mac, /transaction_dir="\$bundle_parent\/\.model-router-tray-transaction"/);
  assert.doesNotMatch(mac, /mktemp -d "\$bundle_parent\/\.model-router-tray/);
  assert.ok(recover >= 0 && recover < createJournal, "a stale journal is recovered before a new one is created");
  assert.match(mac, /recovery_bundle_dir=\$bundle_dir[\s\S]*plan "\$transaction_dir" "\$recovery_bundle_dir"/);
  assert.match(mac, /if \[ ! -e "\$target_name_file" \]; then[\s\S]*recovery_bundle_dir=\$legacy_user_bundle[\s\S]*recovery_service_action=restart/);
  assert.match(mac, /mkdir -m 700 "\$transaction_dir"[\s\S]*chmod 600 "\$had_previous_file"/);
  assert.match(mac, /printf '%s\\n' codex-router >"\$target_name_file"[\s\S]*chmod 600 "\$target_name_file"/);
  assert.match(mac, /printf '%s\\n' widget-v1 >"\$artifact_set_file"[\s\S]*chmod 600 "\$artifact_set_file"/);
  assert.match(mac, /both Codex Router\.app and the legacy Model Router\.app exist; refusing an ambiguous replacement/);
  assert.match(mac, /next_phase_file="\$transaction_dir\/phase\.next"[\s\S]*write_macos_phase\(\)[\s\S]*mv "\$next_phase_file" "\$phase_file"/);
  assert.ok(
    build > createJournal && draining > build && terminate > draining && drained > terminate
      && stop > drained && previousMoving > stop && previousMove > previousMoving
      && legacyPreviousMove > previousMove && replacementMoving > legacyPreviousMove
      && replacementMove > replacementMoving
      && serviceInstall > replacementMove && outerReady > serviceInstall
      && embeddedReady > outerReady && commit > embeddedReady && removeJournal > commit,
    "the durable phases must bracket every destructive and readiness boundary",
  );
  assert.match(mac, /recover_macos_transaction\(\)[\s\S]*replace-live-with-previous\)[\s\S]*stop_uncommitted_tray[\s\S]*mv "\$recovery_bundle_dir" "\$failed_bundle"[\s\S]*mv "\$previous_bundle" "\$recovery_bundle_dir"/);
  assert.match(
    mac,
    /restore-previous\)[\s\S]*write_macos_phase restoring-previous[\s\S]*mv "\$previous_bundle" "\$recovery_bundle_dir"[\s\S]*write_macos_phase previous-restored[\s\S]*restore_supervision=1/,
    "restoration must remain retryable after the previous bundle becomes live",
  );
  assert.match(mac, /cleanup_macos\(\)[\s\S]*recover_macos_transaction/);
  assert.match(mac, /schedule_macos_supervision_restore\(\)[\s\S]*macos-tray-transaction\.mjs[\s\S]*"\$1" = keep-live[\s\S]*tray-service\.mjs" restart/);
  assert.match(mac, /run_embedded_control_center "\$staged_embedded_binary" --quit-for-update/);
  assert.match(mac, /run_embedded_control_center "\$embedded_binary" --tray-only/);
  assert.match(mac, /query_embedded_lifecycle[\s\S]*control_center_identity_matches/);
  assert.match(
    mac,
    /tray_app_identity\(\)[\s\S]*EXPECTED_BUNDLE="\$expected_bundle"[\s\S]*bundlePath === expectedBundle/,
    "outer-host readiness must bind the shared bundle identifier to the exact live app",
  );
  assert.match(
    mac,
    /readiness_identity=\$\(tray_app_identity "\$bundle_dir"\)[\s\S]*"\$readiness_count" -eq 1[\s\S]*"\$readiness_matches" -eq 1/,
  );
  assert.match(mac, /readiness_count" -gt 1/);
  assert.doesNotMatch(mac, /killall -QUIT ModelRouterTray|pgrep[\s\S]*(?:ModelRouterTray|Codex Router)/);

  for (const relative of ["src/update.mjs", "src/control.mjs", "bin/install"]) {
    const caller = readFileSync(path.join(root, relative), "utf8");
    assert.match(
      caller,
      /model-router-tray[\s\S]{0,300}--preserve-window|--preserve-window[\s\S]{0,300}model-router-tray/,
      relative + " must preserve window state during automatic replacement",
    );
  }

  const installer = readFileSync(path.join(root, "bin", "install"), "utf8");
  const plan = installer.indexOf("install-plan.mjs tray-plan");
  const rebuildCase = installer.indexOf("rebuild)", plan);
  const skipCase = installer.indexOf("skip)", rebuildCase);
  const endCase = installer.indexOf("esac", skipCase);
  const deferred = installer.slice(rebuildCase, skipCase);
  const matching = installer.slice(skipCase, endCase);
  assert.ok(plan >= 0 && rebuildCase > plan && skipCase > rebuildCase);
  assert.doesNotMatch(installer.slice(0, plan), /tray-service\.mjs install/);
  assert.doesNotMatch(deferred, /tray-service\.mjs (?:install|start|restart|stop)/);
  assert.match(deferred, /CODEX_ROUTER_DEFER_TRAY_REBUILD/);
  assert.match(matching, /status\?\.installed === false/);
  assert.match(matching, /status\?\.supported !== false/);
  assert.match(matching, /tray-service\.mjs install/);
});

test("a broken embedded renderer remains journaled and rolls back the exact live child", () => {
  const script = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  const mac = script.slice(script.indexOf("  Darwin)"), script.indexOf("  Linux)"));
  const probe = mac.indexOf("embedded_renderer_ready=0");
  const failure = mac.indexOf('[ "$embedded_renderer_ready" -ne 1 ]', probe);
  const embeddedReady = mac.indexOf("write_macos_phase embedded-ready", failure);
  const commit = mac.indexOf("write_macos_phase committed", failure);
  const recovery = mac.indexOf("replace-live-with-previous)");
  const recoveryStop = mac.indexOf("if ! stop_uncommitted_tray", recovery);
  const failedMove = mac.indexOf('mv "$recovery_bundle_dir" "$failed_bundle"', recoveryStop);
  const restoreMove = mac.indexOf('mv "$previous_bundle" "$recovery_bundle_dir"', failedMove);

  assert.ok(probe >= 0 && failure > probe && embeddedReady > failure && commit > embeddedReady);
  assert.match(mac.slice(failure, embeddedReady), /Control Center renderer did not become ready[\s\S]*exit 1/);
  assert.ok(recovery >= 0 && recoveryStop > recovery && failedMove > recoveryStop && restoreMove > failedMove);
  assert.match(
    mac.slice(mac.indexOf("stop_uncommitted_tray()"), mac.indexOf("schedule_macos_supervision_restore()")),
    /recovery_embedded_binary="\$recovery_bundle[\s\S]*run_embedded_control_center "\$recovery_embedded_binary" --quit-for-update[\s\S]*tray-service\.mjs" stop[\s\S]*router_app_count/,
  );
  assert.match(
    mac,
    /run_embedded_control_center\(\)[\s\S]*env -u ELECTRON_RUN_AS_NODE[\s\S]*CODEX_ROUTER_EMBEDDED_CONTROL_CENTER=1/,
  );
  assert.match(mac, /write_macos_phase replacement-ready[\s\S]*embedded_renderer_ready=0[\s\S]*write_macos_phase embedded-ready[\s\S]*write_macos_phase committed/);
  assert.doesNotMatch(
    mac,
    /env -u ELECTRON_RUN_AS_NODE "\$(?:staged_)?embedded_binary"/,
    "embedded binaries must not bypass the native-host environment wrapper",
  );
});

test("the macOS host and embedded window prefer the installed owner checkout", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const explicit = source.indexOf('["CODEX_ROUTER_SOURCE_ROOT", "MODEL_ROUTER_SOURCE_ROOT"]');
  const installed = source.indexOf("recordedInstallSourceRoot()")
  const sealed = source.indexOf('object(forInfoDictionaryKey: "ModelRouterSourceRoot")');
  assert.ok(
    explicit >= 0 && installed > explicit && sealed > installed,
    "explicit operator root, installed owner, and build checkout must keep the Electron precedence",
  );
  assert.match(source, /environment\[key\] = value/);
  assert.match(source, /install-manifest\.json/);
  assert.match(source, /size\.intValue <= manifestLimit/);
  assert.match(source, /\(manifestMode\.uint16Value & 0o077\) == 0/);
  assert.match(source, /\.local\/share\/codex-router/);
  assert.doesNotMatch(source, /currentDirectoryPath/);
  assert.match(source, /isExecutableFile\(atPath: url\.path\)/);
  assert.match(source, /ModelRouterControlVersion/);
  assert.match(source, /ModelRouterControlProtocol/);

  const script = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  assert.match(script, /Add :ModelRouterSourceRoot string \$repo_dir/);
  assert.match(script, /Control Center\.app\/Contents\/Resources\/router-root/);
  assert.match(script, /Add :ModelRouterControlVersion string \$app_version/);
  assert.match(script, /Add :ModelRouterControlProtocol integer \$control_protocol/);
});

test("the native macOS tray owns one embedded Control Center", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /ControlCenterLauncher\.open\(\)/);
  assert.match(source, /bundleName = "Control Center\.app"/);
  assert.match(source, /Bundle\.main\.resourceURL/);
  assert.match(source, /CODEX_ROUTER_EMBEDDED_CONTROL_CENTER/);
  assert.match(source, /runningApplications\(withBundleIdentifier:/);
  assert.match(source, /Control Center could not open:/);
  assert.match(source, /reportControlCenterLaunchFailure/);

  const update = source.slice(
    source.indexOf("func updateAndVerify()"),
    source.indexOf("func setupHarness()"),
  );
  const repair = source.slice(
    source.indexOf("func fixAndVerify()"),
    source.indexOf("func setLoginFree("),
  );
  const restart = source.slice(
    source.indexOf("func restartRouter()"),
    source.indexOf("private func restartCodexApp()"),
  );
  for (const [label, body, command] of [
    ["update", update, "maintenanceArguments"],
    ["repair", repair, "repairArguments"],
  ]) {
    const begin = body.indexOf("beginNativeMutation()");
    const release = body.indexOf("finishNativeMutation()", begin);
    const fallback = body.indexOf("launchDetachedTrayRefresh", begin);
    assert.ok(begin >= 0 && fallback > begin && release > fallback, `${label} must launch fallback refresh before releasing its outer quit drain`);
    const commandRun = body.indexOf(`runControl(arguments: ${command})`);
    assert.ok(
      commandRun >= 0
        && commandRun < body.indexOf(`launchDetachedTrayRefresh(after: ${command})`, commandRun),
      `${label} must complete maintenance before launching its refresh`,
    );
  }
  assert.match(restart, /beginNativeMutation\(\)[\s\S]*finishNativeMutation\(\)/);
  assert.match(restart, /launchDetachedTrayCommand\("rebuild"\)/);
  const detached = source.slice(
    source.indexOf("private func launchDetachedTrayCommand("),
    source.indexOf("private func runControl("),
  );
  assert.match(detached, /task\.standardInput = FileHandle\.nullDevice/);
  assert.match(detached, /task\.standardOutput = FileHandle\.nullDevice/);
  assert.match(detached, /task\.standardError = FileHandle\.nullDevice/);
  assert.match(detached, /removeValue\(forKey: "CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS"\)/);
  assert.match(detached, /removeValue\(forKey: "CODEX_ROUTER_OWNER_SIGNAL_BARRIER_DIR"\)/);
  assert.match(detached, /try task\.run\(\)/);
  assert.doesNotMatch(detached, /waitUntilExit/);
});

test("changes to the embedded Control Center make the macOS bundle stale", () => {
  const fakeRoot = scratch();
  try {
    const electron = path.join(fakeRoot, "apps", "control-center", "electron");
    mkdirSync(electron, { recursive: true });
    writeFileSync(path.join(electron, "main.mjs"), "before\n", "utf8");
    const before = traySourceFingerprint(fakeRoot, "darwin");
    writeFileSync(path.join(electron, "main.mjs"), "after\n", "utf8");
    assert.notEqual(traySourceFingerprint(fakeRoot, "darwin"), before);
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("macOS resource-only changes invalidate the native bundle fingerprint", () => {
  for (const relative of [
    ["apps", "macos", "ModelRouterTray", "Resources", "AppIcon.icns"],
    ["apps", "macos", "ModelRouterTray", "Sources", "Resources", "Nested", "future.asset"],
  ]) {
    const fakeRoot = scratch();
    try {
      const resource = path.join(fakeRoot, ...relative);
      mkdirSync(path.dirname(resource), { recursive: true });
      writeFileSync(resource, Buffer.from([0x01, 0x02, 0x03]));
      const before = traySourceFingerprint(fakeRoot, "darwin");
      writeFileSync(resource, Buffer.from([0x01, 0x02, 0x04]));
      assert.notEqual(
        traySourceFingerprint(fakeRoot, "darwin"),
        before,
        relative.join("/"),
      );
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("macOS widget changes invalidate the native bundle fingerprint", () => {
  for (const relative of [
    ["scripts", "build-macos-widget.sh"],
    ["apps", "macos", "RouterUsageWidget", "RouterUsageWidget", "RouterUsageWidget.swift"],
    ["apps", "macos", "RouterUsageWidget", "project.yml"],
  ]) {
    const fakeRoot = scratch();
    try {
      const file = path.join(fakeRoot, ...relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "before\n", "utf8");
      const before = traySourceFingerprint(fakeRoot, "darwin");
      writeFileSync(file, "after\n", "utf8");
      assert.notEqual(traySourceFingerprint(fakeRoot, "darwin"), before, relative.join("/"));
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("Control Center fingerprints include renderer, build config, and shared icons", () => {
  for (const relative of [
    ["apps", "control-center", "index.html"],
    ["apps", "control-center", "vite.config.ts"],
    ["apps", "control-center", "tsconfig.json"],
    ["apps", "control-center", "assets", "icon.png"],
  ]) {
    const fakeRoot = scratch();
    try {
      const file = path.join(fakeRoot, ...relative);
      mkdirSync(path.dirname(file), { recursive: true });
      const beforeWindows = traySourceFingerprint(fakeRoot, "win32");
      const beforeMac = traySourceFingerprint(fakeRoot, "darwin");
      writeFileSync(file, "changed\n", "utf8");
      assert.notEqual(traySourceFingerprint(fakeRoot, "win32"), beforeWindows, relative.join("/"));
      assert.notEqual(traySourceFingerprint(fakeRoot, "darwin"), beforeMac, relative.join("/"));
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("desktop shells keep their routing mark while the Control Center sidebar stays text-only", () => {
  const script = readFileSync(path.join(root, "scripts", "build-app-icon.sh"), "utf8");
  assert.match(script, /ModelRouterTray\/Resources\/AppIcon\.svg/);
  for (const asset of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico"]) {
    assert.match(script, new RegExp(`control_center_assets/${asset.replaceAll(".", "\\.")}`));
  }
  assert.match(script, /scripts\/build-ico\.mjs/);

  const renderer = readFileSync(path.join(root, "apps", "control-center", "src", "App.tsx"), "utf8");
  assert.doesNotMatch(renderer, /assets\/32x32\.png/);
  assert.match(renderer, /<strong>Codex Router<\/strong>/);
  const builder = readFileSync(path.join(root, "apps", "control-center", "electron-builder.yml"), "utf8");
  assert.match(builder, /mac:[\s\S]*icon:\s*assets\/icon\.png/);
  assert.match(builder, /win:[\s\S]*icon:\s*assets\/icon\.ico/);
});

test("Control Center fingerprints include JavaScript model helpers and build entrypoints", () => {
  for (const relative of [
    ["apps", "control-center", "src", "model-families.mjs"],
    ["scripts", "build-electron-companion.sh"],
    ["scripts", "build-electron-companion.ps1"],
  ]) {
    const fakeRoot = scratch();
    try {
      const file = path.join(fakeRoot, ...relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "before\n", "utf8");
      const before = traySourceFingerprint(fakeRoot, "linux");
      writeFileSync(file, "after\n", "utf8");
      assert.notEqual(traySourceFingerprint(fakeRoot, "linux"), before, relative.join("/"));
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("Control Center fingerprints include every packaged security helper", () => {
  for (const relative of [
    ["src", "spawnable-command.mjs"],
    ["src", "chatgpt-login-lease.mjs"],
    ["src", "file-security.mjs"],
    ["src", "path-security.mjs"],
    ["src", "process-identity.mjs"],
  ]) {
    const fakeRoot = scratch();
    try {
      const file = path.join(fakeRoot, ...relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "before\n", "utf8");
      const before = traySourceFingerprint(fakeRoot, "linux");
      writeFileSync(file, "after\n", "utf8");
      assert.notEqual(traySourceFingerprint(fakeRoot, "linux"), before, relative.join("/"));
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("Control Center fingerprints hash binary assets as bytes", () => {
  const fakeRoot = scratch();
  try {
    const icon = path.join(fakeRoot, "apps", "control-center", "assets", "icon.png");
    mkdirSync(path.dirname(icon), { recursive: true });
    // Both values decode to the Unicode replacement character as UTF-8. The
    // old text digest therefore considered these different icons identical.
    writeFileSync(icon, Buffer.from([0x80]));
    const before = traySourceFingerprint(fakeRoot, "win32");
    writeFileSync(icon, Buffer.from([0x81]));
    assert.notEqual(traySourceFingerprint(fakeRoot, "win32"), before);
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("Linux and Windows keep independent build stamps", () => {
  const fakeRoot = scratch();
  const home = scratch();
  try {
    const linuxBinary = path.join(
      fakeRoot,
      "apps",
      "control-center",
      "release",
      "linux-unpacked",
      "codex-router-control-center",
    );
    const windowsBinary = path.join(
      fakeRoot,
      "apps",
      "control-center",
      "release",
      "win-unpacked",
      "Codex Router.exe",
    );
    installPackagedControlCenter(fakeRoot, "linux");
    installPackagedControlCenter(fakeRoot, "win32");
    writeFileSync(linuxBinary, "old-linux", "utf8");
    writeFileSync(windowsBinary, "new-windows", "utf8");

    const windowsStamp = recordTrayBuild({ root: fakeRoot, platform: "win32", home });
    assert.match(windowsStamp, /\.codex-router-install-win32\.json$/);
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "win32", home }), "skip");
    assert.equal(
      trayRebuildPlan({ root: fakeRoot, platform: "linux", home }),
      "rebuild",
      "a Windows build must not certify the still-unstamped Linux package",
    );

    const linuxStamp = recordTrayBuild({ root: fakeRoot, platform: "linux", home });
    assert.match(linuxStamp, /\.codex-router-install-linux\.json$/);
    assert.notEqual(linuxStamp, windowsStamp);
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "skip");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("follow mode rechecks host presence and drains requests before stopping", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /hostAppAbsenceGrace = Duration\.seconds\(30\)/);
  assert.match(source, /hostAppRecheckInterval = Duration\.seconds\(5\)/);
  assert.match(source, /guard pendingServiceStop == nil else \{ return \}/);
  assert.match(source, /activeRequestCount == 0 && activityState == \.idle/);
  assert.match(source, /self\.refreshHostAppRunning\(\)/);
  assert.match(source, /runServiceCommand\("stop"\)/);
});

test("idle tray updates are deferred, throttled, and finite", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /Task \{ @MainActor \[weak self\] in/);
  assert.match(source, /guard surfacesVisible != next else \{ return \}/);
  assert.match(source, /nanoseconds: 1_000_000_000/);
  const statusStart = source.indexOf("private struct StatusBeacon");
  const operationStart = source.indexOf("private struct OperationPulse");
  const accentStart = source.indexOf("private struct AccentButtonStyle");
  assert.ok(statusStart >= 0 && operationStart > statusStart && accentStart > operationStart);
  assert.doesNotMatch(source.slice(statusStart, operationStart), /\.repeatForever/);
  assert.doesNotMatch(source.slice(operationStart, accentStart), /\.repeatForever/);
  assert.match(source.slice(statusStart, accentStart), /\.task\(id:/);
});

// Every case names its platform explicitly. Letting it default to
// process.platform made this pass on macOS and fail on Linux and Windows,
// where the default reads the Tauri paths and never sees the Swift file the
// test just wrote.
test("the fingerprint covers every source file, not just the first", () => {
  for (const [platform, dir, name, other] of [
    ["darwin", ["apps", "macos", "ModelRouterTray", "Sources"], "Two.swift", "One.swift"],
    ["linux", ["apps", "control-center", "electron"], "two.mjs", "main.mjs"],
  ]) {
    const a = scratch();
    try {
      const sources = path.join(a, ...dir);
      mkdirSync(sources, { recursive: true });
      writeFileSync(path.join(sources, other), "a\n", "utf8");
      writeFileSync(path.join(sources, name), "b\n", "utf8");
      const before = traySourceFingerprint(a, platform);
      // A change in any file must move the fingerprint, or a rebuild is
      // missed whenever the edit lands outside the first source file.
      writeFileSync(path.join(sources, name), "c\n", "utf8");
      assert.notEqual(traySourceFingerprint(a, platform), before, `${platform}: ${name}`);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  }
});

test("every tray assertion names its platform instead of inheriting the host", () => {
  // This file's job is cross-platform behaviour, so a bare call that inherits
  // process.platform makes the suite pass or fail depending on the runner --
  // which is exactly how a green macOS run shipped a red Linux and Windows CI.
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // A single-argument call inherits the runner's platform. Both helpers take
  // the platform second, so every call site here must pass one.
  assert.doesNotMatch(self, /traySourceFingerprint\([A-Za-z_$][\w$]*\s*\)/);
  for (const call of self.match(/trayRebuildPlan\(\{[^}]*\}\)/g) ?? []) {
    assert.match(call, /platform:/, `missing explicit platform: ${call}`);
  }
});

// Regression for #180. The mode decision itself is covered by real Swift tests
// (apps/macos/ModelRouterTray/Tests/IslandModeTests.swift), which CI runs on
// the macOS matrix leg -- asserting on the source text of an initializer only
// ever proved the source said something. What stays here is the wiring those
// Swift tests cannot see.
test("the tray ships a Swift test target and CI runs it", () => {
  const manifest = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Package.swift"),
    "utf8",
  );
  assert.match(manifest, /\.testTarget\(\s*\n\s*name: "ModelRouterTrayTests"/);

  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /working-directory: apps\/macos\/ModelRouterTray\s+run: swift test/);
  assert.match(workflow, /if: runner\.os == 'macOS'/);
});

test("the island mode decision stays pure, so it stays testable", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  // nonisolated because it reads no stored state; if someone reaches for
  // `defaults` inside it, that stops being true and the Swift tests stop
  // being able to call it.
  assert.match(source, /nonisolated static func resolveIslandMode\(/);
  const declaration = source.slice(source.indexOf("nonisolated static func resolveIslandMode("));
  const initIndex = declaration.search(/\r?\n  init\(\)/);
  assert.ok(initIndex > 0, "resolveIslandMode still sits above init()");
  assert.doesNotMatch(declaration.slice(0, initIndex), /defaults\./);
});

test("only one process may draw the Island overlay", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "IslandOverlay.swift"),
    "utf8",
  );
  // An unbundled `swift run` binary has no identifier, reads a different
  // UserDefaults domain, and could never see the preference change -- it must
  // never claim the overlay.
  assert.match(source, /guard let identifier = Bundle\.main\.bundleIdentifier else \{ return false \}/);
  assert.match(source, /NSRunningApplication\.runningApplications\(withBundleIdentifier: identifier\)/);
  assert.match(source, /if visible && ownsOverlay \{/);
});

test("the docs no longer claim the Island is on by default", () => {
  const trayDoc = readFileSync(path.join(root, "docs", "MACOS-TRAY.md"), "utf8");
  assert.doesNotMatch(trayDoc, /Island is shown by default/);
  assert.match(trayDoc, /off on a new install/);
});

// The tray dictionary is keyed on the English source string, so a new
// routerLocalized("...") literal is silently English-only until somebody
// remembers to add it. That is exactly how "Fix Codex Router installation"
// shipped untranslated. Check every literal against the dictionary here,
// where it is cheap, instead of noticing it in a screenshot.
test("every localized tray literal has a Chinese translation", () => {
  const sources = ["ModelRouterTrayApp.swift", "IslandOverlay.swift", "ThinkingOrbCanvas.swift"]
    .map((name) =>
      readFileSync(
        path.join(root, "apps", "macos", "ModelRouterTray", "Sources", name),
        "utf8",
      ),
    )
    .join("\n");
  const catalog = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "Localization.swift"),
    "utf8",
  );

  // Only literal call sites can be checked statically; the handful that pass a
  // variable are localized at whatever assigns them.
  const literals = new Set(
    [...sources.matchAll(/router(?:Localized|Format)\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]),
  );
  assert.ok(literals.size > 100, `expected a full catalog, found ${literals.size}`);

  const translated = new Set(
    [...catalog.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"/gm)].map((m) => m[1]),
  );

  // Brand names are deliberately identical in both languages.
  const untranslatable = new Set(["CODEX"]);
  const missing = [...literals].filter((k) => !translated.has(k) && !untranslatable.has(k));
  assert.deepEqual(missing, [], `untranslated tray strings: ${missing.join(" | ")}`);
});

// Regression for PR #308 review: settings load/defaulting must stay pure so
// Swift tests can cover missing keys without spinning up RouterStore.
test("menu bar settings resolve through a pure helper", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /nonisolated static func resolveMenuBarSettings\(/);
  const declaration = source.slice(source.indexOf("nonisolated static func resolveMenuBarSettings("));
  const nextDecl = declaration.search(/\r?\n  (nonisolated static func |init\(\)|func )/);
  const body = nextDecl > 0 ? declaration.slice(0, nextDecl) : declaration.slice(0, 1200);
  assert.doesNotMatch(body, /defaults\./);
  assert.match(source, /\?\? \.router/);
  assert.doesNotMatch(
    source,
    /menuBarIconStyle = \.provider/,
    "missing key must not default to .provider",
  );
});

test("menu bar provider marks reuse ProviderIcon instead of a second map", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const viewStart = source.indexOf("private struct MenuBarIconView");
  assert.ok(viewStart > 0, "MenuBarIconView is still in ModelRouterTrayApp.swift");
  const view = source.slice(viewStart, source.indexOf("private struct StatusItemLabel"));
  assert.match(view, /ProviderIcon\(providerID:[^\n]*showsHelp: false\)/);
  assert.doesNotMatch(view, /private var assetName:/);
  assert.doesNotMatch(view, /NSImage\(contentsOfFile:/);
});

test("the macOS tray bundles NanoGPT's official provider mark", () => {
  const icon = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "Resources", "ProviderIcons", "nano-gpt.svg"),
    "utf8",
  );
  const providerIcon = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "IslandOverlay.swift"),
    "utf8",
  );
  const sources = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Resources", "PROVIDER-ICON-SOURCES.md"),
    "utf8",
  );

  assert.match(icon, /aria-label="NanoGPT"/);
  assert.match(icon, /data:image\/png;base64,/);
  assert.match(providerIcon, /providerID == "nano-gpt" \{ return "nano-gpt" \}/);
  assert.match(providerIcon, /providerID == "nano-gpt" \{ return "NanoGPT" \}/);
  assert.match(sources, /https:\/\/nano-gpt\.com\/favicon\.ico/);
});

test("the status item keeps native square geometry in icon-only mode", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /static let iconOnlyWidth: CGFloat = standardHeight/);
  assert.match(
    source,
    /statusItemWidth\(\s*displayMode: store\.menuBarDisplayMode/,
  );
  assert.match(source, /statusItemHeight\(\s*displayMode: store\.menuBarDisplayMode/);
  assert.doesNotMatch(
    source,
    /\.frame\(width: store\.menuBarShowModelName \? Self\.reservedWidth : nil/,
  );
  assert.doesNotMatch(source, /\.frame\(minWidth: 18\)/);
});

test("the tray panel uses the status item's actual screen", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const repositionStart = source.indexOf("private func reposition()");
  assert.ok(repositionStart > 0, "TrayMenuController still owns panel placement");
  const reposition = source.slice(
    repositionStart,
    source.indexOf("private func installMonitors()", repositionStart),
  );
  assert.match(reposition, /buttonWindow\.screen\?\.visibleFrame/);
  assert.doesNotMatch(reposition, /NSScreen\.screens\.map\(\\\.visibleFrame\)/);
  assert.doesNotMatch(reposition, /TrayPanelPlacement\.visibleFrame/);
});

test("the active router status is baked into one SVG template image", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const viewStart = source.indexOf("private struct MenuBarIconView");
  const view = source.slice(viewStart, source.indexOf("private struct StatusItemLabel"));
  assert.match(view, /store\.activityState == \.idle \? "RouterMark" : "RouterMarkActive"/);
  const activeSVG = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "Resources", "RouterMarkActive.svg"),
    "utf8",
  );
  assert.match(activeSVG, /<circle\b/);
});

test("a custom menu-bar image is copied into Application Support", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /nonisolated static func persistCustomMenuBarIcon\(/);
  assert.match(source, /menu-bar-icon\./);
  assert.match(source, /nonisolated static func loadCustomMenuBarIcon\(/);
  assert.match(source, /nonisolated static func menuBarTooltip\(/);
  assert.doesNotMatch(
    source,
    /store\.setMenuBarCustomIconPath\(url\.path\)/,
    "the picker must not persist the original user path",
  );
});
