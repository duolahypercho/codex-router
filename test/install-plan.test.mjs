import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PYTHON_REQUIREMENTS,
  installedDistributionVersion,
  installerRequirementDrift,
  recordStep,
  requirementParts,
  stepStatus,
} from "../src/install-plan.mjs";

function checkout() {
  const root = mkdtempSync(path.join(tmpdir(), "install-plan-"));
  writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  return root;
}

function installNodeModules(root) {
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".package-lock.json"), "{}\n");
}

// Derived from the pins rather than written out, because a hand-copied version
// turns every future bump into a failure of these tests rather than of the
// thing they cover. Drift detection is exactly what they exercise: a fixture
// frozen at the old version *is* drift, and asserting "skip" against it asserts
// that the installer ignores a changed pin.
const PINNED_VERSIONS = Object.fromEntries(
  PYTHON_REQUIREMENTS.map((requirement) => {
    const { name, version } = requirementParts(requirement);
    return [name, version];
  }),
);

function installVenv(root, versions = PINNED_VERSIONS) {
  const site = path.join(root, ".venv", "lib", "python3.12", "site-packages");
  mkdirSync(site, { recursive: true });
  mkdirSync(path.join(root, ".venv", "bin"), { recursive: true });
  writeFileSync(path.join(root, ".venv", "bin", "python"), "");
  writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "version_info = 3.12\n");
  for (const [name, version] of Object.entries(versions)) {
    mkdirSync(path.join(site, `${name}-${version}.dist-info`), { recursive: true });
  }
}

test("a missing installation always runs its step", () => {
  const root = checkout();
  try {
    assert.equal(stepStatus("node-deps", { root, platform: "darwin" }), "run");
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recorded steps are skipped until their inputs change", () => {
  const root = checkout();
  try {
    installNodeModules(root);
    installVenv(root);
    recordStep("node-deps", { root });
    recordStep("python-deps", { root });

    assert.equal(stepStatus("node-deps", { root, platform: "darwin" }), "skip");
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "skip");

    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n');
    assert.equal(stepStatus("node-deps", { root, platform: "darwin" }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stamp cannot vouch for dependencies that are no longer installed", () => {
  const root = checkout();
  try {
    installNodeModules(root);
    installVenv(root);
    recordStep("node-deps", { root });
    recordStep("python-deps", { root });

    // A drifted transitive upgrade that downgraded a pinned distribution must
    // reinstall even though the stamp still matches the pins.
    rmSync(
      path.join(
        root,
        ".venv",
        "lib",
        "python3.12",
        "site-packages",
        `litellm-${PINNED_VERSIONS.litellm}.dist-info`,
      ),
      { recursive: true, force: true },
    );
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "run");

    rmSync(path.join(root, "node_modules", ".package-lock.json"), { force: true });
    assert.equal(stepStatus("node-deps", { root, platform: "darwin" }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuilt virtual environment on another Python reinstalls", () => {
  const root = checkout();
  try {
    installVenv(root);
    recordStep("python-deps", { root });
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "version = 3.13.1\n");
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a virtual environment whose interpreter home was cleared reinstalls", () => {
  const root = checkout();
  try {
    installVenv(root);
    recordStep("python-deps", { root });
    // macOS wipes /private/tmp; an installer that recorded a temporary Python
    // as the venv home leaves the interpreter dangling after reboot. The stamp
    // must not vouch for a venv that cannot run.
    writeFileSync(
      path.join(root, ".venv", "pyvenv.cfg"),
      "home = /private/tmp/codex-router-python-bin\nversion = 3.12.12\n",
    );
    assert.equal(stepStatus("python-deps", { root, platform: "darwin" }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distribution lookup normalizes names and ignores extras", () => {
  const root = checkout();
  try {
    installVenv(root, { litellm: "1.95.0", "litellm_proxy_extras": "0.4.81" });
    assert.equal(requirementParts("litellm[proxy]==1.95.0").name, "litellm");
    assert.equal(
      installedDistributionVersion("litellm-proxy-extras", { root, platform: "darwin" }),
      "0.4.81",
    );
    assert.equal(installedDistributionVersion("absent", { root, platform: "darwin" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The pins themselves live in requirements/python.txt now; what the installers
// have to agree on is that they both install that lock with hash checking.
// test/python-lock.test.mjs covers the lock's own agreement with these pins.
test("both installers install the Python tree from the hashed lock", () => {
  assert.equal(PYTHON_REQUIREMENTS.length, 2);
  assert.deepEqual(installerRequirementDrift(), []);
});
