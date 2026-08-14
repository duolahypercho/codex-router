import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "tray-rebuild-"));
}

function installTrayAt(home) {
  const bundle = trayBundleDir("darwin", home);
  mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(bundle, "Contents", "MacOS", "ModelRouterTray"), "binary", "utf8");
  return bundle;
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

test("Windows has no companion to keep in sync", () => {
  const home = scratch();
  try {
    assert.equal(trayRebuildPlan({ root, platform: "win32", home }), "unsupported");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// trayDecision offers the companion on Linux too. Answering "unsupported"
// there left Linux users with the drift this gating exists to prevent.
test("a Linux companion is kept in sync like the macOS one", () => {
  const home = scratch();
  const fakeRoot = scratch();
  const release = path.join(fakeRoot, "apps", "desktop", "src-tauri", "target", "release");
  const rust = path.join(fakeRoot, "apps", "desktop", "src-tauri", "src");
  try {
    mkdirSync(rust, { recursive: true });
    writeFileSync(path.join(rust, "main.rs"), "fn main() {}\n", "utf8");

    // Nothing built yet: an update must not install one unasked, same as macOS.
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "absent");

    mkdirSync(release, { recursive: true });
    writeFileSync(path.join(release, "codex-router-desktop"), "binary", "utf8");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "rebuild");

    recordTrayBuild({ root: fakeRoot, platform: "linux", home });
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "skip");

    writeFileSync(path.join(rust, "main.rs"), "fn main() { /* changed */ }\n", "utf8");
    assert.equal(trayRebuildPlan({ root: fakeRoot, platform: "linux", home }), "rebuild");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("each platform fingerprints its own sources", () => {
  // A shared fingerprint would make a Swift edit look like a reason to rebuild
  // the Tauri app, and vice versa.
  assert.notEqual(
    traySourceFingerprint(root, "darwin"),
    traySourceFingerprint(root, "linux"),
  );
  assert.equal(traySourceFingerprint(root, "win32"), "");
});

test("one companion location: the Node and shell sides name the same directory", () => {
  // Three copies of this path drifted apart before -- paths.mjs, the build
  // script default, and trayBundleDir -- which is how a machine ends up with a
  // separate tray per checkout and launchd pointing at whichever built last.
  const script = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  assert.match(script, /bundle_dir=\$\{1:-"\$HOME\/Applications\/Model Router\.app"\}/);
  assert.equal(trayBundleDir("darwin", "/Users/example"), "/Users/example/Applications/Model Router.app");
  assert.doesNotMatch(script, /\$repo_dir\/dist\/Model Router\.app"\}/);
});

test("the macOS tray is signed only after its resources are assembled", () => {
  const script = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  const resource = script.indexOf('Add :ModelRouterSourceRoot string $repo_dir');
  const sign = script.indexOf('/usr/bin/codesign --force --deep --sign - "$bundle_dir"');
  const verify = script.indexOf('/usr/bin/codesign --verify --deep --strict "$bundle_dir"');
  assert.ok(resource >= 0, "the checkout link must be placed in the bundle");
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

test("tray updates stage a signed bundle before stopping and replacing the live app", () => {
  const script = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  const build = script.indexOf('build-macos-tray-app.sh" "$staged_bundle"');
  const stop = script.indexOf("pgrep -x ModelRouterTray");
  const replace = script.indexOf('mv "$staged_bundle" "$bundle_dir"');
  assert.match(script, /mktemp -d "\$bundle_parent\/\.model-router-tray\.XXXXXX"/);
  assert.ok(build >= 0, "the replacement must be built in staging");
  assert.ok(stop > build, "the old tray stays alive until staging succeeds");
  assert.ok(replace > stop, "the live bundle is replaced only after its process stops");
});

test("the macOS tray executes control only from the checkout sealed into Info.plist", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.doesNotMatch(source, /MODEL_ROUTER_SOURCE_ROOT/);
  assert.match(source, /object\(forInfoDictionaryKey: "ModelRouterSourceRoot"\)/);
  assert.doesNotMatch(source, /String\(contentsOf:/);
  assert.doesNotMatch(source, /currentDirectoryPath/);
  assert.match(source, /isExecutableFile\(atPath: control\.path\)/);

  const script = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  assert.match(script, /Add :ModelRouterSourceRoot string \$repo_dir/);
  assert.doesNotMatch(script, /Contents\/Resources\/router-root/);
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

// Every case names its platform explicitly. Letting it default to
// process.platform made this pass on macOS and fail on Linux and Windows,
// where the default reads the Tauri paths and never sees the Swift file the
// test just wrote.
test("the fingerprint covers every source file, not just the first", () => {
  for (const [platform, dir, name, other] of [
    ["darwin", ["apps", "macos", "ModelRouterTray", "Sources"], "Two.swift", "One.swift"],
    ["linux", ["apps", "desktop", "src-tauri", "src"], "two.rs", "main.rs"],
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
