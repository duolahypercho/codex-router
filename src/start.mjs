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
  MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_CHATGPT_PORT: String(PORTS.chatgpt),
  CHATGPT_OAUTH_FORWARD_BASE_URL: loopback(PORTS.chatgpt, "/v1"),
  MODEL_ROUTER_QUIET: "1",
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  KIMI_INTERNAL_KEY: internalKey,
  KIMI_OAUTH_FORWARD_BASE_URL: loopback(PORTS.oauth, "/v1"),
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
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

async function waitForHealth(url, headers = {}, timeoutMs = 30_000, expectedService) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        if (!expectedService) return;
        const payload = await response.json().catch(() => ({}));
        if (payload.service === expectedService) return;
      }
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
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

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);

const oauth = run(process.execPath, [path.join(SOURCE_ROOT, "src", "oauth-forwarder.mjs")]);
await waitForHealth(loopback(PORTS.oauth, "/health"), {
  Authorization: `Bearer ${internalKey}`,
});

const api = run(process.execPath, [path.join(SOURCE_ROOT, "src", "api-forwarder.mjs")]);
await waitForHealth(loopback(PORTS.api, "/health"), {
  Authorization: `Bearer ${internalKey}`,
});

const chatgpt = run(process.execPath, [path.join(SOURCE_ROOT, "src", "chatgpt-forwarder.mjs")]);
await waitForHealth(loopback(PORTS.chatgpt, "/health"), {
  Authorization: `Bearer ${internalKey}`,
});

const gateway = run(litellm, [
  "--config",
  LITELLM_CONFIG_PATH,
  "--host",
  "127.0.0.1",
  "--port",
  String(PORTS.gateway),
]);
await waitForHealth(
  loopback(PORTS.gateway, "/health/liveliness"),
  { Authorization: `Bearer ${internalKey}` },
);

const FRONTENDS = {
  codex: { script: "router.mjs", service: "codex-router", label: "Codex router" },
  claude: { script: "claude-router.mjs", service: "claude-router", label: "Claude router" },
  cursor: { script: "cursor-router.mjs", service: "cursor-router", label: "Cursor router" },
};
const frontend = FRONTENDS[TARGET];
const frontendScript = frontend.script;
const frontendService = frontend.service;
const router = run(process.execPath, [path.join(SOURCE_ROOT, "src", frontendScript)]);
await waitForHealth(
  loopback(PORTS.router, "/health"),
  {},
  30_000,
  frontendService,
);

console.error(`[${frontendService}] ready (authenticated loopback endpoint)`);

const result = await Promise.race([
  waitForExit(oauth, "OAuth forwarder"),
  waitForExit(api, "API forwarder"),
  waitForExit(chatgpt, "ChatGPT forwarder"),
  waitForExit(gateway, "LiteLLM gateway"),
  waitForExit(router, frontend.label),
]);
if (!shuttingDown) {
  console.error(
    `[${frontendService}] ${result.label} exited (code=${String(result.code)}, signal=${String(result.signal)}).`,
  );
}
stopChildren();
await Promise.all(children.map((child) => waitForExit(child, "child")));
process.exit(result.code || 0);
