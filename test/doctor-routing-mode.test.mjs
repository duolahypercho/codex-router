import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callerSecret = "doctor-routing-caller-capability-with-sufficient-length";

function writeCodexStub(directory) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "codex-doctor.cmd" : "codex-doctor");
  const models = JSON.stringify({
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        visibility: "list",
        priority: 10,
      },
    ],
  });
  writeFileSync(
    target,
    windows
      ? `@echo off\r\nif "%1"=="--version" (echo codex-cli 99.0.0& exit /b 0)\r\nif "%1"=="login" exit /b 0\r\nif "%1"=="debug" (echo ${models}& exit /b 0)\r\nexit /b 1\r\n`
      : `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 99.0.0' ;;
  login) exit 0 ;;
  debug) printf '%s\\n' '${models}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return target;
}

function child(script, args, env) {
  const childEnv = {
    ...env,
    // This test redirects Codex/router state, but Windows service status reads
    // the machine-wide Task Scheduler. A developer with the real router
    // running would otherwise make fixture doctor calls wait on the live task.
    ...(process.platform === "win32" && script === "doctor.mjs"
      ? { CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture" }
      : {}),
  };
  return spawnSync(process.execPath, [path.join(root, "src", script), ...args], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    // node:test cannot interrupt a synchronous child while the event loop is
    // blocked, so bound the subprocess itself as the final isolation guard.
    timeout: 20_000,
  });
}

test(
  "catalog then ordinary enable stays healthy and native-only when signed routing is off",
  { timeout: 30_000 },
  () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-doctor-direct-"));
    const stateDir = path.join(codexHome, "router-state");
    const configPath = path.join(codexHome, "config.toml");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      configPath,
      `model_provider = "custom"

[model_providers.custom]
name = "Direct foreign provider"
base_url = "https://foreign.invalid/v1"
wire_api = "responses"
`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-key\n", {
      mode: 0o600,
    });
    writeFileSync(path.join(stateDir, "caller-secret"), `${callerSecret}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "internal-secret"),
      "doctor-internal-service-key-with-sufficient-length\n",
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      CODEX_BIN: writeCodexStub(codexHome),
      CODEX_HOME: codexHome,
      CODEX_ROUTER_PORT: "46192",
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_TARGET: "codex",
    };

    try {
      const catalog = child("catalog.mjs", ["--refresh-native"], env);
      assert.equal(catalog.status, 0, catalog.stderr);
      assert.equal(JSON.parse(catalog.stdout).routed_catalog_active, false);

      const enabled = child("config-manager.mjs", ["enable"], env);
      assert.equal(enabled.status, 0, enabled.stderr);
      assert.equal(JSON.parse(enabled.stdout).signed_routing, false);
      assert.match(readFileSync(configPath, "utf8"), /^model_provider = "custom"$/m);

      const merged = JSON.parse(
        readFileSync(path.join(stateDir, "merged-models.json"), "utf8"),
      );
      // The captured native model, plus the extended-window variant the
      // router derives from it. Nothing routed, which is what this test is
      // about — and the variant ships switched off, so a build that publishes
      // it has still changed nothing the operator did not ask for.
      assert.deepEqual(merged.models.map((model) => model.slug), [
        "gpt-5.6-sol",
        "gpt-5.6-sol-1m",
      ]);
      assert.equal(
        merged.models.find((model) => model.slug === "gpt-5.6-sol-1m").visibility,
        "hide",
      );
      assert.equal(
        merged.models.find((model) => model.slug === "gpt-5.6-sol").visibility,
        "list",
      );
      assert.equal(
        readdirSync(path.join(codexHome, "agents")).filter((name) =>
          name.startsWith("router-model-"),
        ).length,
        0,
      );

      const nativeCapturePath = path.join(stateDir, "native-models.json");
      const nativeCapture = JSON.parse(readFileSync(nativeCapturePath, "utf8"));
      nativeCapture.captured_with = "codex-cli 98.0.0";
      writeFileSync(nativeCapturePath, `${JSON.stringify(nativeCapture)}\n`, { mode: 0o600 });

      const doctor = child("doctor.mjs", ["--json"], env);
      const report = JSON.parse(doctor.stdout);
      const byName = new Map(report.checks.map((check) => [check.name, check]));
      assert.deepEqual(byName.get("Merged catalog"), {
        status: "warn",
        name: "Merged catalog",
        detail: "native catalog captured by codex-cli 98.0.0; installed codex-cli 99.0.0",
        fix: "Run ./bin/refresh-catalog, then fully quit and reopen Codex.",
      });
      assert.equal(byName.get("Catalog matches gateway routes").status, "ok");
      assert.equal(byName.get("Catalog matches gateway routes").detail, "0 routed models");
      assert.equal(byName.get("Routed model agents").status, "ok");
      assert.match(byName.get("Routed model agents").detail, /^0 current definitions/);
      assert.equal(byName.get("Signed router coexistence").status, "ok");

      if (process.platform === "win32") {
        // Codex Desktop writes config.toml atomically. Recreate the resulting
        // inherited-ACL shape without changing the temporary directory ACL.
        const configured = readFileSync(configPath, "utf8");
        unlinkSync(configPath);
        writeFileSync(configPath, configured, { mode: 0o600 });

        const privacyDoctor = child("doctor.mjs", ["--json"], env);
        const privacyReport = JSON.parse(privacyDoctor.stdout);
        const privacy = privacyReport.checks.find((check) => check.name === "Codex config privacy");
        assert.deepEqual(privacy, {
          status: "ok",
          name: "Codex config privacy",
          detail: "router credentials stay outside config.toml",
        });

        const legacy = configured.replace(
          /^openai_base_url\s*=.*$/m,
          `openai_base_url = "http://127.0.0.1:46192/_codex-router/${callerSecret}/v1"`,
        );
        assert.notEqual(legacy, configured, "legacy fixture must replace the managed root URL");
        assert.match(legacy, /\/_codex-router\/[A-Za-z0-9_-]+\/v1/);
        unlinkSync(configPath);
        writeFileSync(configPath, legacy, { mode: 0o600 });
        assert.equal(readFileSync(configPath, "utf8"), legacy);
        const legacyDoctor = child("doctor.mjs", ["--json"], env);
        const legacyReport = JSON.parse(legacyDoctor.stdout);
        const legacyPrivacy = legacyReport.checks.find((check) => check.name === "Codex config privacy");
        assert.deepEqual(legacyPrivacy, {
          status: "fail",
          name: "Codex config privacy",
          detail: "Windows ACL is broader than the current user",
          fix: "Run ./bin/doctor --fix; the managed router URL contains a local caller capability.",
        });
      }
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);

test(
  "a routed catalog waiting for Codex restart is a warning, not a failed repair",
  { timeout: 30_000 },
  () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-doctor-restart-"));
    const stateDir = path.join(codexHome, "router-state");
    const configPath = path.join(codexHome, "config.toml");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["kimi-api"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(stateDir, "kimi-api-key.secret"), "test-key\n", {
      mode: 0o600,
    });
    // A registry model carrying `multiAgentVersion: "v2"`, not a local proof.
    // Local proof records are diagnostic and application material only --
    // promoting from them let a stream/tool probe masquerade as native
    // collaboration proof -- so a seeded `proven` entry no longer produces a
    // managed agent definition and there would be nothing here to remove.
    // The catalog now publishes routed models only after an explicit picker
    // selection. Keep this test focused on the doctor detecting a missing
    // managed agent definition, rather than relying on the old implicit-show
    // behavior.
    writeFileSync(
      path.join(stateDir, "model-picker.json"),
      `${JSON.stringify({
        version: 1,
        hidden: [],
        visible: ["kimi-api/kimi-k3"],
        seeded: ["kimi-api/kimi-k3"],
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(stateDir, "caller-secret"), `${callerSecret}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "internal-secret"),
      "doctor-internal-service-key-with-sufficient-length\n",
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      CODEX_BIN: writeCodexStub(codexHome),
      CODEX_HOME: codexHome,
      CODEX_ROUTER_PORT: "46193",
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_TARGET: "codex",
    };

    try {
      const catalog = child("catalog.mjs", ["--refresh-native", "--bundled-native"], env);
      assert.equal(catalog.status, 0, catalog.stderr);
      assert.equal(JSON.parse(catalog.stdout).routed_catalog_active, true);
      unlinkSync(path.join(codexHome, "agents", "router-model-kimi-api-kimi-k3.toml"));

      const routes = child("litellm-config.mjs", [], env);
      assert.equal(routes.status, 0, routes.stderr);
      const enabled = child("config-manager.mjs", ["enable"], env);
      assert.equal(enabled.status, 0, enabled.stderr);

      const doctor = child("doctor.mjs", ["--json"], env);
      const report = JSON.parse(doctor.stdout);
      const byName = new Map(report.checks.map((check) => [check.name, check]));
      assert.deepEqual(byName.get("Codex model catalog"), {
        status: "warn",
        name: "Codex model catalog",
        detail: "startup catalog is stale",
        fix: "Fully quit Codex, reopen it, and create a new task.",
      });
      assert.deepEqual(byName.get("Routed model agents"), {
        status: "fail",
        name: "Routed model agents",
        detail: `0 of 1 current definitions in ${path.join(codexHome, "agents")}`,
        fix: "Run ./bin/doctor --fix, then fully quit Codex, reopen it, and create a new task.",
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);
