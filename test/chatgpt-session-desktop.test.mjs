import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
  projectChatGptSessionAction,
  projectChatGptSessionStatus,
} from "../src/chatgpt-session-control.mjs";

const SAFE_FIELDS = ["expiresInHours", "present", "session", "sharing"];

test("desktop session status projects consent separately and never leaks credential metadata", () => {
  const secret = "session-token-that-must-never-cross-control";
  const status = projectChatGptSessionStatus({
    sharingEnabled: true,
    usable: true,
    expired: false,
    present: true,
    expiresInHours: 8.5,
    accessToken: secret,
    accountId: "account-secret",
    hasAccountId: true,
    path: "/private/auth.json",
    ageHours: 1,
  });
  assert.deepEqual(Object.keys(status).sort(), SAFE_FIELDS);
  assert.deepEqual(status, {
    sharing: "enabled",
    session: "usable",
    present: true,
    expiresInHours: 8.5,
  });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${secret}|account-secret|auth\\.json`));

  // An older implicit-fallback flag is not authorization. Missing the new
  // sharing field must always read disabled.
  assert.equal(projectChatGptSessionStatus({ fallbackEnabled: true, usable: true }).sharing, "disabled");
  assert.deepEqual(projectChatGptSessionStatus({ expired: true, present: true }).session, "expired");
  assert.deepEqual(projectChatGptSessionStatus({ usable: false, expired: false }).session, "unavailable");
});

test("desktop session mutation results are fail-closed and contain only safe fields", () => {
  const result = projectChatGptSessionAction({
    sharing: "future-value",
    session: "future-value",
    present: "yes",
    expiresInHours: Number.POSITIVE_INFINITY,
    refreshed: true,
    token: "do-not-leak",
    path: "/secret",
  });
  assert.deepEqual(Object.keys(result).sort(), [...SAFE_FIELDS, "refreshed"].sort());
  assert.deepEqual(result, {
    sharing: "disabled",
    session: "unavailable",
    present: false,
    expiresInHours: undefined,
    refreshed: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak|\/secret/);
});

test("desktop mutations delegate catalog publication to the upstream consent transaction", async () => {
  const adapter = await readFile(new URL("../src/chatgpt-session-control.mjs", import.meta.url), "utf8");
  assert.match(adapter, /import\("\.\/chatgpt-session\.mjs"\)/);
  assert.match(adapter, /sessionModule\.setChatGptSessionSharing\(enabled\)/);
  assert.doesNotMatch(adapter, /writeFile|rmSync|NATIVE_SESSION_CONSENT_PATH/);
});

test("control exposes a safe fixed session-status verb", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-chatgpt-control-"));
  const auth = path.join(directory, "auth.json");
  const secret = "secret-access-token";
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 7_200 }))
    .toString("base64url");
  await writeFile(auth, JSON.stringify({
    tokens: { access_token: `header.${payload}.${secret}`, account_id: "secret-account" },
  }));
  try {
    const result = spawnSync(process.execPath, ["src/control.mjs", "chatgpt-session", "status"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(directory, "codex-home"),
        MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
        MODEL_ROUTER_CODEX_AUTH: auth,
        CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(status).sort(), SAFE_FIELDS);
    assert.equal(status.sharing, "disabled");
    assert.equal(status.session, "usable");
    assert.equal(status.present, true);
    assert.doesNotMatch(result.stdout, /secret-access-token|secret-account|auth\.json/);

    const refused = spawnSync(process.execPath, ["src/control.mjs", "chatgpt-session", "automatic"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, MODEL_ROUTER_STATE_DIR: path.join(directory, "state") },
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /status\|enable\|disable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop control can enable and revoke the rebased explicit sharing consent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-chatgpt-mutation-"));
  const auth = path.join(directory, "auth.json");
  const state = path.join(directory, "state");
  const secret = "mutation-secret-access-token";
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 7_200 }))
    .toString("base64url");
  await writeFile(auth, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: `header.${payload}.${secret}`, account_id: "mutation-secret-account" },
  }));
  const environment = {
    ...process.env,
    CODEX_HOME: path.join(directory, "codex-home"),
    MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_CODEX_AUTH: auth,
    // Pin discovery on independently of the developer machine running this
    // test. The control must still require the explicit consent mutation.
    CODEX_ROUTER_NO_DISCOVERY: "0",
  };
  delete environment.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  const invoke = (action) => spawnSync(
    process.execPath,
    ["src/control.mjs", "chatgpt-session", action],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env: environment },
  );

  try {
    const enabled = invoke("enable");
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.deepEqual(
      { sharing: JSON.parse(enabled.stdout).sharing, session: JSON.parse(enabled.stdout).session },
      { sharing: "enabled", session: "usable" },
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(state, "native-session-consent.json"), "utf8")),
      { version: 1, sharing: "enabled" },
    );
    assert.doesNotMatch(enabled.stdout, /mutation-secret-access-token|mutation-secret-account/);

    const disabled = invoke("disable");
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout).sharing, "disabled");
    await assert.rejects(
      readFile(path.join(state, "native-session-consent.json"), "utf8"),
      (error) => error?.code === "ENOENT",
    );
    assert.doesNotMatch(disabled.stdout, /mutation-secret-access-token|mutation-secret-account/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron reconciles consent after installed-client publication fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-chatgpt-partial-"));
  const auth = path.join(directory, "auth.json");
  const state = path.join(directory, "state");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 7_200 }))
    .toString("base64url");
  await mkdir(state, { recursive: true });
  await writeFile(auth, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: `header.${payload}.partial-secret`, account_id: "partial-account" },
  }));
  // Presence of this snapshot marks DSH installed. Its republish is guaranteed
  // to fail in the isolated state directory, after consent has been persisted,
  // because no router caller capability or routable catalog exists there.
  await writeFile(path.join(state, "dsh-models.json"), "{}\n");
  const environment = {
    ...process.env,
    CODEX_HOME: path.join(directory, "codex-home"),
    DSH_HOME: path.join(directory, "dsh-home"),
    MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_CODEX_AUTH: auth,
    CODEX_ROUTER_NO_DISCOVERY: "0",
  };
  delete environment.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  const invoke = (action) => spawnSync(
    process.execPath,
    ["src/control.mjs", "chatgpt-session", action],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env: environment },
  );

  try {
    const failed = invoke("enable");
    assert.notEqual(failed.status, 0, "catalog publication must provide the partial-failure control");
    const status = invoke("status");
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).sharing, "enabled", "consent changed before publication failed");
    assert.doesNotMatch(`${failed.stdout}${failed.stderr}${status.stdout}`, /partial-secret|partial-account/);

    const app = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
    const action = app.slice(app.indexOf("const runAction"), app.indexOf("const navItems"));
    const rejected = action.slice(action.indexOf("} catch (error)"), action.indexOf("return;", action.indexOf("} catch (error)")));
    assert.match(rejected, /setOperation\(\{ action: label, status: "failed", message \}\);[\s\S]*await Promise\.allSettled\(\[refreshCore\(\), refreshUsage\(\)\]\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron exposes only fixed consent IPC and requires an enable confirmation", async () => {
  const preload = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  const calls = [];
  let api;
  vm.runInNewContext(preload, {
    process: { platform: "linux" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: {
          invoke: async (channel, input) => calls.push([channel, input]),
          on() {},
          removeListener() {},
        },
      };
    },
  });
  await api.getChatGptSession();
  await api.setChatGptSessionSharing(true);
  await api.setChatGptSessionSharing(false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["router-control:getChatGptSession", null],
    ["router-control:setChatGptSessionSharing", { enabled: true }],
    ["router-control:setChatGptSessionSharing", { enabled: false }],
  ]);

  const ipc = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  const handler = ipc.match(/handleAction\("setChatGptSessionSharing"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handler, "session-sharing IPC handler should be readable");
  assert.match(handler, /typeof enabled !== "boolean"/);
  assert.match(handler, /\["chatgpt-session", enabled \? "enable" : "disable"\]/);
  assert.doesNotMatch(handler, /input\.action|\{ action \}/);

  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(settings, /setConfirmSessionSharing\(true\)/);
  assert.match(settings, /settings\.chatgptSession\.status\.sharingEnabled/);
  assert.match(settings, /settings\.chatgptSession\.status\.sharingDisabled/);
  assert.match(settings, /settings\.chatgptSession\.status\.loginUsable/);
  assert.match(settings, /settings\.chatgptSession\.status\.loginExpired/);
  assert.doesNotMatch(settings, /Sharing enabled|Sharing disabled|Login usable|Login expired/);
  assert.match(settings, /chatgptSession\.session !== "usable"/);
  assert.match(settings, /api\.setChatGptSessionSharing\(true\)/);
  assert.match(settings, /api\.setChatGptSessionSharing\(false\)/);
  const copy = await readFile(new URL("../apps/control-center/src/locales/en.ts", import.meta.url), "utf8");
  assert.match(copy, /other local Codex Router clients spend this user's ChatGPT subscription/);
});
