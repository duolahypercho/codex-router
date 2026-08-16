import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Bound before the imports: user-models and provider-selection resolve their
// paths at module load and must never touch real state.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "cursor-models-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_USER_MODELS = path.join(stateDir, "user-models.json");

const {
  cursorServedModels,
  cursorSnapshot,
  isCursorModelEnabled,
  setCursorModelEnabled,
} = await import("../src/cursor-models.mjs");
const { readUserModels, writeUserModels } = await import("../src/user-models.mjs");
const { COMMANDS } = await import("../src/desktop-commands.mjs");

const served = (ids) => async () => ({
  ok: true,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
});
const signedOut = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ error: { message: "cursor-agent is installed but not signed in" } }),
});
const bridgeDown = async () => {
  throw new Error("connection refused");
};

test("the roster comes from the bridge, deduplicated and sorted", async () => {
  const result = await cursorServedModels({ fetchImpl: served(["gpt-5", "auto", "gpt-5", ""]) });
  assert.equal(result.reachable, true);
  assert.equal(result.signedIn, true);
  assert.deepEqual(result.models, ["auto", "gpt-5"]);
  assert.match(String(result.baseUrl), /^http:\/\/127\.0\.0\.1:4209/);
});

test("signed out and bridge down are different states with different fixes", async () => {
  const out = await cursorServedModels({ fetchImpl: signedOut });
  assert.equal(out.reachable, true, "the bridge answered, so it is running");
  assert.equal(out.signedIn, false);
  assert.match(out.detail, /not signed in/, "the CLI's own reason is passed through");

  const down = await cursorServedModels({ fetchImpl: bridgeDown });
  assert.equal(down.reachable, false);
  assert.equal(down.signedIn, false);
  assert.match(down.detail, /not running/);
});

test("checking a model publishes it, and unchecking removes it", async () => {
  writeUserModels([]);
  setCursorModelEnabled("gpt-5", true);
  assert.equal(isCursorModelEnabled("gpt-5"), true);
  const entry = readUserModels().find((m) => m.upstreamModel === "gpt-5");
  assert.equal(entry.provider, "cursor-cli");
  assert.equal(entry.slug, "cursor-cli/gpt-5");
  // The one thing a person must see before selecting it in the picker.
  assert.match(entry.displayName, /answers only/);
  assert.equal(entry.supportsApplyPatchTool, false);

  setCursorModelEnabled("gpt-5", false);
  assert.equal(isCursorModelEnabled("gpt-5"), false);
  assert.deepEqual(readUserModels(), []);
});

test("a re-enabled model does not collide with another model's priority", async () => {
  writeUserModels([]);
  for (const id of ["a-model", "b-model", "c-model"]) setCursorModelEnabled(id, true);
  setCursorModelEnabled("b-model", false);
  setCursorModelEnabled("b-model", true);
  const priorities = readUserModels().map((m) => m.priority);
  assert.equal(
    new Set(priorities).size,
    priorities.length,
    "priorities are renumbered on write, so a disable/re-enable cycle cannot collide",
  );
});

test("a curated model the account no longer offers stays visible", async () => {
  writeUserModels([]);
  setCursorModelEnabled("retired-model", true);
  const snapshot = await cursorSnapshot({ fetchImpl: served(["gpt-5"]) });
  const retired = snapshot.models.find((m) => m.id === "retired-model");
  assert.ok(retired, "hiding it would leave a picker route with no way to clear it");
  assert.equal(retired.served, false);
  assert.equal(retired.enabled, true);
  assert.equal(snapshot.models.find((m) => m.id === "gpt-5").enabled, false);
  writeUserModels([]);
});

test("the tray command accepts Cursor's parameterized ids and rejects argv injection", () => {
  assert.deepEqual(
    COMMANDS.set_cursor_model_enabled({ model: "gpt-5", enabled: true }).args,
    ["local-models", "cursor-set", "gpt-5", "on"],
  );
  assert.deepEqual(
    COMMANDS.set_cursor_model_enabled({
      model: "claude-opus-4-8[context=1m,effort=high]",
      enabled: false,
    }).args,
    ["local-models", "cursor-set", "claude-opus-4-8[context=1m,effort=high]", "off"],
  );
  for (const bad of ["gpt-5; rm -rf /", "--force", "", "a b", "gpt-5[unclosed"]) {
    assert.throws(
      () => COMMANDS.set_cursor_model_enabled({ model: bad, enabled: true }),
      /Unknown Cursor model/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

// --- panel wiring guards -------------------------------------------------
// apps/desktop/ui/app.js is an IIFE with no DOM harness here, so the panel is
// guarded structurally, the way desktop-ui.test.mjs guards the rest of it. The
// failure these catch is the classic one: a section that renders into an id
// nothing declares, a checkbox naming a command no host implements, or a
// listener wired to an element that was renamed.

const { readFileSync: readUiSource } = await import("node:fs");
const { fileURLToPath: uiPath } = await import("node:url");
const repo = uiPath(new URL("..", import.meta.url));
const read = (...parts) => readUiSource(path.join(repo, ...parts), "utf8");

test("the panel section exists, is listened to, and renders", () => {
  const html = read("apps", "desktop", "ui", "index.html");
  const app = read("apps", "desktop", "ui", "app.js");
  assert.match(html, /id="cursor-section"/, "the section element must exist");
  assert.match(app, /getElementById\("cursor-section"\)/, "app.js must bind it");
  assert.match(
    app,
    /elements\.cursorSection\.addEventListener\("change", handleCursorModelToggle\)/,
    "a section with no listener renders checkboxes that do nothing",
  );
  assert.match(app, /renderCursorSection\(local\.cursor/, "it must render from the snapshot key");
});

test("every host implements the command the checkbox names", () => {
  const app = read("apps", "desktop", "ui", "app.js");
  assert.match(app, /data-command="set_cursor_model_enabled"/);
  assert.match(app, /call\("set_cursor_model_enabled"/);
  // Electron dispatches generically through COMMANDS; Tauri needs the command
  // declared and registered by hand, and a missing registration fails only at
  // runtime with "command not found".
  assert.ok(COMMANDS.set_cursor_model_enabled, "desktop-commands must define it");
  const rust = read("apps", "desktop", "src-tauri", "src", "main.rs");
  assert.match(rust, /async fn set_cursor_model_enabled/, "Tauri must implement it");
  assert.match(
    rust,
    /^\s*set_cursor_model_enabled,$/m,
    "Tauri must also register it in the handler list",
  );
});

test("the snapshot key the panel reads is the key control.mjs writes", () => {
  const control = read("src", "control.mjs");
  assert.match(control, /cursor: await .*cursorSnapshot\(\)/, "the panel refresh must carry it");
  assert.match(control, /cursor-set/, "the toggle action must exist");
});
