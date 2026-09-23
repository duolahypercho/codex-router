import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environment(directory) {
  const stateDir = path.join(directory, "state");
  return {
    ...process.env,
    HOME: directory,
    CODEX_HOME: path.join(directory, "codex"),
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(stateDir, "generic-providers.json"),
    MODEL_ROUTER_USER_MODELS: path.join(stateDir, "user-models.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "linux",
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(directory, "LaunchAgents"),
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    CODEX_ROUTER_SKIP_SYSTEMCTL: "1",
    KIMI_CODE_HOME: path.join(directory, "kimi-code"),
    GROK_AUTH_PATH: path.join(directory, "grok", "auth.json"),
  };
}

function doctor(env) {
  const result = spawnSync(process.execPath, ["src/doctor.mjs", "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.ok(result.stdout, result.stderr);
  return { result, report: JSON.parse(result.stdout) };
}

test("doctor reports generic readiness without endpoint or header values", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-doctor-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  const headerSecret = "DOCTOR_GENERIC_HEADER_MUST_NOT_LEAK";
  const endpointSecret = "private-path-must-not-leak";
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "enabled-providers.json"), `${JSON.stringify({
    version: 1,
    providers: [],
  })}\n`, { mode: 0o600 });
  writeFileSync(env.MODEL_ROUTER_GENERIC_PROVIDERS, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "doctor-generic",
      displayName: "Doctor Generic",
      baseUrl: `https://doctor-generic.example.test/${endpointSecret}/v1`,
      adapter: "openai-chat",
      headers: { "X-Private-Routing": headerSecret },
      allowPrivate: false,
      enabled: true,
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  const model = userModelEntry({
    providerId: "doctor-generic",
    upstreamId: "model-a",
    priority: 100,
  });
  writeFileSync(env.MODEL_ROUTER_USER_MODELS, `${JSON.stringify({
    version: 1,
    models: [model],
  }, null, 2)}\n`, { mode: 0o600 });

  try {
    const { report } = doctor(env);
    const enabled = report.checks.find((check) => check.name === "Enabled providers");
    assert.equal(enabled.status, "ok");
    assert.equal(enabled.detail, "doctor-generic");
    const row = report.checks.find((check) => check.name === "Doctor Generic generic provider");
    assert.equal(row.status, "ok");
    assert.match(row.detail, /no credential required; 1 curated model route/);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(headerSecret), false);
    assert.equal(serialized.includes(endpointSecret), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor names malformed generic state without reflecting its bytes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-doctor-malformed-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  const secret = "MALFORMED_GENERIC_STATE_SECRET_MUST_NOT_LEAK";
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(env.MODEL_ROUTER_GENERIC_PROVIDERS, `${secret} is not json\n`, { mode: 0o600 });

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Generic provider registry");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /document is not valid JSON/);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports an enabled search sidecar whose protected credential is unavailable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "search-sidecar-doctor-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(env.MODEL_ROUTER_GENERIC_PROVIDERS, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "perplexity-sidecar",
      displayName: "Perplexity Search",
      baseUrl: "https://api.perplexity.ai",
      adapter: "openai-chat",
      headers: {},
      credentialRef: "cred_perplexity_sidecar_01",
      allowPrivate: false,
      enabled: true,
    }],
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "search-sidecars.json"), `${JSON.stringify({
    version: 1,
    bindings: [{
      model: "deepseek/deepseek-v4-pro",
      providerId: "perplexity-sidecar",
      adapter: "perplexity-search",
      enabled: true,
      timeoutMs: 10_000,
      maxResults: 8,
      cacheTtlMs: 60_000,
      cacheMaxEntries: 128,
      maxAttempts: 2,
      retryDelayMs: 100,
    }],
  })}\n`, { mode: 0o600 });

  try {
    const { report } = doctor(env);
    const row = report.checks.find(
      (check) => check.name === "Search sidecar deepseek/deepseek-v4-pro",
    );
    assert.equal(row.status, "fail");
    assert.match(row.fix, /search-sidecar status/);
    assert.equal(JSON.stringify(row).includes("api.perplexity.ai"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
