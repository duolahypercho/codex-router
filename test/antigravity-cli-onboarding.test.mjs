import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(testRoot, extra = {}) {
  const stateDir = path.join(testRoot, "state");
  return {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex"),
    MODEL_ROUTER_STATE_DIR: stateDir,
    ANTIGRAVITY_TOKEN_PATH: path.join(stateDir, "antigravity-oauth.json"),
    KIMI_CODE_HOME: path.join(testRoot, "kimi-code"),
    GROK_AUTH_PATH: path.join(testRoot, "grok", "auth.json"),
    ...extra,
  };
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function expectedLoginCommand() {
  return process.platform === "win32"
    ? ".\\codex-router.ps1 providers login antigravity-oauth"
    : "./bin/providers login antigravity-oauth";
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

test("providers login enters browser OAuth without changing provider selection", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-login-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const selectionPath = path.join(stateDir, "enabled-providers.json");
  writeFileSync(
    selectionPath,
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );

  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const port = occupied.address().port;
  try {
    // Occupying the callback port makes the child stop before opening a
    // browser or contacting Google, while still proving the CLI reached the
    // router-managed authorization-code flow.
    const result = runNode(
      ["src/providers.mjs", "login", "antigravity-oauth"],
      isolatedEnvironment(testRoot, {
        ANTIGRAVITY_REDIRECT_URI: `http://127.0.0.1:${port}/oauth-callback`,
      }),
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Open this URL to sign in to Antigravity/);
    assert.match(result.stderr, /EADDRINUSE|address already in use/i);
    assert.deepEqual(JSON.parse(readFileSync(selectionPath, "utf8")).providers, ["deepseek"]);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("installation docs publish working POSIX and PowerShell login commands", () => {
  for (const file of ["README.md", path.join("docs", "INSTALL.md")]) {
    const contents = readFileSync(path.join(root, file), "utf8");
    assert.match(contents, /\.\/bin\/model-router codex providers login antigravity-oauth/);
    assert.match(contents, /\.\\model-router\.ps1 codex providers login antigravity-oauth/);
  }
});
