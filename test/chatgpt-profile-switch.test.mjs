import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatGPTSubscriptionAccountAuthPath,
  createChatGPTSubscriptionAccount,
} from "../src/chatgpt-account-pool.mjs";
import {
  codexDesktopRunning,
  chatGPTProfileSwitchSnapshot,
  readChatGPTProfileSwitchState,
  reconcileChatGPTProfileSwitch,
  requestChatGPTProfileSwitch,
} from "../src/chatgpt-profile-switch.mjs";

test("a selected profile waits for Codex to close and preserves both account profiles", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-switch-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });

  const pending = await requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  });
  assert.equal(pending.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);

  const applied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
  });
  assert.equal(applied.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(readFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), "utf8"), firstAuth);

  const restore = await requestChatGPTProfileSwitch(first.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
  });
  assert.equal(restore.active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, false);
  assert.equal(chatGPTProfileSwitchSnapshot({ switchPath, platform: "darwin", processList: "" }).running, false);

  await requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
  });
  const autoPending = await requestChatGPTProfileSwitch("auto", {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  });
  assert.equal(autoPending.pending, false);
  assert.equal(autoPending.active, second.id);
  const autoApplied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
  });
  assert.equal(autoApplied.desired, second.id);
  assert.equal(autoApplied.active, second.id);
});

test("profile detection only treats the desktop Codex process as open", () => {
  assert.equal(codexDesktopRunning({ platform: "darwin", processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }), true);
  assert.equal(codexDesktopRunning({ platform: "darwin", processList: "/usr/bin/codex app-server" }), false);
});
