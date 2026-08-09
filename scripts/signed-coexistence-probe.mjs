#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, callerBaseUrl } from "../src/caller-auth.mjs";
import { buildSignedInCatalog } from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { applyMultiAgentSettings, readMultiAgentSettings } from "../src/multi-agent-state.mjs";
import {
  CALLER_SECRET_PATH,
  CODEX_HOME,
  INTERNAL_SECRET_PATH,
  MERGED_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  PORTS,
  STATE_DIR,
} from "../src/paths.mjs";

const MODES = Object.freeze({
  canonical: {
    model: "clinepass/kimi-k3",
    marker: "SIGNED_CANONICAL_KIMI_OK",
  },
  alias: {
    model: "gpt-5.4-mini",
    marker: "SIGNED_ALIAS_KIMI_OK",
  },
  native: {
    model: "gpt-5.6-sol-wm",
    marker: "SIGNED_NATIVE_CONTROL_OK",
  },
  coexistence: {
    model: null,
    marker: "SIGNED_COEXISTENCE_KIMI_OK",
  },
  "coexistence-native": {
    model: "gpt-5.6-terra",
    marker: "SIGNED_COEXISTENCE_NATIVE_OK",
  },
  "coexistence-image": {
    model: null,
    marker: "INV-7734-QX",
    prompt: "Read the attached image and return exactly its first invoice identifier. Do not call tools.",
    image: path.join(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
      "test",
      "fixtures",
      "vision-benchmark.png",
    ),
  },
  "coexistence-subagent": {
    model: null,
    markers: ["KIMI_CHILD_1", "KIMI_CHILD_2"],
    prompt:
      "Spawn one GPT-5.6 Terra subagent. Ask it to return exactly KIMI_CHILD_1. " +
      "After receiving that, send the same subagent a follow-up asking it to return exactly " +
      "KIMI_CHILD_2. Wait for both results and report both markers. Do not edit files.",
  },
});

const mode = process.argv[2];
const selected = MODES[mode];
if (!selected) {
  console.error(
    "Usage: signed-coexistence-probe.mjs canonical|alias|native|coexistence|coexistence-native|coexistence-image|coexistence-subagent",
  );
  process.exit(2);
}

const codexBinary =
  process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const callerSecret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
let routerBaseUrl = callerBaseUrl(PORTS.router, callerSecret);
let catalogPath = MERGED_CATALOG_PATH;
let temporaryRoot;
let isolatedRouter;
let isolatedRouterStderr = "";

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForRouter(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const detail = isolatedRouterStderr
        .replaceAll(callerSecret, "[REDACTED]")
        .trim()
        .slice(0, 2_000);
      throw new Error(`The isolated router exited during startup.${detail ? ` ${detail}` : ""}`);
    }
    try {
      const response = await fetch(`${baseUrl}/models`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The isolated router did not become ready.");
}

if (mode.startsWith("coexistence")) {
  const target = MODEL_BY_SLUG.get("clinepass/kimi-k3");
  if (!target) throw new Error("The ClinePass Kimi K3 registry entry is unavailable.");
  const [configuredTarget] = applyMultiAgentSettings(
    [target],
    readMultiAgentSettings(),
  );
  const native = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  const coexistence = buildSignedInCatalog(native, [configuredTarget], target.slug);
  const aliasSlug = Object.keys(coexistence.aliases)[0];
  if (!selected.model) selected.model = aliasSlug;
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-coexistence-probe-"));
  catalogPath = path.join(temporaryRoot, "merged-models.json");
  const aliasPath = path.join(temporaryRoot, "native-aliases.json");
  writeFileSync(catalogPath, `${JSON.stringify({ models: coexistence.models }, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(aliasPath, `${JSON.stringify({ version: 1, aliases: coexistence.aliases }, null, 2)}\n`, {
    mode: 0o600,
  });
  const routerPort = await openPort();
  routerBaseUrl = callerBaseUrl(routerPort, callerSecret);
  isolatedRouter = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/router.mjs")], {
    cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    env: {
      ...process.env,
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_CALLER_KEY: callerSecret,
      MODEL_ROUTER_NATIVE_ALIAS_STATE: aliasPath,
      MODEL_ROUTER_STATE_DIR: STATE_DIR,
      MODEL_ROUTER_TARGET: "codex",
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  isolatedRouter.stderr.on("data", (chunk) => {
    isolatedRouterStderr += String(chunk);
  });
  await waitForRouter(routerBaseUrl, isolatedRouter);
}

const expectedMarkers = selected.markers || [selected.marker];
const prompt = selected.prompt || `Reply with exactly ${selected.marker}. Do not call tools.`;

const codexArgs = [
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
  selected.model,
  "--config",
  'model_provider="custom"',
  "--config",
  'model_providers.custom.name="OpenAI"',
  "--config",
  "model_providers.custom.requires_openai_auth=true",
  "--config",
  'model_providers.custom.wire_api="responses"',
  "--config",
  `openai_base_url=${JSON.stringify(routerBaseUrl)}`,
  "--config",
  `model_catalog_json=${JSON.stringify(catalogPath)}`,
  "--config",
  "disable_response_storage=true",
  "--config",
  'model_reasoning_effort="high"',
  "--config",
  "multi_agent_v2.enabled=true",
  "--config",
  "multi_agent_v2.expose_spawn_agent_model_overrides=true",
  "--config",
  "multi_agent_v2.max_concurrent_threads_per_session=2",
  "--cd",
  path.dirname(new URL(import.meta.url).pathname),
];
// `--image` accepts multiple values, so a following positional prompt would be
// consumed as another file. Insert it before `--cd`, which terminates the image
// value list unambiguously.
if (selected.image) {
  codexArgs.splice(codexArgs.indexOf("--cd"), 0, "--image", selected.image);
}
codexArgs.push(prompt);

let result;
try {
  result = spawnSync(codexBinary, codexArgs, {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME,
      MODEL_ROUTER_TARGET: "codex",
    },
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
} finally {
  if (isolatedRouter) isolatedRouter.kill("SIGTERM");
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

const transcript = `${result.stdout || ""}\n${result.stderr || ""}`;
if (expectedMarkers.every((marker) => transcript.includes(marker))) {
  console.log(`PASS ${mode}: routed marker returned`);
  process.exit(0);
}

if (transcript.includes("not supported when using Codex with a ChatGPT account")) {
  console.log(`FAIL ${mode}: ChatGPT account model allowlist rejected ${selected.model}`);
  process.exit(1);
}

if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
  console.log(`ERROR ${mode}: probe timed out`);
  process.exit(2);
}

console.log(`ERROR ${mode}: Codex exited without the marker (status ${result.status ?? "unknown"})`);
const safeTranscript = transcript
  .replaceAll(callerSecret, "[REDACTED]")
  .split("\n");
const diagnostics = [];
for (const line of safeTranscript) {
  if (!line) continue;
  try {
    const event = JSON.parse(line);
    if (event.type === "error" || event.error) {
      diagnostics.push(JSON.stringify({ type: event.type, message: event.message, error: event.error }));
    }
  } catch {
    if (/\b(error|failed|unsupported|invalid)\b/i.test(line) && !line.includes(" WARN ")) {
      diagnostics.push(line);
    }
  }
}
if (diagnostics.length > 0) {
  console.log(`Unexpected response diagnostics:\n${diagnostics.slice(-8).join("\n").slice(0, 4_000)}`);
}
process.exit(2);
