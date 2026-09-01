import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "src", "cursor-agent-launcher.mjs");

test("Cursor Agent launcher keeps the caller capability in child environment, never argv", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-agent-launcher-"));
  const secret = "cursor-agent-launcher-secret-with-sufficient-length";
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "caller-secret"), `${secret}\n`, { mode: 0o600 });
    const probe = [
      "process.stdout.write(JSON.stringify({",
      "  endpoint: process.env.CURSOR_API_ENDPOINT,",
      "  key: process.env.CURSOR_API_KEY,",
      "  argv: process.argv.slice(1),",
      "}));",
    ].join("\n");
    const result = spawnSync(process.execPath, [launcher, "--eval", probe, "sentinel"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "cursor",
        MODEL_ROUTER_STATE_DIR: directory,
        CURSOR_AGENT_BIN: process.execPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(result.stdout);
    assert.match(child.endpoint, new RegExp(`/_codex-router/${secret}$`));
    assert.equal(child.key, "codex-router-local-v3");
    assert.deepEqual(child.argv, ["sentinel"]);
    assert.equal(child.argv.some((argument) => argument.includes(secret)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
