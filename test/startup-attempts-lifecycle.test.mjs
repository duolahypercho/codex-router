import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeStartupFixture, startupFixturePaths } from "./startup-attempts-fixture.mjs";

const root = process.env.PR895_REVIEW_SOURCE_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actualModules = new Set([
  "start.mjs", "foreground-start.mjs", "service-process.mjs", "startup-attempts.mjs",
]);
const source = (name) => readFileSync(path.join(root, "src", name), "utf8");
const now = 1_790_000_000_000;
const previousFailure = (active = false) => ({
  version: 1, consecutiveFailures: 3, lastFailureAt: now - (active ? 0 : 900_001),
  nextAttemptNotBefore: now + (active ? 240_000 : -1),
});

// Execute the real startup, foreground entry and persistence modules. Every
// child, probe and state write is a fixture; none can touch installed services,
// credentials or providers. Full readiness and the supervisor race still run.
async function run({ foreground = false, disabled = false, mode = "healthy", seeded = false, platform: requestedPlatform = "linux" } = {}) {
  let record = seeded ? previousFailure(foreground || disabled) : undefined;
  const original = record && JSON.stringify(record);
  const events = [], diagnostics = [], children = [];
  const platform = mode.startsWith("identity-") || mode === "record-acl" ? "win32" : requestedPlatform;
  const { path: fixturePath, root: fixtureRoot, pathToFileURL } = startupFixturePaths(platform, "startup-fixture");
  const sourceRoot = fixturePath.join(fixtureRoot, "checkout"), stateDir = fixturePath.join(fixtureRoot, "state");
  const statePath = fixturePath.join(stateDir, "startup-attempts.json");
  const fakeProcess = Object.assign(new EventEmitter(), {
    pid: 9999, platform,
    execPath: fixturePath.join(fixtureRoot, "node"), argv: [fixturePath.join(fixtureRoot, "node"), fixturePath.join(sourceRoot, "src", `${foreground ? "foreground-start" : "start"}.mjs`)],
    env: {
      MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_LITELLM_BIN: fixturePath.join(fixtureRoot, "litellm"),
      ...(disabled ? { CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: "1" } : {}),
    }, exitCode: 0,
    exit: (code) => { throw Object.assign(new Error("unexpected immediate exit"), { exitCode: code }); },
  });
  const timeout = () => Object.assign(new Error("fixture timeout containing secret error material"), { probeOutcome: "timeout" });
  const fs = {
    existsSync: (file) => !String(file).endsWith("cursor-catalog.json"),
    readFileSync: (file) => {
      if (file === statePath) {
        if (record) return JSON.stringify(record);
        throw Object.assign(new Error("absent fixture record"), { code: "ENOENT" });
      }
      return "synthetic-service-key-with-sufficient-length\n";
    },
    unlinkSync: (file) => {
      events.push(`unlink:${fixturePath.basename(file)}`);
      if (file === statePath) {
        if (mode === "ready-clear-error") throw Object.assign(new Error("fixture clear denied"), { code: "EACCES" });
        record = undefined;
      }
    },
    writeSync: () => { throw new Error("unexpected cooldown refusal"); },
  };
  let firstHealth = true;
  const globals = {
    process: fakeProcess, Buffer,
    console: { error: (message) => diagnostics.push(String(message)), warn: (message) => diagnostics.push(String(message)) },
    Date: class extends Date { static now() { return now; } },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  };
  const deps = {
    "node:fs": fs, "node:path": { default: fixturePath },
    "node:child_process": { spawn: () => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      child.kill = (signal) => { child.signalCode = signal; child.emit("exit", null, signal); return true; };
      children.push(child);
      events.push("spawn");
      return child;
    } },
    "./paths.mjs": {
      CALLER_SECRET_PATH: fixturePath.join(stateDir, "caller-secret"), INTERNAL_SECRET_PATH: fixturePath.join(stateDir, "internal-secret"),
      CURSOR_CATALOG_PATH: fixturePath.join(stateDir, "cursor-catalog.json"), LITELLM_CONFIG_PATH: fixturePath.join(stateDir, "litellm.yaml"),
      MERGED_CATALOG_PATH: fixturePath.join(stateDir, "catalog.json"), PROVIDER_SELECTION_PATH: fixturePath.join(stateDir, "providers.json"),
      SERVICE_PROCESS_STATE_PATH: fixturePath.join(stateDir, "service-process.json"), SOURCE_ROOT: sourceRoot, STATE_DIR: stateDir, TARGET: "codex",
      PORTS: { gateway: 4201, router: 4200, oauth: 4202, api: 4203, grokOauth: 4204, antigravityOauth: 4205, devinCli: 4206, cursorPublic: 4214 },
      loopback: (port, suffix = "") => `http://127.0.0.1:${port}${suffix}`,
    },
    "./caller-auth.mjs": { assertCallerSecret: (key) => key },
    "./http-utils.mjs": { SHUTDOWN_DRAIN_MS: 1, SHUTDOWN_FLUSH_MS: 1 },
    "./startup-timeout.mjs": { clearStartupTimeouts: () => {}, runtimeChildEnvironment: (env) => env, startupTimeoutMs: (_name, fallback) => fallback },
    "./health-probe.mjs": { waitForHealth: async () => {
      events.push("health");
      if (!firstHealth) return;
      firstHealth = false;
      if (mode === "shutdown") { fakeProcess.emit("SIGTERM"); throw timeout(); }
      if (mode === "health-timeout") throw timeout();
      if (["health-answered", "health-refused"].includes(mode)) {
        throw Object.assign(new Error("fixture genuine fatal health failure"), { probeOutcome: mode.slice(7) });
      }
      if (mode === "child-exited") throw new Error("fixture child exited before becoming healthy");
    } },
    "./fatal-exit.mjs": { describeChildExit: () => "code 0", fatalExitFollowUp: () => undefined },
    "./gateway-supervisor.mjs": { gatewaySupervisorLimits: () => ({}), superviseGateway: async () => {
      events.push("supervise");
      if (mode === "runtime-timeout") throw timeout();
      if (mode === "runtime-shutdown") fakeProcess.emit("SIGTERM");
      return { label: "fixture gateway", code: 0 };
    } },
    "./litellm-config.mjs": { writeLiteLlmConfig: () => {} },
    "./model-registry.mjs": { MODELS: [] },
    "./local-models.mjs": { readLocalModelSelection: () => ({ enabled: [] }) },
    "./antigravity-oauth-status.mjs": { antigravityOAuthStartupState: () => ({ startForwarder: false }), antigravityOAuthStatus: () => ({}) },
    "./antigravity-probe-activation.mjs": { attemptAntigravityProbePromotionAfterReadiness: async () => true },
    "./spawnable-command.mjs": { spawnableCommand: (command, args) => ({ command, args, options: {} }) },
    "./ollama-runtime.mjs": { ensureOllamaHeadless: async () => {} },
    "./venv-runtime.mjs": { venvRuntimeOutcome: () => ({ kind: "ok" }), venvRuntimeProblem: () => undefined },
    "./dependency-repair.mjs": { dependencyRepairHint: () => "fixture repair hint" },
    "./proxy-environment.mjs": { environmentProxyOptedIn: () => false, inheritedProxyEnvironment: () => ({}), redactProxyCredentials: (value) => value },
    "./cursor-cloudflare-tunnel.mjs": { cursorTunnelRunSpec: () => undefined },
    "./provider-selection.mjs": { pruneUnconfiguredProviders: () => [] },
    "./target-integration.mjs": { targetCli: (command) => command },
    "./service-write-guard.mjs": { assertServiceWriteIsolated: () => {} },
    "./service-operation-lock.mjs": { withServiceOperationLock: async (fn) => fn() },
    "./file-security.mjs": { writePrivateJson: (file, value) => {
      if (file === statePath) { record = value; events.push("record-failure"); }
      else if (mode === "record-acl") throw Object.assign(new Error("fixture ACL denied"), { code: "EACCES" });
    } },
    "./process-identity.mjs": {
      COLD_START_WINDOWS_PROBE_BUDGET: { timeoutMs: 45_000, attempts: 2 },
      processStartIdentity: () => mode === "identity-unavailable" ? undefined : "fixture|node",
      processCommandLine: () => mode === "identity-command-unavailable" ? undefined
        : mode === "identity-mismatch" ? "node /foreign-checkout/start.mjs" : `node ${fixturePath.join(sourceRoot, "src", "start.mjs")}`,
      processStartIdentityProbe: () => ({ state: "alive", identity: "fixture|node" }),
    },
    "./native-catalog-drift.mjs": { watchNativeCatalog: () => () => {} },
  };
  const modules = new Map();
  async function dependency(specifier) {
    const name = path.basename(specifier);
    if (actualModules.has(name)) return load(name);
    const exports = deps[specifier];
    assert.ok(exports, `Unmocked startup dependency ${specifier}`);
    return exports;
  }
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const evaluated = executeStartupFixture(source(name), {
      globals, dependency, url: pathToFileURL(fixturePath.join(sourceRoot, "src", name)).href,
    });
    modules.set(name, evaluated);
    return evaluated;
  }
  await load(foreground ? "foreground-start.mjs" : "start.mjs");
  return { record, original, diagnostics, events, exitCode: fakeProcess.exitCode, childrenStopped: children.every((child) => child.signalCode !== null || child.exitCode !== null) };
}

async function checks(platform) {
  const results = [];
  async function check(name, options, oracle) {
    let result, failure;
    try { result = await run({ platform, ...options }); oracle(result); }
    catch (error) { failure = error.stack; }
    results.push({ name, passed: !failure, failure, result });
  }
  const ready = (result) => assert.ok(result.diagnostics.some((line) => line.includes("ready (authenticated loopback endpoint)")));
  await check("healthy automatic startup resets expired cooldown", { seeded: true }, (result) => {
    ready(result); assert.equal(result.record, undefined); assert.equal(result.exitCode, 0); assert.ok(result.childrenStopped);
  });
  await check("a runtime timeout never recreates the reset cooldown", { seeded: true, mode: "runtime-timeout" }, (result) => {
    ready(result); assert.equal(result.record, undefined); assert.equal(result.exitCode, 1); assert.ok(result.childrenStopped);
  });
  await check("healthy foreground startup never consumes an active managed record", { foreground: true, seeded: true }, (result) => {
    ready(result); assert.equal(JSON.stringify(result.record), result.original); assert.equal(result.events.includes("record-failure"), false);
  });
  await check("foreground timeout never rewrites managed cooldown", { foreground: true, seeded: true, mode: "health-timeout" }, (result) => {
    assert.equal(result.exitCode, 1); assert.equal(JSON.stringify(result.record), result.original); assert.ok(result.childrenStopped);
  });
  await check("only an automatic pre-ready health timeout records a fixed classification", { mode: "health-timeout" }, (result) => {
    assert.equal(result.exitCode, 1); assert.equal(result.record?.lastReason, "health-timeout");
    assert.equal(result.record?.consecutiveFailures, 1); assert.doesNotMatch(JSON.stringify(result.record), /secret error material/); assert.ok(result.childrenStopped);
  });
  for (const mode of ["health-answered", "health-refused", "child-exited"]) {
    await check(`${mode} stays fatal without cooldown`, { mode }, (result) => { assert.equal(result.exitCode, 1); assert.equal(result.record, undefined); assert.ok(result.childrenStopped); });
  }
  await check("startup interruption never records even a timeout", { mode: "shutdown" }, (result) => {
    assert.equal(result.exitCode, 0); assert.equal(result.record, undefined); assert.ok(result.childrenStopped);
  });
  await check("shutdown after readiness never recreates cooldown", { mode: "runtime-shutdown", seeded: true }, (result) => {
    ready(result); assert.equal(result.record, undefined); assert.equal(result.exitCode, 0); assert.ok(result.childrenStopped);
  });
  await check("disable setting bypasses both gate and failure recording", { mode: "health-timeout", disabled: true, seeded: true }, (result) => {
    assert.equal(result.exitCode, 1); assert.equal(JSON.stringify(result.record), result.original);
  });
  for (const [mode, reason] of [["identity-unavailable", "process-identity-unavailable"], ["identity-command-unavailable", "process-command-line-unavailable"]]) {
    await check(`${mode} records before any child launch`, { mode }, (result) => {
      assert.equal(result.exitCode, 1); assert.equal(result.record?.lastReason, reason); assert.equal(result.events.includes("spawn"), false);
    });
  }
  for (const mode of ["identity-mismatch", "record-acl"]) {
    await check(`${mode} is fatal and remains uncached`, { mode }, (result) => { assert.equal(result.exitCode, 1); assert.equal(result.record, undefined); assert.equal(result.events.includes("spawn"), false); });
  }
  await check("a healthy service survives an optional cache clear error", { mode: "ready-clear-error", seeded: true }, (result) => {
    ready(result); assert.equal(result.exitCode, 0); assert.equal(JSON.stringify(result.record), result.original); assert.equal(result.events.includes("record-failure"), false);
  });
  return { platform, cases: results.length, passed: results.filter((result) => result.passed).length, results };
}

if (process.env.CODEX_ROUTER_STARTUP_LIFECYCLE_TEST_CHILD === "1") {
  const reports = await Promise.all(["linux", "win32"].map(checks));
  console.log(JSON.stringify({
    cases: reports.reduce((count, report) => count + report.cases, 0),
    passed: reports.reduce((count, report) => count + report.passed, 0),
    results: reports.flatMap((report) => report.results.map((result) => ({ platform: report.platform, ...result }))),
  }));
} else {
  for (const platform of ["linux", "win32"]) {
    test(`${platform} startup cooldown follows full readiness, foreground and shutdown boundaries`, async () => {
      const report = await checks(platform);
      assert.equal(report.cases, 16);
      assert.equal(report.passed, report.cases, JSON.stringify(report.results.filter((result) => !result.passed), null, 2));
    });
  }
}
