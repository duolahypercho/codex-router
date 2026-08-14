import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildDshRoute } from "../src/dsh-catalog.mjs";
import {
  applyCredential,
  applyDefaultModel,
  applyRouteToSettings,
  removeCredential,
  removeRouteFromSettings,
} from "../src/dsh-config-manager.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "http://127.0.0.1:4202/_codex-router/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v1";
const ROUTE = buildDshRoute({
  baseUrl: BASE_URL,
  models: [
    {
      slug: "vendor/model",
      displayName: "Vendor Model",
      contextWindow: 262144,
      inputModalities: ["text"],
      reasoningLevels: [{ effort: "high" }],
    },
  ],
});

// A settings document with somebody else's work in every position the router
// writes near: a leading comment, another adapter's section, a hand-written
// sibling route with its own annotation, and a section that follows ours.
const USER_SETTINGS = [
  "# my harness settings",
  "llm-deepseek:",
  "  apiKeyEnv: DEEPSEEK_API_KEY",
  "",
  "llm-pi-ai:",
  "  providers:",
  "    # a route I added by hand",
  "    my-proxy:",
  "      api: openai-completions",
  "      baseURL: https://proxy.example/v1",
  "      models:",
  "        - id: foo",
  "",
  "agent-default-model:",
  "  provider: deepseek-official",
  "  model: deepseek-v4-flash",
  "",
].join("\n");

test("publishing preserves every other section, route, and comment", () => {
  const after = applyRouteToSettings(USER_SETTINGS, ROUTE);
  assert.ok(after.includes("# my harness settings"));
  assert.ok(after.includes("llm-deepseek:"));
  assert.ok(after.includes("    # a route I added by hand"));
  assert.ok(after.includes("    my-proxy:"));
  assert.ok(after.includes("agent-default-model:"));
  assert.ok(after.includes("    codex-router:"));
});

test("publishing twice is byte-identical", () => {
  const once = applyRouteToSettings(USER_SETTINGS, ROUTE);
  assert.equal(applyRouteToSettings(once, ROUTE), once);
});

test("removing the route restores the document exactly", () => {
  const after = applyRouteToSettings(USER_SETTINGS, ROUTE);
  assert.equal(removeRouteFromSettings(after), USER_SETTINGS);
});

test("a fresh document round-trips to empty", () => {
  const after = applyRouteToSettings("", ROUTE);
  assert.ok(after.startsWith("llm-pi-ai:\n  providers:\n    codex-router:\n"));
  // The keys publishing created are removed with it: an `llm-pi-ai:` holding
  // nothing reads as null to the adapter's section schema, not as "no routes".
  assert.equal(removeRouteFromSettings(after), "");
});

test("publishing follows the indentation the document already uses", () => {
  const wide = ["llm-pi-ai:", "    providers:", "        other:", "            api: x", ""].join("\n");
  const after = applyRouteToSettings(wide, ROUTE);
  assert.ok(after.includes("\n        codex-router:\n"));
  assert.ok(after.includes("\n          api: \"openai-responses\"\n"));
});

test("an inline providers mapping is refused rather than rewritten", () => {
  assert.throws(
    () => applyRouteToSettings("llm-pi-ai:\n  providers: {}\n", ROUTE),
    /inline value rather than a block/,
  );
});

test("a settings document this build cannot read plainly is refused untouched", () => {
  assert.throws(() => applyRouteToSettings("a: 1\na: 2\n", ROUTE), /defined twice/);
});

test("a credential is set beside the user's other keys and removed cleanly", () => {
  const before = "# keys\nDEEPSEEK_API_KEY: sk-aaa\nOPENAI_API_KEY: sk-bbb\n";
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.ok(after.includes("DEEPSEEK_API_KEY: sk-aaa"));
  assert.ok(after.includes('CODEX_ROUTER_CALLER_KEY: "secret-value"'));
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), before);
});

test("rotating a credential replaces the value in place", () => {
  const first = applyCredential("", "CODEX_ROUTER_CALLER_KEY", "one");
  const second = applyCredential(first, "CODEX_ROUTER_CALLER_KEY", "two");
  assert.equal(second, 'CODEX_ROUTER_CALLER_KEY: "two"\n');
});

test("a credentials file holding nested mappings is not a credentials file", () => {
  assert.throws(
    () => applyCredential("provider:\n  key: value\n", "CODEX_ROUTER_CALLER_KEY", "x"),
    /nested mapping/,
  );
});

test("the default model selection names the router route", () => {
  const after = applyDefaultModel(USER_SETTINGS, { model: "vendor/model" });
  assert.ok(after.includes('agent-default-model:\n  provider: "codex-router"\n  model: "vendor/model"\n'));
  assert.ok(after.includes("llm-deepseek:"));
  assert.ok(!after.includes("deepseek-v4-flash"));
});

// --- end to end, against sandboxed harness and state directories ------------

const CALLER_SECRET = "a".repeat(48);

function sandbox() {
  const dshHome = mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "dsh-state-"));
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_SECRET}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "sk-test\n", { mode: 0o600 });
  return { dshHome, stateDir };
}

function manage(command, { dshHome, stateDir }) {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "src", "dsh-config-manager.mjs"), ...command.split(" ")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_ALLOW_FOREIGN_STATE: "1",
      },
    },
  );
  return JSON.parse(output);
}

test("install writes both documents owner-only, and uninstall takes them back out", () => {
  const box = sandbox();
  try {
    const installed = manage("install", box);
    assert.ok(installed.models > 0);
    assert.equal(installed.route, "codex-router");

    const settingsPath = path.join(box.dshHome, "settings.yaml");
    const credentialsPath = path.join(box.dshHome, ".credentials.yaml");
    const settings = readFileSync(settingsPath, "utf8");
    assert.ok(settings.includes("    codex-router:"));
    assert.ok(settings.includes('api: "openai-responses"'));
    // The base URL carries the caller capability, so the document must hold
    // the real one -- this is the file the harness authenticates from -- and
    // the secret in it must be the one the router actually accepts.
    assert.ok(settings.includes(`/_codex-router/${CALLER_SECRET}/v1"`));
    const credentials = readFileSync(credentialsPath, "utf8");
    assert.ok(credentials.includes(`CODEX_ROUTER_CALLER_KEY: ${JSON.stringify(CALLER_SECRET)}`));
    if (process.platform !== "win32") {
      // Both carry local authentication: the settings document holds the
      // caller capability inside its base URL, the other holds the key it
      // references.
      assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
      assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
    }

    const status = manage("status", box);
    assert.equal(status.routeInstalled, true);
    assert.equal(status.credentialInstalled, true);
    assert.equal(status.publishedModels, status.routableModels);
    // Never the whole capability, in any surface a person can copy out.
    assert.ok(!status.baseUrl.includes("aaaaaaaa"));
    assert.ok(status.baseUrl.includes("[REDACTED]"));

    manage("uninstall", box);
    const after = manage("status", box);
    assert.equal(after.routeInstalled, false);
    assert.equal(after.credentialInstalled, false);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

test("install refuses when no provider is selected rather than publishing nothing", () => {
  const box = sandbox();
  writeFileSync(
    path.join(box.stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  try {
    assert.throws(() => manage("install", box), /No routed models/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

// A default model is the user's own choice. The router may take it over only
// when asked, and giving it back must never overwrite a choice made since.
function settingsOf(box) {
  return readFileSync(path.join(box.dshHome, "settings.yaml"), "utf8");
}

test("uninstall gives back a default the router took over", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    assert.match(settingsOf(box), /agent-default-model:\n  provider: "codex-router"/);
    manage("uninstall", box);
    // The sandbox document has no default of its own, so taking ours out
    // leaves none -- not one pointing at a route that was just removed.
    assert.doesNotMatch(settingsOf(box), /provider: "codex-router"/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

test("uninstall leaves a default the user chose after the router took over", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    // The harness's own Models page writes this same key. Somebody switching
    // to a non-routed model afterwards must not have that undone by an
    // uninstall restoring a snapshot taken before they chose it.
    const chosen = 'agent-default-model:\n  provider: "deepseek-official"\n  model: "deepseek-v4-flash"\n';
    const settingsPath = path.join(box.dshHome, "settings.yaml");
    writeFileSync(
      settingsPath,
      settingsOf(box).replace(
        /agent-default-model:\n(?:  .*\n)+/,
        chosen,
      ),
      "utf8",
    );

    const result = manage("uninstall", box);
    assert.equal(result.defaultModelRestored, false);
    const after = settingsOf(box);
    assert.match(after, /provider: "deepseek-official"/);
    assert.match(after, /model: "deepseek-v4-flash"/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

test("uninstall removes a router-owned default even with no snapshot to restore", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    // Consume the snapshot the way a first uninstall does, then put the
    // router's default back. Leaving it would point the harness at a provider
    // this very uninstall removed.
    manage("uninstall", box);
    manage("install --set-default-model", box);
    rmSync(path.join(box.stateDir, "dsh-default-model.json"), { force: true });

    manage("uninstall", box);
    const after = settingsOf(box);
    assert.doesNotMatch(after, /provider: "codex-router"/);
    assert.doesNotMatch(after, /agent-default-model:/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});
