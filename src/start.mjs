import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertCallerSecret } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  loopback,
} from "./paths.mjs";
import { waitForHealth as pollHealth } from "./health-probe.mjs";
import { writeLiteLlmConfig } from "./litellm-config.mjs";

const litellm =
  process.env.MODEL_ROUTER_LITELLM_BIN ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_LITELLM_BIN || process.env.KIMI_LITELLM_BIN
    : undefined) ||
  path.join(
    SOURCE_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "litellm.exe" : "litellm",
  );
if (!existsSync(litellm)) {
  throw new Error(`LiteLLM is not installed at ${litellm}; run ./bin/install.`);
}
if (!existsSync(INTERNAL_SECRET_PATH)) {
  throw new Error(`Internal service key is missing; run ./bin/install.`);
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error(`Router caller key is missing; run ./bin/install.`);
}
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
if (!internalKey) throw new Error("Internal service key is empty.");
const callerKey = assertCallerSecret(
  readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
);
writeLiteLlmConfig();

const commonEnv = {
  MODEL_ROUTER_TARGET: TARGET,
  MODEL_ROUTER_STATE_DIR: STATE_DIR,
  MODEL_ROUTER_CALLER_KEY: callerKey,
  MODEL_ROUTER_INTERNAL_KEY: internalKey,
  MODEL_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  MODEL_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  MODEL_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  MODEL_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  // LiteLLM's ollama_chat provider talks to the daemon root, not the
  // OpenAI-compatible /v1 surface the bridge uses for inference.
  MODEL_ROUTER_LOCAL_BASE_URL_ROOT:
    (process.env.MODEL_ROUTER_LOCAL_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, ""),
  MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
  GROK_OAUTH_FORWARD_BASE_URL: loopback(PORTS.grokOauth, "/v1"),
  MODEL_ROUTER_QUIET: "1",
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  KIMI_INTERNAL_KEY: internalKey,
  KIMI_OAUTH_FORWARD_BASE_URL: loopback(PORTS.oauth, "/v1"),
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
  CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL: loopback(PORTS.api),
  CODEX_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  CODEX_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  CODEX_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  CODEX_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  CODEX_ROUTER_CATALOG: MERGED_CATALOG_PATH,
  CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  CODEX_ROUTER_API_PORT: String(PORTS.api),
  CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  CODEX_ROUTER_PORT: String(PORTS.router),
  LITELLM_MASTER_KEY: internalKey,
  LITELLM_LOG: "ERROR",
  LITELLM_TELEMETRY: "False",
  NO_COLOR: "1",
  // LiteLLM prints Unicode banners at startup; on a non-UTF-8 Windows code page
  // (e.g. cp1252) that raises UnicodeEncodeError and the child never comes up.
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
};

const children = [];
let shuttingDown = false;

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: SOURCE_ROOT,
    env: { ...process.env, ...commonEnv, ...extraEnv },
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ label, code, signal }));
  });
}

// The probe loop lives in src/health-probe.mjs so it can be tested directly;
// importing this file starts the whole service pipeline.
function waitForHealth(label, url, headers = {}, timeoutMs = 30_000, expectedService, child) {
  return pollHealth({
    label,
    url,
    headers,
    timeoutMs,
    expectedService,
    child,
    isShuttingDown: () => shuttingDown,
  });
}

function stopChildren() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 3_000).unref();
}

const FRONTEND = { script: "router.mjs", service: "codex-router", label: "Codex router" };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);

async function main() {
  const kimiForwarder = run(process.execPath, [path.join(SOURCE_ROOT, "src", "oauth-forwarder.mjs")]);
  await waitForHealth("OAuth forwarder", loopback(PORTS.oauth, "/health"), {
    Authorization: `Bearer ${internalKey}`,
  }, 30_000, undefined, kimiForwarder);

  const api = run(process.execPath, [path.join(SOURCE_ROOT, "src", "api-forwarder.mjs")]);
  await waitForHealth("API forwarder", loopback(PORTS.api, "/health"), {
    Authorization: `Bearer ${internalKey}`,
  }, 30_000, undefined, api);

  const grokForwarder = run(process.execPath, [path.join(SOURCE_ROOT, "src", "grok-oauth-forwarder.mjs")]);
  await waitForHealth("Grok OAuth forwarder", loopback(PORTS.grokOauth, "/health"), {
    Authorization: `Bearer ${internalKey}`,
  }, 30_000, undefined, grokForwarder);

  const gateway = run(litellm, [
    "--config",
    LITELLM_CONFIG_PATH,
    "--host",
    "127.0.0.1",
    "--port",
    String(PORTS.gateway),
  ]);
  // LiteLLM cold starts can take minutes when launchd starves the job under
  // system load; killing it mid-import restarts the import from scratch and
  // the service loops forever, so wait long enough for a starved import.
  await waitForHealth(
    "LiteLLM gateway",
    loopback(PORTS.gateway, "/health/liveliness"),
    { Authorization: `Bearer ${internalKey}` },
    300_000,
    undefined,
    gateway,
  );

  const frontend = FRONTEND;
  const frontendService = frontend.service;
  const router = run(process.execPath, [path.join(SOURCE_ROOT, "src", frontend.script)]);
  await waitForHealth(
    frontend.label,
    loopback(PORTS.router, "/health"),
    {},
    30_000,
    frontendService,
    router,
  );

  console.error(`[${frontendService}] ready (authenticated loopback endpoint)`);
  const result = await Promise.race([
    waitForExit(kimiForwarder, "OAuth forwarder"),
    waitForExit(api, "API forwarder"),
    waitForExit(grokForwarder, "Grok OAuth forwarder"),
    waitForExit(gateway, "LiteLLM gateway"),
    waitForExit(router, frontend.label),
  ]);
  if (!shuttingDown) {
    console.error(
      `[${frontendService}] ${result.label} exited (code=${String(result.code)}, signal=${String(result.signal)}).`,
    );
  }
  return result.code || 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  if (!shuttingDown) {
    const reason = (error instanceof Error && error.message) || String(error);
    console.error(`[model-router] startup failed: ${reason}; inspect the service logs above for details.`);
    exitCode = 1;
  }
} finally {
  stopChildren();
  await Promise.all(children.map((child) => waitForExit(child, "child")));
}
process.exit(exitCode);
