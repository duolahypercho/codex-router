import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "../src/file-security.mjs";
import { recordStep } from "../src/install-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(testRoot, extra = {}) {
  const stateDir = path.join(testRoot, "state");
  return {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex"),
    MODEL_ROUTER_STATE_DIR: stateDir,
    KIMI_CODE_HOME: path.join(testRoot, "kimi-code"),
    GROK_AUTH_PATH: path.join(testRoot, "grok", "auth.json"),
    CODEX_ROUTER_NO_DISCOVERY: "0",
    ...extra,
  };
}

function runNode(args, env, { cwd = root } = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function isolatedCheckout(testRoot) {
  const checkout = path.join(testRoot, "checkout");
  mkdirSync(checkout, { recursive: true });
  for (const directory of ["src", "config", "node_modules"]) {
    cpSync(path.join(root, directory), path.join(checkout, directory), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json"]) {
    copyFileSync(path.join(root, file), path.join(checkout, file));
  }
  // `npm ci` owns and empties the checkout's entire node_modules tree. This
  // command-path test runs beside every other test file, so it must never let
  // the production dependency preflight mutate the suite's live checkout.
  // The copied tree is already the exact CI install; record that fact only in
  // the disposable checkout used by this child.
  recordStep("node-deps", { root: checkout });
  return checkout;
}

function expectedLoginCommand() {
  return process.platform === "win32"
    ? ".\\codex-router.ps1 providers login antigravity-oauth"
    : "./bin/providers login antigravity-oauth";
}

function expectedProbeCommand() {
  return process.platform === "win32"
    ? ".\\codex-router.ps1 providers probe antigravity-oauth --live --yes"
    : "./bin/providers probe antigravity-oauth --live --yes";
}

test("unconfigured Antigravity commands name the router-managed browser login", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-hint-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  try {
    const env = isolatedEnvironment(testRoot);
    const setup = runNode(
      ["src/setup.mjs", "--providers", "antigravity-oauth", "--selection-only"],
      env,
    );
    assert.equal(setup.status, 2, setup.stderr);
    assert.match(setup.stderr, new RegExp(expectedLoginCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(setup.stderr, /official Antigravity CLI|provider's official CLI/i);

    const enable = runNode(["src/providers.mjs", "enable", "antigravity-oauth"], env);
    assert.equal(enable.status, 1, enable.stderr);
    assert.match(enable.stderr, new RegExp(expectedLoginCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a signed-in but unverified session remains disabled and names the live probe", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-probe-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const selectionPath = path.join(stateDir, "enabled-providers.json");
  writeFileSync(selectionPath, `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`, {
    mode: 0o600,
  });
  writePrivateJson(path.join(stateDir, "antigravity-oauth.json"), {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: "operator-owned.apps.googleusercontent.com",
    client_secret: "test-client-secret",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
  });
  try {
    const env = isolatedEnvironment(testRoot);
    const enable = runNode(["src/providers.mjs", "enable", "antigravity-oauth"], env);
    assert.equal(enable.status, 1, enable.stderr);
    assert.match(enable.stderr, /explicit live compatibility test/i);
    assert.match(enable.stderr, new RegExp(expectedProbeCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(JSON.parse(readFileSync(selectionPath, "utf8")).providers, ["deepseek"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("direct Antigravity login refuses a rejected client until explicit disconnect", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-rejected-client-"));
  const checkout = isolatedCheckout(testRoot);
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writePrivateJson(path.join(stateDir, "antigravity-oauth.json"), {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    project_revision: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    client_id: "operator-owned.apps.googleusercontent.com",
    client_secret: "rejected-client-secret",
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    expires_in: 0,
    rejection_reason: "invalid_client",
  });
  try {
    const login = runNode(
      ["src/providers.mjs", "login", "antigravity-oauth"],
      isolatedEnvironment(testRoot),
      { cwd: checkout },
    );
    assert.equal(login.status, 1, login.stderr);
    assert.match(login.stderr, /rejected.*disconnect.*valid operator-owned/i);
    assert.doesNotMatch(login.stdout, /127\.0\.0\.1|oauth-start|oauth-client/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Antigravity probe cannot make a network request without explicit live consent", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-consent-"));
  try {
    const result = runNode(
      ["src/providers.mjs", "probe", "antigravity-oauth"],
      isolatedEnvironment(testRoot),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /both --live and --yes/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Antigravity probe refuses misspelled consent and provisioning flags", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-flags-"));
  try {
    const result = runNode(
      [
        "src/providers.mjs",
        "probe",
        "antigravity-oauth",
        "--live",
        "--yes",
        "--provison-project",
      ],
      isolatedEnvironment(testRoot),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown Antigravity probe option: --provison-project/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("installation docs publish the operator-client login and explicit probe", () => {
  for (const file of ["README.md", path.join("docs", "INSTALL.md")]) {
    const contents = readFileSync(path.join(root, file), "utf8");
    assert.match(contents, /Google OAuth \*\*Desktop app\*\*/);
    assert.match(contents, /\.\/bin\/model-router codex providers login antigravity-oauth/);
    assert.match(contents, /\.\\model-router\.ps1 codex providers login antigravity-oauth/);
    assert.match(contents, /providers probe antigravity-oauth --live --yes/);
    assert.doesNotMatch(contents, /ANTIGRAVITY_CLIENT_SECRET\s*=/);
  }
});

test("the installation agent contract forbids vendor credential reuse and impersonation", () => {
  const contents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(contents, /operator-owned Google OAuth client/i);
  assert.match(contents, /never read or reuse the official `agy`\/IDE credential\s+store/i);
  assert.match(contents, /OS-assigned port/i);
  assert.match(contents, /truthfully\s+as Codex Router/i);
  assert.match(contents, /probe antigravity-oauth --live --yes/);
});

test("desktop onboarding keeps the Antigravity probe explicit on every platform", () => {
  const ipc = readFileSync(path.join(root, "apps", "control-center", "electron", "ipc.mjs"), "utf8");
  const page = readFileSync(
    path.join(root, "apps", "control-center", "src", "pages", "ModelsPage.tsx"),
    "utf8",
  );
  const tray = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const startup = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(ipc, /provider\.action === "probe"/);
  assert.match(ipc, /\["probe-provider", id, "--live", "--yes"\]/);
  assert.match(ipc, /return updateProviderSelection\(id, true\)/);
  assert.match(ipc, /ROUTER_BROWSER_OAUTH_TIMEOUT_MS/);
  assert.match(page, /setup\.action === "probe" \? t\("models\.connection\.runLiveTest"\)/);
  assert.match(page, /setup\.disconnectable/);
  assert.match(tray, /case "probe": return routerLocalized\("Test & Enable"\)/);
  assert.match(tray, /setup\?\.disconnectable == true/);
  assert.match(startup, /const antigravityStartup = antigravityOAuthStartupState\(\)/);
  assert.match(startup, /attemptAntigravityProbePromotionAfterReadiness/);
  assert.match(startup, /\.\.\.\(antigravityForwarder/);
  const providers = readFileSync(path.join(root, "src", "providers.mjs"), "utf8");
  const control = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  const activation = readFileSync(
    path.join(root, "src", "antigravity-probe-activation.mjs"),
    "utf8",
  );
  const onboarding = readFileSync(
    path.join(root, "src", "antigravity-oauth-onboarding.mjs"),
    "utf8",
  );
  const providerOnboarding = readFileSync(
    path.join(root, "src", "provider-onboarding.mjs"),
    "utf8",
  );
  assert.match(providers, /restartRouterServiceIfInstalled\(operation\)/);
  assert.match(providers, /activateAntigravityProbe/);
  assert.match(control, /activateAntigravityProbe/);
  assert.match(activation, /Installed clients remain withdrawn/);
  assert.ok(activation.indexOf("await restart(") < activation.indexOf("await publish("));
  assert.ok(
    activation.indexOf("const activated = await waitForExactActivation") <
      activation.indexOf("await publish("),
  );
  assert.match(activation, /throwIfAborted\(signal, deadline\)/);
  assert.match(onboarding, /oauth_browser_launch_failed/);
  assert.ok(
    providerOnboarding.indexOf("await ensureNodeDependencies({ signal, deadline });") <
      providerOnboarding.indexOf('import("./antigravity-oauth-onboarding.mjs")'),
  );
});
