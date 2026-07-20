import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Claude path defaults ignore legacy Codex-only port overrides", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { PORTS } from "./src/paths.mjs"; process.stdout.write(JSON.stringify(PORTS));',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "claude",
        MODEL_ROUTER_GATEWAY_PORT: "",
        MODEL_ROUTER_OAUTH_PORT: "",
        MODEL_ROUTER_PORT: "",
        MODEL_ROUTER_API_PORT: "",
        CODEX_ROUTER_GATEWAY_PORT: "49991",
        CODEX_ROUTER_OAUTH_PORT: "49992",
        CODEX_ROUTER_PORT: "49993",
        CODEX_ROUTER_API_PORT: "49994",
      },
    },
  );

  assert.deepEqual(JSON.parse(output), {
    gateway: 4111,
    oauth: 4112,
    router: 4110,
    api: 4113,
  });
});

test("Claude provider selection ignores the Codex-only show-all override", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-target-isolation-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { selectedListedModels } from "./src/provider-selection.mjs"; process.stdout.write(JSON.stringify(selectedListedModels().map((model) => model.provider)));',
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_TARGET: "claude",
          MODEL_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_SHOW_ALL_MODELS: "",
          CODEX_ROUTER_SHOW_ALL_MODELS: "1",
        },
      },
    );
    assert.deepEqual(JSON.parse(output), ["deepseek", "deepseek"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
