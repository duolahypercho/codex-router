import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  lockedRequirements,
  EXCLUDED_OPTIONAL_RESOURCES,
  markerApplies,
  pypiResource,
  renderFormula,
} from "../packaging/homebrew/generate-formula.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Homebrew lock selection follows its declared Python version", () => {
  assert.equal(markerApplies("python_full_version >= '3.12'", "3.14"), true);
  assert.equal(markerApplies("python_full_version == '3.11.*'", "3.14"), false);
  assert.equal(markerApplies("sys_platform != 'win32'", "3.14"), true);
  assert.equal(markerApplies("sys_platform == 'win32'", "3.14"), false);
  assert.throws(
    () => markerApplies("platform_system == 'mystery'", "3.14"),
    /Unsupported Python lock marker/,
  );

  const selected = lockedRequirements(
    readFileSync(path.join(root, "requirements", "python.txt"), "utf8"),
    "3.14",
  );
  const versions = new Map(selected.map(({ name, version }) => [name, version]));
  assert.equal(versions.get("litellm"), "1.96.0");
  assert.equal(versions.get("fastapi"), "0.139.2");
  assert.equal(versions.get("numpy"), "2.5.1");
  assert.equal(versions.get("rpds-py"), "2026.6.3");
  assert.equal(versions.has("pywin32"), false);
  assert.equal(versions.has("uvloop"), true);
  assert.equal(EXCLUDED_OPTIONAL_RESOURCES.has("pyroscope-io"), true);
});

test("PyPI resource resolution requires a checksummed source distribution", async () => {
  const sourceHash = "c".repeat(64);
  const respondWith = (files) => async () => ({
    ok: true,
    json: async () => ({ urls: files }),
  });
  const wheel = {
    filename: "example-1.2.3-py3-none-any.whl",
    packagetype: "bdist_wheel",
    url: "https://files.example/example.whl",
    digests: { sha256: "d".repeat(64) },
  };
  const sdist = {
    filename: "example-1.2.3.tar.gz",
    packagetype: "sdist",
    url: "https://files.example/example.tar.gz",
    digests: { sha256: sourceHash },
  };

  const resource = await pypiResource(
    { name: "example", version: "1.2.3", hashes: new Set([sourceHash]) },
    respondWith([wheel, sdist]),
  );
  assert.equal(resource.url, "https://files.example/example.tar.gz");
  assert.equal(resource.sha256, sourceHash);

  await assert.rejects(
    () =>
      pypiResource(
        { name: "example", version: "1.2.3", hashes: new Set([sourceHash]) },
        respondWith([wheel]),
      ),
    /publishes no source distribution/,
  );
});

test("a source distribution outside the Python lock is refused", async () => {
  const files = [
    {
      filename: "example-1.2.3.tar.gz",
      packagetype: "sdist",
      url: "https://files.example/example.tar.gz",
      digests: { sha256: "e".repeat(64) },
    },
  ];
  const respond = async () => ({ ok: true, json: async () => ({ urls: files }) });

  // PyPI answering with a distribution the lock never recorded is the case the
  // lock exists to catch; generation runs unattended, so it must not be trusted.
  await assert.rejects(
    () =>
      pypiResource(
        { name: "example", version: "1.2.3", hashes: new Set(["f".repeat(64)]) },
        respond,
      ),
    /is not in the Python lock/,
  );

  await assert.rejects(
    () => pypiResource({ name: "example", version: "1.2.3" }, respond),
    /records no hashes/,
  );
});

test("the lock's hashes stay attached to the requirement that declared them", () => {
  const contents = [
    "kept==1.0.0 \\",
    "    --hash=sha256:" + "1".repeat(64) + " \\",
    "    --hash=sha256:" + "2".repeat(64),
    "skipped==2.0.0 ; sys_platform == 'win32' \\",
    "    --hash=sha256:" + "3".repeat(64),
    "litellm==1.96.0 \\",
    "    --hash=sha256:" + "4".repeat(64),
  ].join("\n");

  const selected = lockedRequirements(contents, "3.14");
  assert.deepEqual(
    selected.map(({ name }) => name),
    ["kept", "litellm"],
  );
  assert.deepEqual([...selected[0].hashes].sort(), [
    "1".repeat(64),
    "2".repeat(64),
  ]);
  // The Windows-only entry is dropped, and its hash must not land on litellm.
  assert.deepEqual([...selected[1].hashes], ["4".repeat(64)]);
});

test("the generated formula owns upgrades and preserves one-time setup", () => {
  const formula = renderFormula({
    version: "0.4.0-beta.3",
    sourceUrl: "https://example.test/codex-router.tar.gz",
    sourceSha256: "a".repeat(64),
    pythonFormula: "python@3.14",
    pythonVersion: "3.14",
    resources: [
      {
        name: "litellm",
        version: "1.96.0",
        url: "https://example.test/litellm.tar.gz",
        sha256: "b".repeat(64),
      },
    ],
    excludedResources: [{ name: "pyroscope-io", version: "0.8.16" }],
  });
  assert.match(formula, /class CodexRouter < Formula/);
  assert.doesNotMatch(formula, /^\s*version\s+/m);
  assert.match(formula, /depends_on "libyaml"/);
  assert.match(formula, /if OS\.mac\?/);
  assert.doesNotMatch(formula, /Formula\["node"\]\.opt_bin/);
  assert.match(formula, /install_plan\.exist\?/);
  assert.match(formula, /source_root=\$\(CDPATH= cd -- .* && pwd -P\)/);
  assert.match(formula, /CODEX_ROUTER_SOURCE_ROOT/);
  assert.match(formula, /CODEX_ROUTER_SOURCE_ROOT="\$source_root"/);
  assert.match(formula, /CODEX_ROUTER_PACKAGE_MANAGER=homebrew/);
  assert.match(formula, /install_plan = libexec\/"src\/install-plan\.mjs"/);
  assert.match(formula, /if install_plan\.exist\?/);
  assert.match(formula, /install_plan, "record", "node-deps"/);
  assert.match(formula, /exec "\$source_root\/bin\/model-router" codex "\$@"/);
  assert.match(formula, /manifest\.dig\("current", "packageManager"\) != "homebrew"/);
  assert.match(formula, /codex-router setup --guided/);
  assert.match(formula, /codex-router uninstall/);
  assert.match(formula, /codex-router providers list --json/);
  assert.match(formula, /resource "litellm" do/);
  assert.match(formula, /pyroscope-io==0\.8\.16/);
});
