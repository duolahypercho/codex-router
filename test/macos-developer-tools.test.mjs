import assert from "node:assert/strict";
import test from "node:test";

import { selectFullXcodeDeveloperDir } from "../src/macos-developer-tools.mjs";

test("an explicit usable DEVELOPER_DIR wins without probing fallback Xcodes", () => {
  const probed = [];
  const selection = selectFullXcodeDeveloperDir({
    explicitDeveloperDir: "/opt/Xcode-custom.app/Contents/Developer",
    activeDeveloperDir: "/Library/Developer/CommandLineTools",
    standardDeveloperDirs: ["/Applications/Xcode.app/Contents/Developer"],
    isUsable(candidate) {
      probed.push(candidate);
      return candidate.startsWith("/opt/");
    },
  });

  assert.deepEqual(selection, {
    developerDir: "/opt/Xcode-custom.app/Contents/Developer",
    source: "environment",
    activeDeveloperDir: "/Library/Developer/CommandLineTools",
  });
  assert.deepEqual(probed, ["/opt/Xcode-custom.app/Contents/Developer"]);
});

test("an explicit unusable DEVELOPER_DIR fails instead of silently changing toolchains", () => {
  const probed = [];
  assert.throws(
    () =>
      selectFullXcodeDeveloperDir({
        explicitDeveloperDir: "/Library/Developer/CommandLineTools",
        activeDeveloperDir: "/Applications/Xcode.app/Contents/Developer",
        standardDeveloperDirs: ["/Applications/Xcode.app/Contents/Developer"],
        isUsable(candidate) {
          probed.push(candidate);
          return candidate.includes("Xcode.app");
        },
      }),
    /DEVELOPER_DIR.*does not provide xcodebuild/,
  );
  assert.deepEqual(probed, ["/Library/Developer/CommandLineTools"]);
});

test("the active full Xcode remains selected", () => {
  const selection = selectFullXcodeDeveloperDir({
    activeDeveloperDir: "/Applications/Xcode-selected.app/Contents/Developer",
    standardDeveloperDirs: ["/Applications/Xcode.app/Contents/Developer"],
    isUsable: () => true,
  });

  assert.equal(selection.developerDir, "/Applications/Xcode-selected.app/Contents/Developer");
  assert.equal(selection.source, "active");
});

test("standalone Command Line Tools fall back to a usable standard Xcode for this build", () => {
  const probed = [];
  const selection = selectFullXcodeDeveloperDir({
    activeDeveloperDir: "/Library/Developer/CommandLineTools",
    standardDeveloperDirs: [
      "/Applications/Xcode.app/Contents/Developer",
      "/Applications/Xcode-beta.app/Contents/Developer",
    ],
    isUsable(candidate) {
      probed.push(candidate);
      return candidate.includes("Xcode-beta.app");
    },
  });

  assert.equal(selection.developerDir, "/Applications/Xcode-beta.app/Contents/Developer");
  assert.equal(selection.source, "standard-location");
  assert.deepEqual(probed, [
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
    "/Applications/Xcode-beta.app/Contents/Developer",
  ]);
});

test("missing full Xcode fails with an actionable non-global override", () => {
  assert.throws(
    () =>
      selectFullXcodeDeveloperDir({
        activeDeveloperDir: "/Library/Developer/CommandLineTools",
        standardDeveloperDirs: [],
        isUsable: () => false,
      }),
    /DEVELOPER_DIR=.*model-router-tray/,
  );
});
