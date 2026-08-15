import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = path.join(root, "src", "setup.mjs");

// The installers update the managed checkout before running setup and restore
// it on failure. Exit 2 is the contract that tells them the checkout is fine
// and only configuration is unfinished, so the update survives a declined
// prompt or a bad invocation. Asserting it here keeps that contract from
// drifting away from install.sh and install.ps1, which read the number.
const SETUP_INCOMPLETE_EXIT = 2;

function runSetup(args) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "setup-exit-"));
  try {
    return spawnSync(process.execPath, [SETUP, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_HOME: stateDir,
      },
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("an unknown option leaves the checkout update in place", () => {
  const result = runSetup(["--not-a-real-flag"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
  assert.match(result.stderr, /Unknown setup option/);
});

test("--providers without a value leaves the checkout update in place", () => {
  const result = runSetup(["--providers"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
  assert.match(result.stderr, /--providers requires a comma-separated value/);
});

test("an unknown provider id leaves the checkout update in place", () => {
  const result = runSetup(["--providers", "definitely-not-a-provider"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
});

test("--no-provider contradicts naming or picking providers", () => {
  const withProviders = runSetup(["--no-provider", "--providers", "deepseek"]);
  assert.equal(withProviders.status, SETUP_INCOMPLETE_EXIT);
  assert.match(withProviders.stderr, /--no-provider cannot be combined with --providers/);

  const withGuided = runSetup(["--no-provider", "--guided"]);
  assert.equal(withGuided.status, SETUP_INCOMPLETE_EXIT);
  assert.match(withGuided.stderr, /--no-provider cannot be combined with --guided/);
});

test("--no-discovery alone leaves the checkout update in place", () => {
  // Discovery off with providers still selected would manufacture an install
  // where nothing can ever authenticate; the flag pair is the contract.
  const result = runSetup(["--no-discovery"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
  assert.match(result.stderr, /--no-discovery requires --no-provider/);
});

// Deliberately absent: a "no configured provider" case driven through
// `--providers configured`. Credentials for OAuth providers are discovered
// from each CLI's own state, not from MODEL_ROUTER_STATE_DIR, so on a machine
// that is signed in anywhere the run does NOT fail -- it proceeds through the
// real installer and rewrites the developer's launch agent and Codex config.
// Anything that can reach `main()` past provider selection installs for real;
// keep the cases in this file to argument and selection errors, which exit
// before that point.

// A stored credential would make this run succeed instead of reporting the
// gap, so the case is skipped rather than asserted against whatever the
// developer's machine happens to hold. Keychain entries are global and no
// state-directory override hides them.
const deepseekConfigured =
  spawnSync(process.execPath, [path.join(root, "src", "provider-key.mjs"), "deepseek", "status"], {
    cwd: root,
    encoding: "utf8",
  }).status === 0;

test(
  "a scripted run with an unconfigured provider stays strict but keeps the update",
  { skip: deepseekConfigured },
  () => {
    // --selection-only returns before the install block, so this exercises the
    // credential step without touching launchd or the Codex config.
    const result = runSetup(["--providers", "deepseek", "--selection-only"]);
    assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
    assert.match(result.stderr, /DeepSeek API is selected but not configured/);
  },
);

test("--help still succeeds", () => {
  const result = runSetup(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: setup/);
});
