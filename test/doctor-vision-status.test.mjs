import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callerSecret = "doctor-vision-caller-capability-with-sufficient-length";

function writeCodexStub(directory, models, { authenticated = true } = {}) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "codex-vision.cmd" : "codex-vision");
  const payload = JSON.stringify({ models });
  writeFileSync(
    target,
    windows
      ? `@echo off\r\nif "%1"=="--version" (echo codex-cli 99.0.0& exit /b 0)\r\nif "%1"=="login" exit /b ${authenticated ? 0 : 1}\r\nif "%1"=="debug" (echo ${payload}& exit /b 0)\r\nexit /b 1\r\n`
      : `#!/bin/sh\ncase "$1" in\n  --version) echo 'codex-cli 99.0.0' ;;\n  login) exit ${authenticated ? 0 : 1} ;;\n  debug) printf '%s\\n' '${payload}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return target;
}

function isolatedEnvironment(codexHome, stateDir, launchAgents, codexBin) {
  // On Windows, include the System32 directory on PATH so cmd.exe can be found
  // even in isolated test environments with restricted PATH
  const systemPaths = [];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    systemPaths.push(path.join(systemRoot, "System32"));
  }
  
  return {
    PATH: [path.dirname(process.execPath), ...systemPaths].filter(Boolean).join(path.delimiter),
    HOME: codexHome,
    USERPROFILE: codexHome,
    TEMP: codexHome,
    TMP: codexHome,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.platform === "win32"
      ? { ComSpec: process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe") }
      : {}),
    CODEX_BIN: codexBin,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_SERVICE_PLATFORM: process.platform === "win32" ? "darwin" : "win32",
    MODEL_ROUTER_LAUNCH_AGENTS_DIR: launchAgents,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_PORT: "46993",
  };
}

test("Codex doctor gates installed native vision engines on the live sign-in probe", { timeout: 30_000 }, () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-doctor-vision-"));
  const stateDir = path.join(codexHome, "router-state");
  const launchAgents = path.join(codexHome, "launch-agents");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  const luna = {
    slug: "gpt-5.6-luna",
    display_name: "GPT-5.6-Luna",
    visibility: "list",
    priority: 10,
    input_modalities: ["text", "image"],
  };
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-luna"\n', { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerSecret}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "internal-secret"),
    "doctor-vision-internal-service-key-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "merged-models.json"), `${JSON.stringify({ models: [luna] })}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "native-models.json"), `${JSON.stringify({ models: [luna] })}\n`, { mode: 0o600 });
  const codexBin = writeCodexStub(codexHome, [luna]);
  const env = isolatedEnvironment(codexHome, stateDir, launchAgents, codexBin);

  try {
    const doctor = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.ok(doctor.stdout.trim(), doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    assert.equal(byName.get("Codex sign-in probe").detail, "authenticated");
    assert.equal(byName.get("Vision bridge").status, "ok");
    assert.equal(byName.get("Vision bridge").detail, "text-only models read images via gpt-5.6-luna");

    // Keep both native catalog files stale on disk but make the live sign-in probe fail.
    // The request path cannot spend a native engine without a live session, so doctor
    // must not treat catalog membership alone as evidence that the engine is usable.
    writeCodexStub(codexHome, [luna], { authenticated: false });
    const signedOut = spawnSync(
      process.execPath,
      [path.join(root, "src", "doctor.mjs"), "--json"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.ok(signedOut.stdout.trim(), signedOut.stderr);
    const signedOutReport = JSON.parse(signedOut.stdout);
    const signedOutByName = new Map(signedOutReport.checks.map((check) => [check.name, check]));
    assert.equal(signedOutByName.get("Codex sign-in probe").detail, "signed-out");
    assert.equal(signedOutByName.get("Vision bridge").status, "ok");
    assert.equal(
      signedOutByName.get("Vision bridge").detail,
      "on by default, but no enabled vision engine is available yet",
    );
    assert.doesNotMatch(signedOutByName.get("Vision bridge").detail, /pinned engine/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
