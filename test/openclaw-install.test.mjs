import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  OPENCLAW_NPM_PACKAGE,
  assertOpenClawNodeSupported,
  installOpenClaw,
  nodeMeetsOpenClawMinimum,
  npmSupportsOpenClawAllowScripts,
} from "../src/openclaw-install.mjs";
import { npmGlobalBinaryAt } from "../src/npm-global-install.mjs";

test("OpenClaw Node support follows the current release matrix", () => {
  for (const version of ["22.22.3", "22.23.0", "24.15.0", "25.9.0", "26.0.0", "27.1.0"]) {
    assert.equal(nodeMeetsOpenClawMinimum(version), true, version);
  }
  for (const version of ["22.22.2", "23.9.0", "24.14.9", "25.8.9", "21.99.0", "bad"]) {
    assert.equal(nodeMeetsOpenClawMinimum(version), false, version);
  }
  assert.equal(assertOpenClawNodeSupported("26.0.0"), "26.0.0");
  assert.throws(() => assertOpenClawNodeSupported("23.9.0"), /needs Node/);
});

test("Windows npm fallback prefers a spawnable OpenClaw shim", () => {
  const directory = path.join("C:\\Users\\test", "AppData", "Roaming", "npm");
  const extensionless = path.join(directory, "openclaw");
  const commandShim = `${extensionless}.cmd`;
  const present = new Set([extensionless, commandShim]);
  assert.equal(
    npmGlobalBinaryAt(directory, "openclaw", {
      platform: "win32",
      exists: (candidate) => present.has(candidate),
    }),
    commandShim,
  );
});

test("OpenClaw npm allow-scripts flag starts at npm 11.16", () => {
  assert.equal(npmSupportsOpenClawAllowScripts("11.15.9"), false);
  assert.equal(npmSupportsOpenClawAllowScripts("11.16.0"), true);
  assert.equal(npmSupportsOpenClawAllowScripts("12.0.0"), true);
});

test("OpenClaw install is a no-op when the CLI already exists", () => {
  let calls = 0;
  const result = installOpenClaw({
    find: () => "/usr/local/bin/openclaw",
    install: () => { calls += 1; },
    nodeVersion: "26.0.0",
    detectedNpmVersion: "12.0.0",
  });
  assert.equal(result.changed, false);
  assert.equal(calls, 0);
});

test("OpenClaw install uses the official package and scoped lifecycle permission", () => {
  let binary;
  let invocation;
  const result = installOpenClaw({
    find: () => binary,
    install: (npmPackage, options) => {
      invocation = { npmPackage, options };
      binary = "/npm/bin/openclaw";
    },
    nodeVersion: "24.15.0",
    detectedNpmVersion: "11.16.1",
  });
  assert.equal(result.changed, true);
  assert.equal(invocation.npmPackage, OPENCLAW_NPM_PACKAGE);
  assert.deepEqual(invocation.options.extraArgs, ["--allow-scripts=openclaw"]);
});

test("OpenClaw install refuses unsupported Node before touching npm", () => {
  let called = false;
  assert.throws(() => installOpenClaw({
    find: () => undefined,
    install: () => { called = true; },
    nodeVersion: "23.9.0",
  }), /needs Node/);
  assert.equal(called, false);
});
