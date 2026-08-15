import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callerSecret = "doctor-idle-caller-capability-with-sufficient-length";

// The stub leaves a tombstone when `codex login` runs against the user's real
// CODEX_HOME: under --no-discovery every probe that would make Codex read its
// session file must be skipped, so the tombstone staying absent is part of
// what this file proves. Schema probes that point CODEX_HOME at a scratch
// directory read no credentials and are allowed through.
function writeCodexStub(directory, loginSentinel, realHome, accountSentinel) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "codex-idle.cmd" : "codex-idle");
  const models = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "list", priority: 10 },
    ],
  });
  // `debug models` and `debug models --bundled` are different promises: the
  // bare form answers with the signed-in account's catalog, the --bundled
  // form with the binary's static list. The stub records every bare call so
  // the no-discovery tests can prove only the bundled form ever ran.
  writeFileSync(
    target,
    windows
      ? `@echo off\r\nif "%1"=="--version" (echo codex-cli 99.0.0& exit /b 0)\r\nif "%1"=="login" (if "%CODEX_HOME%"=="${realHome}" echo probed> "${loginSentinel}"\r\nexit /b 0)\r\nif "%1"=="debug" if not "%3"=="--bundled" echo probed>> "${accountSentinel}"\r\nif "%1"=="debug" (echo ${models}& exit /b 0)\r\nexit /b 1\r\n`
      : `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 99.0.0' ;;
  login) [ "\${CODEX_HOME:-}" = '${realHome}' ] && echo probed > '${loginSentinel}'; exit 0 ;;
  debug) [ "\${3:-}" = '--bundled' ] || echo probed >> '${accountSentinel}'; printf '%s\\n' '${models}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return target;
}

function child(script, args, env) {
  return spawnSync(process.execPath, [path.join(root, "src", script), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function stageIdleHome() {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-doctor-idle-"));
  const stateDir = path.join(codexHome, "router-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n', {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerSecret}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "internal-secret"),
    "doctor-idle-internal-service-key-with-sufficient-length\n",
    { mode: 0o600 },
  );
  const loginSentinel = path.join(codexHome, "login-probed");
  const accountSentinel = path.join(codexHome, "account-catalog-probed");
  const env = {
    ...process.env,
    CODEX_BIN: writeCodexStub(codexHome, loginSentinel, codexHome, accountSentinel),
    CODEX_HOME: codexHome,
    CODEX_ROUTER_PORT: "46193",
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_TARGET: "codex",
  };
  return { codexHome, stateDir, env, loginSentinel, accountSentinel };
}

test(
  "an idle --no-provider --no-discovery install passes the doctor at warn",
  { timeout: 60_000 },
  () => {
    const { codexHome, env, loginSentinel, accountSentinel } = stageIdleHome();
    env.CODEX_ROUTER_NO_DISCOVERY = "1";
    try {
      const catalog = child("catalog.mjs", ["--refresh-native"], env);
      assert.equal(catalog.status, 0, catalog.stderr);
      assert.equal(
        existsSync(accountSentinel),
        false,
        "the catalog capture spawned the account-aware `codex debug models`",
      );
      const gateway = child("litellm-config.mjs", [], env);
      assert.equal(gateway.status, 0, gateway.stderr);
      const enabled = child("config-manager.mjs", ["enable"], env);
      assert.equal(enabled.status, 0, enabled.stderr);

      const doctor = child("doctor.mjs", ["--json"], env);
      const report = JSON.parse(doctor.stdout);
      const byName = new Map(report.checks.map((check) => [check.name, check]));

      const providers = byName.get("Enabled providers");
      assert.equal(providers.status, "warn");
      assert.equal(providers.detail, "none (idle install: --no-provider)");

      const catalogCheck = byName.get("Merged catalog");
      assert.equal(catalogCheck.status, "ok");
      assert.equal(catalogCheck.detail, "idle install; no routed models");

      const discovery = byName.get("Credential discovery");
      assert.equal(discovery.status, "warn");
      assert.match(discovery.detail, /--no-discovery/);

      // The per-provider credential sweep is itself discovery; under the
      // kill-switch it is replaced by the single row above.
      assert.equal(byName.get("Kimi OAuth"), undefined);
      assert.equal(byName.get("Grok OAuth"), undefined);
      assert.ok(
        !report.checks.some((check) => /API key|anonymous endpoint|endpoint$/.test(check.name)),
        "a per-provider credential row leaked past --no-discovery",
      );

      assert.equal(byName.get("Codex sign-in probe").status, "ok");
      assert.equal(byName.get("Codex sign-in probe").detail, "discovery-disabled");
      assert.equal(existsSync(loginSentinel), false, "the sign-in probe still spawned codex login");
      assert.equal(
        existsSync(accountSentinel),
        false,
        "something spawned the account-aware `codex debug models` under --no-discovery",
      );

      // The idle state fails nothing that touches providers; anything failed
      // must be environmental -- no running service, no installed skill pack,
      // and on CI no LiteLLM virtual environment either.
      const failed = report.checks.filter((check) => check.status === "fail");
      const allowed = new Set([
        "Background service",
        "Router health",
        "Codex skill pack",
        "LiteLLM venv runtime",
        // The staged secrets get POSIX modes, not the Windows ACL the real
        // writers apply, so these two rows are staging noise on win32 only.
        ...(process.platform === "win32"
          ? ["Internal service key", "Router caller key"]
          : []),
      ]);
      assert.deepEqual(
        failed.map((check) => check.name).filter((name) => !allowed.has(name)),
        [],
        `unexpected failures: ${JSON.stringify(failed)}`,
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);

test(
  "an empty selection without --no-discovery still fails the doctor",
  { timeout: 60_000 },
  () => {
    const { codexHome, env } = stageIdleHome();
    try {
      const doctor = child("doctor.mjs", ["--json"], env);
      const report = JSON.parse(doctor.stdout);
      const byName = new Map(report.checks.map((check) => [check.name, check]));
      // Hiding every provider by hand is a state worth flagging loudly; only
      // the flagged idle install downgrades it.
      assert.equal(byName.get("Enabled providers").status, "fail");
      assert.equal(byName.get("Enabled providers").detail, "none");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);
