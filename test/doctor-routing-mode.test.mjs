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
  return spawnSync(process.execPath, [path.join(root, "src", script), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
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

      const doctor = child("doctor.mjs", ["--json"], env);
      const report = JSON.parse(doctor.stdout);
      const byName = new Map(report.checks.map((check) => [check.name, check]));
      assert.deepEqual(byName.get("Merged catalog"), {
        status: "ok",
        name: "Merged catalog",
        detail: "native-only; routed transport is inactive",
        fix: "Run ./bin/refresh-catalog, or ./bin/doctor --fix if files are missing.",
      });
      assert.equal(byName.get("Catalog matches gateway routes").status, "ok");
      assert.equal(byName.get("Catalog matches gateway routes").detail, "0 routed models");
      assert.equal(byName.get("Routed model agents").status, "ok");
      assert.match(byName.get("Routed model agents").detail, /^0 current definitions/);
      assert.equal(byName.get("Signed router coexistence").status, "ok");
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
      `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-key\n", {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "multi-agent-proofs.json"),
      `${JSON.stringify({
        version: 1,
        proofs: {
          "deepseek/deepseek-v4-pro": { status: "proven" },
        },
      })}\n`,
      { mode: 0o600 },
    );
    // The catalog now publishes routed models only after an explicit picker
    // selection. Keep this test focused on the doctor detecting a missing
    // managed agent definition, rather than relying on the old implicit-show
    // behavior.
    writeFileSync(
      path.join(stateDir, "model-picker.json"),
      `${JSON.stringify({
        version: 1,
        hidden: [],
        visible: ["deepseek/deepseek-v4-pro"],
        seeded: ["deepseek/deepseek-v4-pro"],
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
      unlinkSync(
        path.join(codexHome, "agents", "router-model-deepseek-deepseek-v4-pro.toml"),
      );

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
