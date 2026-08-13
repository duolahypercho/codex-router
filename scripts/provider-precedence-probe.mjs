#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { buildMergedCatalog } from "../src/catalog.mjs";
import { findCodexBinary, spawnableCommand } from "../src/codex-binary.mjs";
import { writeLiteLlmConfig } from "../src/litellm-config.mjs";
import { MODEL_BY_SLUG, PROVIDERS } from "../src/model-registry.mjs";

const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const LIVE_STATE_DIR = path.join(CODEX_HOME, "codex-router");
if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: node scripts/provider-precedence-probe.mjs --live --yes

Runs isolated live requests against one external provider and the signed-in
ChatGPT plan. Both flags are required because the probe consumes quota.
`);
  process.exit(0);
}
if (!process.argv.includes("--live") || !process.argv.includes("--yes")) {
  console.error("The precedence probe consumes provider and ChatGPT quota; pass --live --yes to confirm.");
  process.exit(2);
}
const CODEX_BIN = findCodexBinary();
if (!CODEX_BIN) {
  console.error("The Codex binary was not found. Install Codex or set CODEX_BIN to its CLI binary.");
  process.exit(1);
}
const EXTERNAL_MODEL = "clinepass/kimi-k3";
const NATIVE_MODEL = process.env.CODEX_ROUTER_NATIVE_PROBE_MODEL || "gpt-5.6-sol";
const EXTERNAL_MARKER = `ROUTER_CANONICAL_${Date.now()}`;
const NATIVE_MARKER = `ROUTER_NATIVE_${Date.now()}`;
const temporaryState = mkdtempSync(path.join(os.tmpdir(), "codex-router-precedence-"));
chmodSync(temporaryState, 0o700);

const children = [];
let childDiagnostics = "";

function reservePorts(count) {
  return Promise.all(
    Array.from({ length: count }, () => new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : undefined;
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    })),
  );
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: SOURCE_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    childDiagnostics = `${childDiagnostics}${String(chunk)}`.slice(-12_000);
  });
  children.push(child);
  return child;
}

async function waitFor(url, { headers = {}, child, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`A probe service exited before ${url} became ready.`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function runCodex({ model, marker, routerBaseUrl, catalogPath }) {
  return new Promise((resolve) => {
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--json",
      "--model",
      model,
      "--config",
      'model_provider="codex-router-signed"',
      "--config",
      'model_providers.codex-router-signed.name="Codex Router isolated proof"',
      "--config",
      `model_providers.codex-router-signed.base_url=${JSON.stringify(routerBaseUrl)}`,
      "--config",
      'model_providers.codex-router-signed.wire_api="responses"',
      "--config",
      "model_providers.codex-router-signed.requires_openai_auth=true",
      "--config",
      "model_providers.codex-router-signed.supports_websockets=false",
      "--config",
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      "--config",
      "disable_response_storage=true",
      "--config",
      'model_reasoning_effort="high"',
      "--cd",
      SOURCE_ROOT,
      `Reply with exactly ${marker}. Do not call tools.`,
    ];
    const target = spawnableCommand(CODEX_BIN, args);
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd: SOURCE_ROOT,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME, MODEL_ROUTER_TARGET: "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transcript = "";
    child.stdout.on("data", (chunk) => {
      transcript += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      transcript += String(chunk);
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, markerReturned: transcript.includes(marker), transcript });
    });
  });
}

function usageEvents() {
  const target = path.join(temporaryState, "usage-events.jsonl");
  if (!existsSync(target)) return [];
  return readFileSync(target, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function correlatedEvent(events, startIndex, provider, model) {
  return events
    .slice(startIndex)
    .find((event) => event.provider === provider && event.model === model && event.status === 200);
}

async function stopChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  const exited = Promise.all(children.map((child) => (
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve))
  )));
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

try {
  const external = MODEL_BY_SLUG.get(EXTERNAL_MODEL);
  const clinepass = PROVIDERS.get("clinepass");
  if (!external || !clinepass?.credential?.file) {
    throw new Error("The clean branch does not contain the ClinePass Kimi K3 route.");
  }
  const liveCredential = path.join(LIVE_STATE_DIR, clinepass.credential.file);
  if (!existsSync(liveCredential)) {
    throw new Error("The existing protected ClinePass credential is unavailable.");
  }
  if (process.platform === "win32") {
    linkSync(liveCredential, path.join(temporaryState, clinepass.credential.file));
  } else {
    symlinkSync(liveCredential, path.join(temporaryState, clinepass.credential.file));
  }

  const nativeCatalogPath = path.join(LIVE_STATE_DIR, "native-models.json");
  const nativeCatalog = JSON.parse(readFileSync(nativeCatalogPath, "utf8"));
  const merged = buildMergedCatalog(nativeCatalog, [external]);
  const catalogPath = path.join(temporaryState, "merged-models.json");
  const aliasesPath = path.join(temporaryState, "native-aliases.json");
  const litellmPath = path.join(temporaryState, "litellm.yaml");
  writeFileSync(catalogPath, `${JSON.stringify({ models: merged }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(aliasesPath, `${JSON.stringify({ version: 1, aliases: {} }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(temporaryState, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["clinepass"] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeLiteLlmConfig(litellmPath);

  const [gatewayPort, routerPort, apiPort] = await reservePorts(3);
  const internalKey = randomBytes(32).toString("base64url");
  const callerKey = randomBytes(32).toString("base64url");
  const routerBaseUrl = callerBaseUrl(routerPort, callerKey);
  const baseEnv = {
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: temporaryState,
    MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
    MODEL_ROUTER_PORT: String(routerPort),
    MODEL_ROUTER_API_PORT: String(apiPort),
    MODEL_ROUTER_INTERNAL_KEY: internalKey,
    MODEL_ROUTER_CALLER_KEY: callerKey,
    MODEL_ROUTER_NATIVE_ALIAS_STATE: aliasesPath,
    MODEL_ROUTER_QUIET: "1",
    CODEX_ROUTER_INTERNAL_KEY: internalKey,
    CODEX_ROUTER_CALLER_KEY: callerKey,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_API_FORWARD_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL: `http://127.0.0.1:${apiPort}`,
    CODEX_ROUTER_CATALOG: catalogPath,
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_PORT: String(apiPort),
    LITELLM_MASTER_KEY: internalKey,
    LITELLM_LOG: "ERROR",
    LITELLM_TELEMETRY: "False",
    NO_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  const api = start(process.execPath, [path.join(SOURCE_ROOT, "src", "api-forwarder.mjs")], baseEnv);
  await waitFor(`http://127.0.0.1:${apiPort}/health`, {
    headers: { Authorization: `Bearer ${internalKey}` },
    child: api,
  });
  const gateway = start(
    path.join(
      SOURCE_ROOT,
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "litellm.exe" : "litellm",
    ),
    ["--config", litellmPath, "--host", "127.0.0.1", "--port", String(gatewayPort)],
    baseEnv,
  );
  await waitFor(`http://127.0.0.1:${gatewayPort}/health/liveliness`, {
    headers: { Authorization: `Bearer ${internalKey}` },
    child: gateway,
  });
  const router = start(process.execPath, [path.join(SOURCE_ROOT, "src", "router.mjs")], baseEnv);
  await waitFor(`${routerBaseUrl}/models`, { child: router });

  const beforeExternal = usageEvents().length;
  const externalResult = await runCodex({
    model: EXTERNAL_MODEL,
    marker: EXTERNAL_MARKER,
    routerBaseUrl,
    catalogPath,
  });
  const afterExternal = usageEvents();
  const externalEvent = correlatedEvent(afterExternal, beforeExternal, "clinepass", EXTERNAL_MODEL);

  const beforeNative = afterExternal.length;
  const nativeResult = await runCodex({
    model: NATIVE_MODEL,
    marker: NATIVE_MARKER,
    routerBaseUrl,
    catalogPath,
  });
  const afterNative = usageEvents();
  const nativeEvent = correlatedEvent(afterNative, beforeNative, "openai", NATIVE_MODEL);

  const result = {
    liveConfigurationChanged: false,
    external: {
      model: EXTERNAL_MODEL,
      markerReturned: externalResult.markerReturned,
      routed: Boolean(externalEvent),
      status: externalEvent?.status ?? null,
    },
    native: {
      model: NATIVE_MODEL,
      markerReturned: nativeResult.markerReturned,
      routed: Boolean(nativeEvent),
      status: nativeEvent?.status ?? null,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!externalResult.markerReturned || !externalEvent || !nativeResult.markerReturned || !nativeEvent) {
    const externalRejected = externalResult.transcript.includes(
      "not supported when using Codex with a ChatGPT account",
    );
    console.error(
      JSON.stringify({
        externalExit: externalResult.code,
        externalSignal: externalResult.signal,
        externalRejected,
        nativeExit: nativeResult.code,
        nativeSignal: nativeResult.signal,
      }),
    );
    process.exitCode = 1;
  }
} catch (error) {
  const safe = String(error instanceof Error ? error.message : error);
  console.error(safe);
  if (childDiagnostics) console.error(childDiagnostics.replace(/\/_codex-router\/[^/]+/g, "/_codex-router/[REDACTED]"));
  process.exitCode = 1;
} finally {
  await stopChildren();
  rmSync(temporaryState, { recursive: true, force: true });
}
