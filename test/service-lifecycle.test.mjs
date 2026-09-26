import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROXY = "http://127.0.0.1:3213";

// `bin/start` resolves `node` from PATH. A shim that records its arguments and
// exits instead of running them turns "which layer does this verb reach" into
// an observable fact, without touching this machine's launchd.
function withNodeShim(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-lifecycle-"));
  const log = path.join(directory, "argv.log");
  const shim = path.join(directory, "node");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(shim, 0o755);
  writeFileSync(log, "");
  try {
    return run({
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
      readLog: () => readFileSync(log, "utf8").trim(),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("start and stop act on the same layer", { skip: process.platform === "win32" }, () => {
  withNodeShim(({ env, readLog }) => {
    execFileSync(path.join(root, "bin", "start"), [], { env, encoding: "utf8" });
    const started = readLog();
    // Not `src/start.mjs`. A `start` that execs the supervisor leaves the
    // service that `stop` unloaded still unloaded, and puts an unmanaged copy
    // carrying the calling shell's environment in its place.
    assert.match(started, /src\/service\.mjs start$/);
    assert.doesNotMatch(started, /start\.mjs$/);
  });

  withNodeShim(({ env, readLog }) => {
    execFileSync(path.join(root, "bin", "stop"), [], { env, encoding: "utf8" });
    assert.match(readLog(), /src\/service\.mjs stop$/);
  });
});

test("the foreground supervisor is reachable, but only on purpose", { skip: process.platform === "win32" }, () => {
  withNodeShim(({ env, readLog }) => {
    execFileSync(path.join(root, "bin", "start"), ["--foreground"], { env, encoding: "utf8" });
    assert.match(readLog(), /src\/foreground-start\.mjs$/);
  });

  // An unrecognized argument is refused rather than quietly falling through to
  // either layer.
  withNodeShim(({ env, readLog }) => {
    const result = spawnSync(path.join(root, "bin", "start"), ["--deamon"], { env, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: start \[--foreground\]/);
    assert.equal(readLog(), "");
  });
});

test("foreground supervisor holds service lifecycle ownership", () => {
  const startScript = readFileSync(path.join(root, "bin", "start"), "utf8");
  const supervisor = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  const launcher = readFileSync(path.join(root, "src", "foreground-start.mjs"), "utf8");
  assert.match(startScript, /src\/foreground-start\.mjs/);
  assert.match(launcher, /withServiceOperationLock/);
  assert.match(launcher, /import\("\.\/start\.mjs"\)/);
  assert.doesNotMatch(supervisor, /withServiceOperationLock/);
});

test("foreground supervisor waits for existing lifecycle ownership before booting", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-foreground-lock-"));
  let child;
  let stderr = "";
  try {
    await withServiceOperationLock(async () => {
      child = spawn(process.execPath, [path.join(root, "src", "foreground-start.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          MODEL_ROUTER_TARGET: "codex",
          MODEL_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(child.exitCode, null, "foreground supervisor must wait while lifecycle ownership is held");
    }, { stateDir, waitMs: 0, retryMs: 20, staleMs: 5_000 });

    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, /LiteLLM is not installed/i);
  } finally {
    if (child?.exitCode === null) child.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Windows start dispatches managed and foreground modes without bypassing lifecycle ownership", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-windows-start-"));
  const log = path.join(directory, "node.log");
  const shim = path.join(directory, "node.cmd");
  writeFileSync(shim, `@echo off\r\necho %*>>${JSON.stringify(log)}\r\nexit /b 0\r\n`);
  writeFileSync(log, "");
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
  try {
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "codex-router.ps1"), "start"], { env, encoding: "utf8" });
    let lines = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    // PowerShell quotes paths containing spaces; node.cmd receives that quote.
    assert.match(lines[0], /src\\service\.mjs"? start$/i);

    writeFileSync(log, "");
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "codex-router.ps1"), "start", "--foreground"], { env, encoding: "utf8" });
    lines = readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /src\\foreground-start\.mjs"?$/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a supervisor started with no proxy environment adopts the installed one", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-lifecycle-state-"));
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDir, "install-manifest.json"),
      JSON.stringify({
        version: 1,
        current: {
          proxyEnvironment: {
            HTTP_PROXY: `http://user:hunter2@127.0.0.1:3213`,
            HTTPS_PROXY: PROXY,
            NODE_USE_ENV_PROXY: "1",
          },
        },
        history: [],
      }),
    );

    // Nothing here names a proxy -- exactly what a shell spawned by a desktop
    // app hands the supervisor. Startup stops at the missing gateway binary,
    // which is well after the restore and costs no ports or children.
    const result = spawnSync(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
      },
      encoding: "utf8",
    });

    assert.match(result.stderr, /restored the installed one \(http:\/\/127\.0\.0\.1:3213\)/);
    // The manifest may hold a proxy password. The log is not where it leaks.
    assert.doesNotMatch(result.stderr, /hunter2/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a declared proxy environment is left exactly as the operator set it", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-lifecycle-state-"));
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDir, "install-manifest.json"),
      JSON.stringify({
        version: 1,
        current: { proxyEnvironment: { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: "1" } },
        history: [],
      }),
    );

    // This is the managed path: the service definition already carries the
    // proxy, so there is nothing to restore and nothing to announce.
    const result = spawnSync(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
        HTTPS_PROXY: PROXY,
        NODE_USE_ENV_PROXY: "1",
      },
      encoding: "utf8",
    });
    assert.doesNotMatch(result.stderr, /restored the installed one/);

    // And an operator who turned the proxy off keeps it off.
    const off = spawnSync(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
        NODE_USE_ENV_PROXY: "0",
      },
      encoding: "utf8",
    });
    assert.doesNotMatch(off.stderr, /restored the installed one/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
