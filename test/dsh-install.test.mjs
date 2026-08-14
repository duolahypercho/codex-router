import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "dsh-install-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
// `which` has to stay findable; neither of these ever holds a harness install.
// POSIX only: on Windows this would hide `powershell.exe` from the helpers that
// protect private files, failing tests over a detail they are not about.
const barePath = process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin";
if (process.platform !== "win32") process.env.PATH = barePath;
// PATH alone does not isolate this: the finder also asks npm where its global
// binaries live, and that answer is independent of PATH. Point npm at an empty
// prefix so the real harness on this machine cannot be mistaken for the fixture.
process.env.npm_config_prefix = mkdtempSync(path.join(os.tmpdir(), "dsh-install-prefix-"));

const {
  DSH_EXECUTABLE,
  DSH_NPM_PACKAGE,
  MINIMUM_NODE_MAJOR,
  MINIMUM_NODE_MINOR,
  harnessCliPath,
  harnessSnapshot,
  installHarness,
  nodeMeetsHarnessMinimum,
} = await import("../src/dsh-install.mjs");

const { DSH_CATALOG_PATH } = await import("../src/paths.mjs");

function installFakeHarness(version = "0.1.0-rc.6") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-install-bin-"));
  const binary = path.join(dir, DSH_EXECUTABLE);
  writeFileSync(binary, `#!/bin/sh\necho "${version}"\n`, { encoding: "utf8", mode: 0o755 });
  chmodSync(binary, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${barePath}`;
  return dir;
}

function removeFakeHarness(dir) {
  process.env.PATH = barePath;
  rmSync(dir, { recursive: true, force: true });
}

test("the package and executable are the ones the harness publishes", () => {
  assert.equal(DSH_NPM_PACKAGE, "@deepseek-ai/dsh");
  assert.equal(DSH_EXECUTABLE, "dsh");
});

test("the Node floor is compared by major and minor, not lexically", () => {
  // "22.9" sorts above "22.19" as a string, which is the whole reason this is
  // not a string comparison.
  assert.equal(nodeMeetsHarnessMinimum("22.9.0"), false);
  assert.equal(nodeMeetsHarnessMinimum("22.19.0"), true);
  assert.equal(nodeMeetsHarnessMinimum("22.23.1"), true);
  assert.equal(nodeMeetsHarnessMinimum("23.0.0"), true);
  assert.equal(nodeMeetsHarnessMinimum("20.19.0"), false);
  assert.equal(nodeMeetsHarnessMinimum("nonsense"), false);
  assert.equal(
    nodeMeetsHarnessMinimum(`${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}.0`),
    true,
  );
});

test(
  "the snapshot reports what is installed without pretending about the route",
  { skip: process.platform === "win32" },
  () => {
    assert.equal(harnessCliPath(), undefined);
    const absent = harnessSnapshot();
    assert.equal(absent.installed, false);
    assert.equal(absent.version, undefined);
    assert.equal(absent.published, false);

    const dir = installFakeHarness();
    const present = harnessSnapshot();
    assert.equal(present.installed, true);
    assert.equal(present.version, "0.1.0-rc.6");
    // Installed is not the same as routed here: the route is a separate write
    // into the harness's own documents, and the button offers it separately.
    assert.equal(present.published, false);

    writeFileSync(DSH_CATALOG_PATH, JSON.stringify({ models: [] }), "utf8");
    assert.equal(harnessSnapshot().published, true);
    rmSync(DSH_CATALOG_PATH, { force: true });

    removeFakeHarness(dir);
  },
);

test(
  "an already-installed harness is not reinstalled",
  { skip: process.platform === "win32" },
  () => {
    const dir = installFakeHarness();
    // No npm spawn: a second click on a machine that already has the CLI must
    // not reach the network before it publishes.
    const result = installHarness();
    assert.equal(result.installed, true);
    assert.equal(result.changed, false);
    assert.ok(result.binary.endsWith(path.join(path.basename(dir), DSH_EXECUTABLE)));
    removeFakeHarness(dir);
  },
);

test("a Node below the floor is refused before npm is reached", () => {
  const realNode = process.versions.node;
  Object.defineProperty(process.versions, "node", { value: "20.11.0", configurable: true });
  try {
    assert.throws(
      () => installHarness(),
      /needs Node 22\.19 or newer/,
      "the floor has to be named, and named before a spawn that would fail obscurely",
    );
  } finally {
    Object.defineProperty(process.versions, "node", { value: realNode, configurable: true });
  }
});
