// Offline Codex model-resolution proof. Uses only temporary configuration and a
// synthetic loopback provider: no OAuth, provider quota, or installed settings.
// Usage: node scripts/verify-codex-catalog-reload.mjs /absolute/path/to/codex [--usage-contract]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ResponseUsageTransform } from "../src/response-usage.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";

const binary = process.argv[2];
const usageContract = process.argv[3] === "--usage-contract";
let legacyCacheDetails = false;
assert.ok(binary && path.isAbsolute(binary) && (process.argv.length === 3 || (process.argv.length === 4 && usageContract)),
  "Usage: node scripts/verify-codex-catalog-reload.mjs /absolute/path/to/codex [--usage-contract]");
const directory = mkdtempSync(path.join(os.tmpdir(), "codex-catalog-reload-"));
const slug = "router-offline-catalog-fixture";
const marker = "OFFLINE_CATALOG_OK";
const environment = { CODEX_HOME: directory, NO_PROXY: "127.0.0.1,localhost" };
for (const name of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR", "PATHEXT", "LANG", "LC_ALL"]) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}

function command(args) {
  return spawnableCommand(binary, args);
}

function run(args) {
  const target = command(args);
  const result = spawnSync(target.command, target.args, {
    ...target.options, cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

async function fixtureEvents(id) {
  const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [] }] };
  const events = [
    { type: "response.output_item.done", sequence_number: 0, output_index: 0, item },
    { type: "response.completed", sequence_number: 1, response: {
      id: `resp_${id}`, object: "response", status: "completed", model: slug,
      output: [item], usage: usageContract
        ? { input_tokens: 572089, output_tokens: 1, total_tokens: 572090, input_tokens_details: { cached_tokens: 500000 } }
        : { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      ...(usageContract ? { provider_specific_fields: { grok_context_input_tokens: 58000 } } : {}),
    } },
  ];
  if (usageContract) {
    const transform = new ResponseUsageTransform("application/json", { cumulativeInputUsage: true });
    const chunks = [];
    transform.on("data", chunk => chunks.push(chunk));
    const ended = once(transform, "end");
    transform.end(JSON.stringify(events[1]));
    await ended;
    events[1] = JSON.parse(Buffer.concat(chunks));
    assert.equal(transform.tokenUsage().cachedInputTokens, 500000, "raw cache billing remains intact");
    if (legacyCacheDetails) events[1].response.usage.input_tokens_details = {};
    else assert.equal(events[1].response.usage.input_tokens_details, undefined, "unknown cache is omitted, never synthesized as zero");
  }
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

let providerRequests = 0;
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, slug);
    providerRequests++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(await fixtureEvents(providerRequests));
  } catch {
    response.writeHead(400).end();
  }
});

function appServer() {
  const target = command(["app-server"]);
  const child = spawn(target.command, target.args, {
    ...target.options, cwd: directory, env: environment, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const turns = new Map();
  const completed = new Set();
  const windows = new Map();
  const usages = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const fail = error => {
    for (const waiter of [...pending.values(), ...turns.values()]) waiter.reject(error);
    pending.clear();
    turns.clear();
  };
  child.once("error", fail);
  child.once("exit", code => fail(new Error(`Isolated app-server exited ${code}: ${stderr}`)));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
    if (message.method === "thread/tokenUsage/updated") {
      const { threadId, tokenUsage } = message.params;
      windows.set(threadId, tokenUsage.modelContextWindow);
      usages.set(threadId, tokenUsage);
    }
    if (message.method === "turn/completed") {
      const { threadId, turn } = message.params;
      const error = turn.status !== "completed" ? new Error(JSON.stringify(turn.error || turn)) : undefined;
      if (error) turns.get(threadId)?.reject(error);
      else {
        completed.add(threadId);
        turns.get(threadId)?.resolve();
      }
      turns.delete(threadId);
    }
  });
  const bounded = callback => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Isolated app-server timed out: ${stderr}`)), 15_000);
    callback({ resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); } });
  });
  const rpc = (method, params) => bounded(waiter => {
    const id = ++sequence;
    pending.set(id, waiter);
    send({ id, method, params });
  });
  return {
    async initialize() {
      await rpc("initialize", { clientInfo: { name: "router_offline_catalog_probe", version: "1.0.0" },
        capabilities: { experimentalApi: true } });
      send({ method: "initialized", params: {} });
    },
    async turn() {
      const result = await rpc("thread/start", { cwd: directory, model: slug, modelProvider: "fixture",
        approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
      const threadId = result.thread.id;
      const finished = bounded(waiter => turns.set(threadId, waiter));
      try {
        await rpc("turn/start", { threadId, input: [{ type: "text", text: `Return ${marker}.` }] });
        await finished;
      } catch (error) {
        turns.get(threadId)?.reject(error);
        await finished.catch(() => {});
        throw error;
      }
      assert.ok(completed.has(threadId), "synthetic turn must complete successfully");
      assert.ok(Number.isFinite(windows.get(threadId)), "tokenUsage must expose the resolved context window");
      if (usageContract) {
        assert.equal(usages.get(threadId).last.inputTokens, 58000);
        assert.equal(usages.get(threadId).last.cachedInputTokens, 0);
      }
      return windows.get(threadId);
    },
    async close() {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
        try { await exited; } finally { clearTimeout(timeout); }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

let active;
try {
  const version = run(["--version"]).trim();
  const bundled = JSON.parse(run(["debug", "models", "--bundled"]));
  assert.ok(bundled.models?.length, "the executable must provide a bundled catalog schema");
  const model = { ...bundled.models[0], slug, display_name: "Offline catalog fixture",
    base_instructions: "Return the requested marker without calling tools.",
    context_window: 256_000, max_context_window: 500_000, effective_context_window_percent: 95,
    auto_compact_token_limit: 204_800, supported_in_api: true };
  delete model.model_messages;
  const catalogPath = path.join(directory, "models.json");
  const saveCatalog = () => writeFileSync(catalogPath, `${JSON.stringify({ models: [model] })}\n`);
  saveCatalog();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(path.join(directory, "config.toml"), [
    `model = ${JSON.stringify(slug)}`, 'model_provider = "fixture"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`, '[model_providers.fixture]',
    'name = "Offline loopback fixture"', `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'wire_api = "responses"', "supports_websockets = false", "requires_openai_auth = false", "stream_max_retries = 0", "",
  ].join("\n"), { mode: 0o600 });
  active = appServer();
  await active.initialize();
  if (usageContract) {
    legacyCacheDetails = true;
    await assert.rejects(active.turn(), /missing field `cached_tokens`/, "negative control must reproduce the actual Codex decoder failure");
    legacyCacheDetails = false;
    await active.turn();
    assert.equal(providerRequests, 2, "one rejected and one accepted synthetic response, no retry");
    process.stdout.write(`${JSON.stringify({ version, usageContract: "passed", legacyMissingCachedTokens: "rejected", currentContext: 58000, currentCacheDetails: "omitted", clientDefaultCachedTokens: 0, rawCachedTokens: 500000, liveProviderRequests: 0 })}\n`);
  } else {
    const initialWindow = await active.turn();
    assert.equal(initialWindow, 243_200, "startup catalog: 256000 * 95%");
    model.context_window = 500_000;
    model.auto_compact_token_limit = 440_000;
    saveCatalog();
    assert.equal(JSON.parse(readFileSync(catalogPath)).models[0].context_window, 500_000);
    const sameProcessFreshThreadWindow = await active.turn();
    assert.equal(sameProcessFreshThreadWindow, 243_200, "a new thread retains its app-server's static catalog");
    await active.close();
    active = appServer();
    await active.initialize();
    const freshProcessWindow = await active.turn();
    assert.equal(freshProcessWindow, 475_000, "a fresh app-server loads the rewritten 500000 catalog");
    assert.equal(providerRequests, 3, "exactly three synthetic loopback responses; no retries");
    process.stdout.write(`${JSON.stringify({ version, initialWindow, sameProcessFreshThreadWindow,
      freshProcessWindow, syntheticProviderRequests: providerRequests, liveProviderRequests: 0 })}\n`);
  }
} finally {
  await active?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
