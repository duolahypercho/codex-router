import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { readRetainedToolResult } from "../src/tool-result-recovery.mjs";
import { openPort } from "./port-pool.mjs";
import { spawnNodeFixture, waitForNodeFixture } from "./node-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "native-archive-test-caller-key-with-sufficient-length";
const INTERNAL_KEY = "native-archive-test-internal-key-with-sufficient-length";
const THREAD = "00000000-0000-4000-8000-000000000001";
const FULL = `HEAD\r\n${"distinct archive evidence 😀\n".repeat(1800)}TAIL`;
const tools = [{ type: "namespace", name: "functions", tools: [
  { type: "custom", name: "exec", description: "Use tools.exec_command(...) for local commands.", format: { type: "text" } },
] }];

function pair(id, output) {
  return [
    { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: id,
      input: "/* historical fixture; must never be executed */" },
    { type: "custom_tool_call_output", call_id: id, output },
  ];
}

function payload(overrides = {}) {
  return {
    model: "gpt-6-luna", tool_choice: "auto", stream: false,
    input: [
      { type: "additional_tools", role: "developer", tools },
      ...pair("old", FULL), { type: "reasoning", summary: [] },
      ...Array.from({ length: 4 }, (_, index) => pair(`recent-${index}`, "small")).flat(),
    ],
    ...overrides,
  };
}

function result(body) {
  return body.input.find(item => item.type === "custom_tool_call_output" && item.call_id === "old").output;
}

function json(response, value) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function fixture(t) {
  const state = mkdtempSync(path.join(os.tmpdir(), "native-archive-router-"));
  const directory = path.join(state, "retained-tool-results");
  const seen = { native: [], routed: [] };
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") return json(response, { ok: true });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
    const body = JSON.parse(bytes.toString("utf8"));
    seen[request.url.startsWith("/backend-api/") ? "native" : "routed"].push(body);
    json(response, { id: "resp_archive", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 10, output_tokens: 1 } });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const port = await openPort();
  // Preserve the host runtime's executable/search paths, never its provider
  // credentials or routing overrides. All reads/writes and HTTP peers are local
  // to this fixture, including when the invoking shell points retention at a NAS.
  const env = Object.fromEntries([
    "PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "PATHEXT", "TEMP", "TMP", "TMPDIR",
  ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, {
    HOME: path.join(state, "home"), USERPROFILE: path.join(state, "home"),
    APPDATA: path.join(state, "home", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(state, "home", "AppData", "Local"),
    CODEX_HOME: path.join(state, "codex-home"),
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_TOOL_RESULT_AGING_STATE: path.join(state, "tool-result-aging.json"),
    MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR: directory,
    // Native passthrough intentionally refuses --no-discovery. SHOW_ALL_MODELS
    // avoids credential readiness probes; the caller supplies a synthetic
    // upstream credential and every source/state override stays in this fixture.
    MODEL_ROUTER_NATIVE_TRANSPORT: "http", CODEX_ROUTER_NO_DISCOVERY: "0",
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY, CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    KIMI_INTERNAL_KEY: INTERNAL_KEY, CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_PORT: String(port), CODEX_NATIVE_BASE_URL: `${upstream}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `${upstream}/v1`, CODEX_ROUTER_API_BASE_URL: `${upstream}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `${upstream}/health`, CODEX_ROUTER_API_HEALTH_URL: `${upstream}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `${upstream}/health`, CODEX_ROUTER_GATEWAY_HEALTH_URL: `${upstream}/health`,
  });
  writeFileSync(env.MODEL_ROUTER_TOOL_RESULT_AGING_STATE,
    JSON.stringify({ version: 1, enabled: true, nativeEnabled: true, retentionTtlDays: 0 }));
  const child = spawnNodeFixture(path.join(root, "src", "router.mjs"), { cwd: root, env });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });
  const base = callerBaseUrl(port, CALLER_KEY);
  await waitForNodeFixture(`${base}/models`, child);
  return {
    state, directory, seen, env,
    files: () => existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".result")) : [],
    async send(body, thread = THREAD) {
      const response = await fetch(`${base}/responses`, {
        method: "POST", headers: { "Content-Type": "application/json",
          Authorization: "Bearer synthetic-native-session", "thread-id": thread,
          "x-openai-internal-codex-responses-lite": "true" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 200, await response.text());
      return seen[body.model === "gpt-6-luna" ? "native" : "routed"].at(-1);
    },
    async usage(count) {
      const file = path.join(state, "usage-events.jsonl");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
        lines.pop(); // A partial last record is not evidence of a completed turn.
        const events = lines.filter(Boolean).map(line => JSON.parse(line));
        if (events.length >= count) return events;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(`usage records did not settle: ${child.testErrors()}`);
    },
  };
}

function readback(output, id = "reader") {
  return [
    { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: id,
      input: "/* read-only tool-result-read.mjs fixture */" },
    { type: "custom_tool_call_output", call_id: id,
      output: JSON.stringify({ exit_code: 0, output }) },
  ];
}

test("native Responses Lite archives exact output, then omits only after real signed readback", async t => {
  const f = await fixture(t);
  const original = payload();
  const first = await f.send(original);
  assert.equal(Object.hasOwn(first, "tools"), false, "do not fabricate top-level declarations");
  assert.deepEqual(first.input[0], original.input[0]);
  assert.ok(result(first).startsWith(FULL), "every original byte survives before proof");
  assert.match(result(first), /Router archive readback pending/u);
  assert.equal(f.files().length, 1);
  const [file] = f.files();
  const handle = file.slice(0, -7);
  const saved = JSON.parse(readFileSync(path.join(f.directory, file), "utf8"));
  assert.equal(saved.text, FULL);
  assert.equal(saved.sha256, createHash("sha256").update(FULL).digest("hex"));
  const [pending] = await f.usage(1);
  assert.equal(pending.toolResultsEvaluated, 1);
  assert.equal(pending.toolResultBytesLargest, Buffer.byteLength(FULL));
  assert.equal(Object.hasOwn(pending, "toolResultsAged"), false, "zero savings are omitted from usage rows");
  assert.equal(Object.hasOwn(pending, "toolResultBytesSaved"), false);

  const page = execFileSync(process.execPath, [path.join(root, "src", "tool-result-read.mjs"),
    handle, "--store", f.directory, "--limit", "1"], {
    encoding: "utf8", timeout: 20_000, windowsHide: true, env: f.env,
  });
  assert.equal(JSON.parse(page).text, FULL.slice(0, 1));
  assert.equal(typeof JSON.parse(page).readbackProof, "string");
  const replay = { ...original, input: [...original.input, ...readback(page)] };

  // A failed reader and a tampered signed response must not authorize omission.
  const denied = await f.send({ ...original, input: [...original.input,
    ...readback(JSON.stringify({ error: "EACCES" }))] });
  assert.ok(result(denied).startsWith(FULL));
  const forged = JSON.parse(page);
  const [body, signature] = forged.readbackProof.split(".");
  forged.readbackProof = `${body}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  assert.ok(result(await f.send({ ...original,
    input: [...original.input, ...readback(JSON.stringify(forged))] })).startsWith(FULL));
  const expired = readRetainedToolResult(handle, {
    directory: f.directory, ttlMs: 0, now: Date.now() - 31 * 60_000, limit: 1,
  });
  assert.ok(result(await f.send({ ...original,
    input: [...original.input, ...readback(JSON.stringify(expired))] })).startsWith(FULL));

  const compacted = await f.send(replay);
  assert.match(result(compacted), /^\[Older tool result compacted by Codex Router/u);
  assert.ok(Buffer.byteLength(result(compacted)) < Buffer.byteLength(FULL));
  assert.deepEqual(compacted.input[0], original.input[0]);
  assert.equal(result(original), FULL, "client-owned history is never mutated");
  assert.deepEqual(compacted.input.filter(item => item.call_id === "recent-3"),
    original.input.filter(item => item.call_id === "recent-3"), "the newest frontier and call arguments remain exact");
  const events = await f.usage(5);
  assert.equal(events.at(-1).toolResultsAged, 1);
  assert.ok(events.at(-1).toolResultBytesSaved > 32 * 1024);

  for (const restriction of [
    { tools: [] }, { tools: null }, { tool_choice: "none" },
    { tool_choice: { type: "function", name: "other" } },
  ]) {
    assert.equal(result(await f.send({ ...replay, ...restriction })), FULL,
      "a valid historical proof cannot override an explicit current tool restriction");
  }

  const foreignThread = "00000000-0000-4000-8000-000000000002";
  assert.ok(result(await f.send(replay, foreignThread)).startsWith(FULL), "proof is conversation-scoped");
  const changedPolicy = { ...replay, input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "The exec tool is no longer available." }] },
    ...replay.input,
  ] };
  assert.ok(result(await f.send(changedPolicy)).startsWith(FULL), "proof is permission-scoped");
  assert.equal(f.seen.native.length, 11, "one provider request per fixture turn, no hidden generation");
  assert.equal(f.seen.routed.length, 0);
});

test("native omitted-tools recovery respects explicit capability restrictions", async t => {
  const f = await fixture(t);
  const original = payload();
  for (const overrides of [
    { tools: [] }, { tools: null }, { tool_choice: "none" },
    { tool_choice: { type: "function", name: "other" } },
    { input: original.input.slice(1) },
    { input: [{ type: "additional_tools", role: "developer", tools: [
      { type: "function", name: "web_search" },
    ] }, ...original.input.slice(1)] },
  ]) {
    const forwarded = await f.send({ ...original, ...overrides });
    assert.equal(result(forwarded), FULL);
    assert.equal(f.files().length, 0, "unavailable readers must not cause archive writes");
  }
});

test("native Responses Lite preserves exact output when the archive store is unusable", async t => {
  const f = await fixture(t);
  writeFileSync(f.directory, "a regular file cannot serve as an archive directory");
  assert.equal(result(await f.send(payload())), FULL);
  assert.equal(readFileSync(f.directory, "utf8"), "a regular file cannot serve as an archive directory");
});

test("routed omitted-tools requests do not inherit native history capability discovery", async t => {
  const f = await fixture(t);
  const original = payload({ model: "deepseek/deepseek-v4-flash" });
  const forwarded = await f.send(original);
  assert.equal(result(forwarded), FULL);
  assert.equal(f.files().length, 0);
  assert.equal(f.seen.native.length, 0);
  assert.equal(f.seen.routed.length, 1);
});
