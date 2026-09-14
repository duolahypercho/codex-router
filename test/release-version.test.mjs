import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nextBetaVersion } from "../scripts/next-beta-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("automatic releases advance the current beta", () => {
  assert.equal(nextBetaVersion("0.4.0-beta.2"), "0.4.0-beta.3");
  assert.equal(nextBetaVersion("12.3.4-beta.99"), "12.3.4-beta.100");
});

test("a stable version starts the next patch beta series", () => {
  assert.equal(nextBetaVersion("1.2.3"), "1.2.4-beta.1");
});

test("unknown prerelease channels fail closed", () => {
  assert.throws(() => nextBetaVersion("1.2.3-rc.1"), /Cannot automatically advance/);
  assert.throws(() => nextBetaVersion("main"), /Cannot automatically advance/);
});

test("the widget keeps production App Group and local-source read-only contracts separate", () => {
  const productionEntitlements = readFileSync(
    path.join(
      root,
      "apps",
      "macos",
      "RouterUsageWidget",
      "RouterUsageWidget",
      "RouterUsageWidget.entitlements",
    ),
    "utf8",
  );
  const localEntitlements = readFileSync(
    path.join(
      root,
      "apps",
      "macos",
      "RouterUsageWidget",
      "RouterUsageWidget",
      "RouterUsageWidget.local.entitlements",
    ),
    "utf8",
  );
  assert.match(productionEntitlements, /com\.apple\.security\.application-groups/);
  assert.match(productionEntitlements, /group\.io\.github\.codex-router/);
  assert.doesNotMatch(productionEntitlements, /temporary-exception\.files/);
  assert.match(localEntitlements, /com\.apple\.security\.app-sandbox/);
  assert.match(
    localEntitlements,
    /com\.apple\.security\.temporary-exception\.files\.home-relative-path\.read-only/,
  );
  assert.match(
    localEntitlements,
    /\/Library\/Application Support\/Codex Router Widget\//,
  );
  assert.doesNotMatch(localEntitlements, /com\.apple\.security\.application-groups/);
  assert.doesNotMatch(localEntitlements, /home-relative-path\.read-write|absolute-path/);
});

test("releases are tag-driven and validate every asset before publishing", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );

  // CI remains validation for main and pull requests. Publishing is a separate
  // tag-triggered workflow, so an ordinary main push cannot create a release.
  assert.match(ci, /push:\s*\n\s+branches: \[main\]/);
  assert.match(ci, /pull_request:\s*\{\}/);
  assert.doesNotMatch(ci, /uses:\s+\.\/\.github\/workflows\/release\.yml/);
  assert.match(release, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/);
  assert.doesNotMatch(release, /workflow_call:/);
  assert.doesNotMatch(release, /branches:\s*\[?main/);
  assert.match(release, /Verify tag matches package version/);
  assert.match(release, /test "v\$package_version" = "\$GITHUB_REF_NAME"/);
  assert.match(release, /actions: read/);
  assert.match(release, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/);
  assert.match(release, /test "\$tag_commit" = "\$GITHUB_SHA"/);
  assert.match(release, /test "\$tag_commit" = "\$main_commit"/);
  assert.match(release, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}/);
  assert.match(release, /select\(\.conclusion == "success"/);
  assert.match(release, /needs: release-preflight/);
  assert.match(release, /needs: \[release-preflight, unified-app, unified-app-macos\]/);
  assert.ok(
    release.indexOf("- run: npm test") < release.indexOf("gh release create"),
    "the release must pass the full test suite before publishing assets",
  );
  assert.match(release, /git archive --format=tar\.gz/);
  assert.match(release, /git archive --format=zip/);
  assert.match(release, /name: Unsigned tester app \(\$\{\{ matrix\.platform \}\}\)/);
  assert.match(release, /electron-builder --win --publish never/);
  assert.match(release, /electron-builder --linux --publish never/);
  assert.match(release, /Smoke the packaged Linux application/);
  assert.match(release, /Smoke the packaged Windows application/);
  assert.match(release, /--no-sandbox --tray-only/);
  assert.match(release, /--no-sandbox --quit-for-update/);
  assert.match(release, /-ArgumentList "--tray-only"/);
  assert.match(release, /-ArgumentList "--quit-for-update"/);
  assert.match(release, /install -m 0755/);
  assert.match(release, /model-router-\$\{version\}-linux-x64\.tar\.gz/);
  assert.match(release, /name: Signed and notarized macOS app/);
  assert.match(release, /runs-on: macos-latest/);
  assert.match(release, /MODEL_ROUTER_TRAY_UNIVERSAL: "1"/);
  assert.match(release, /MODEL_ROUTER_PORTABLE_APP: "1"/);
  assert.match(release, /MACOS_CERTIFICATE_P12_BASE64/);
  assert.match(release, /xcrun notarytool submit/);
  assert.match(release, /xcrun stapler staple/);
  assert.match(release, /spctl --assess --type execute/);
  assert.match(release, /model-router-\$\{version\}-macos-universal\.zip/);
  assert.match(release, /unsigned tester artifacts/);
  assert.match(release, /matching Codex Router version/);
  assert.match(release, /sha256sum codex-router-\* model-router-\* > SHA256SUMS/);
  assert.doesNotMatch(release, /codex-router-desktop|build-desktop-tray/);
  assert.match(release, /actions\/attest-build-provenance@v4/);
  assert.match(release, /gh release create "\$GITHUB_REF_NAME" dist\/\* --verify-tag/);
  assert.match(release, /generate-formula\.mjs/);
  assert.match(release, /git push origin main/);
  assert.doesNotMatch(release, /HOMEBREW_TAP_TOKEN/);

  // macOS stays a CI-only artifact until it can be signed for distribution.
  // CI requests both architectures and verifies the actual nested executables,
  // rather than trusting the builder's output filename.
  assert.match(ci, /MODEL_ROUTER_TRAY_UNIVERSAL: "1"/);
  assert.match(ci, /CFBundleShortVersionString/);
  assert.match(ci, /ModelRouterControlVersion/);
  assert.match(ci, /CFBundleVersion/);
  assert.match(ci, /test "\$actual_build_version" = "\$GITHUB_RUN_NUMBER"/);
  assert.match(ci, /lipo "\$app\/Contents\/MacOS\/ModelRouterTray" -verify_arch x86_64 arm64/);
  assert.match(
    ci,
    /lipo "\$widget\/Contents\/MacOS\/RouterUsageWidget" -verify_arch x86_64 arm64/,
  );
  assert.match(ci, /widget-entitlements\.plist/);
  assert.match(ci, /ModelRouterWidgetStorageMode/);
  assert.match(ci, /temporary-exception\.files\.home-relative-path\.read-only:0/);
  assert.match(ci, /production_entitlements=.*RouterUsageWidget\.entitlements/);
  assert.match(ci, /local_entitlements=.*RouterUsageWidget\.local\.entitlements/);
  assert.match(
    ci,
    /lipo "\$app\/Contents\/Resources\/Control Center\.app\/Contents\/MacOS\/Codex Router" -verify_arch x86_64 arm64/,
  );
  assert.match(ci, /Smoke the unified macOS app lifecycle/);
  assert.match(ci, /"\$outer" --supervised/);
  assert.match(ci, /"\$embedded" --query-lifecycle/);
  assert.match(ci, /terminate_bundle io\.github\.codex-router\.control-center/);
  assert.match(ci, /terminate_bundle io\.github\.codex-router\.tray/);
  assert.match(ci, /assert_single_outer_host/);
  assert.equal(
    (ci.match(/^[ ]+assert_single_outer_host$/gm) || []).length,
    2,
    "each macOS reopen must prove it did not create a second native host",
  );
  assert.match(ci, /test "\$second_pid" != "\$first_pid"/);

  // A process merely disappearing is not a successful lifecycle smoke test.
  assert.match(ci, /if wait "\$pid"; then/);
  assert.match(ci, /if \(\$open\.ExitCode -ne 0\)/);
  assert.match(ci, /if \(\$quit\.ExitCode -ne 0\)/);
  assert.match(ci, /if \(\$process\.ExitCode -ne 0\)/);
});
