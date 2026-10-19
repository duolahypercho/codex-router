import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const callerKey = "synthetic-compaction-caller-capability-with-sufficient-length";
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const identity = { id: "resp_compact_fixture", created_at: 1791616000, model: "gpt-6.1-sol" };
const created = { type: "response.created", sequence_number: 0, response: { ...identity, status: "in_progress", output: [] } };
const completed = { type: "response.completed", sequence_number: 1, response: { ...identity, status: "completed", output: [{ type: "compaction", id: "cmp_fixture", encrypted_content: "fixture-ciphertext" }], usage: { input_tokens: 30, output_tokens: 4, total_tokens: 34 } } };

function parseEvents(body) {
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

async function fixture(t, { contentType = "text/event-stream", initial = frame(created), terminal, status = 200 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "remote-compact-stream-"));
  const attempts = [];
  let upgrades = 0;
  const origin = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    // These short fixture requests remain below the compression threshold.
    attempts.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(status, contentType ? { "Content-Type": contentType } : {});
    response.write(initial);
    setTimeout(() => {
      if (terminal) response.end(frame(terminal));
      else response.destroy();
    }, 80);
  });
  origin.on("upgrade", (_request, socket) => { upgrades += 1; socket.destroy(); });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const routerPort = await openPort();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|PSModulePath|SystemDrive|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/i.test(name)));
  Object.assign(environment, {
    HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "appdata"), LOCALAPPDATA: path.join(directory, "localappdata"),
    CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: path.join(directory, "state"), CODEX_ROUTER_STATE_DIR: path.join(directory, "state"),
    KIMI_CODE_HOME: path.join(directory, "kimi"), GROK_HOME: path.join(directory, "grok"), GROK_AUTH_PATH: path.join(directory, "grok", "auth.json"),
    CODEX_ROUTER_CALLER_KEY: callerKey, CODEX_ROUTER_INTERNAL_KEY: "synthetic-compaction-internal-capability-with-sufficient-length", KIMI_INTERNAL_KEY: "synthetic-compaction-internal-capability-with-sufficient-length",
    CODEX_ROUTER_PORT: String(routerPort), CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${origin.address().port}/backend-api/codex`,
    CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_NATIVE_RETRIES: "0", CODEX_ROUTER_QUIET: "1", NODE_USE_ENV_PROXY: "0",
  });
  const child = spawn(process.execPath, [path.join(sourceRoot, "src", "router.mjs")], { cwd: sourceRoot, env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // The production base has signal shutdown; only terminate this owned child.
      child.kill("SIGTERM");
      await exited;
    }
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = callerBaseUrl(routerPort, callerKey);
  const deadline = Date.now() + 30000;
  while (true) {
    assert.equal(child.exitCode, null, errors);
    try { if ((await fetch(`${base}/models`)).ok) break; } catch {}
    assert.ok(Date.now() < deadline, errors);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    attempts, errors: () => errors, upgrades: () => upgrades,
    usage: () => {
      const file = path.join(directory, "state", "usage-events.jsonl");
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    async compact({ v1 = false, stream = true } = {}) {
      const response = await fetch(`${base}/responses${v1 ? "/compact" : ""}`, {
        method: "POST", headers: { Authorization: "Bearer synthetic-caller", "Content-Type": "application/json" },
        body: JSON.stringify({ model: identity.model, stream, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserve the unfinished task." }] }, ...(!v1 ? [{ type: "compaction_trigger" }] : [])] }),
      });
      return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
    },
  };
}

for (const [name, options, fullIdentity] of [
  ["missing sequence", { initial: frame({ ...created, sequence_number: undefined }) }, false],
  ["unknown compaction metadata", { initial: frame(created) + frame({ type: "response.compaction.delta", sequence_number: 1, response_id: identity.id, delta: "fixture partial" }) }, false],
  ["missing content type", { contentType: null }, true],
  ["trusted metadata", {}, true],
]) {
  test(`a native V2 compact reset with ${name} ends with a client-recognizable failure without replay`, async (t) => {
    const f = await fixture(t, options);
    const result = await f.compact();
    assert.equal(result.status, 200);
    const events = parseEvents(result.body);
    const failures = events.filter((event) => event.type === "response.failed");
    assert.equal(failures.length, 1, result.body);
    const failure = failures[0];
    assert.equal(failure.response.status, "failed");
    assert.equal(failure.response.error.code, "server_error");
    assert.match(failure.response.error.message, /upstream.*(?:reset|closed|connection)/);
    assert.equal(events.some((event) => event.type === "response.completed"), false);
    if (fullIdentity) assert.equal(failure.response.id, identity.id);
    else {
      assert.equal(Object.hasOwn(failure.response, "id"), false);
      assert.equal(Object.hasOwn(failure.response, "created_at"), false);
      assert.equal(Object.hasOwn(failure, "sequence_number"), false);
    }
    assert.equal(f.attempts.length, 1);
    assert.equal(f.attempts[0].body.input.at(-1).type, "compaction_trigger");
    assert.equal(f.upgrades(), 0);
    assert.match(f.errors(), /UND_ERR_SOCKET/);
    assert.equal(f.usage().at(-1).status, 502);
  });
}

test("headerless native V2 compact success keeps its ciphertext and one completion", async (t) => {
  const f = await fixture(t, { contentType: null, terminal: completed });
  const result = await f.compact();
  assert.match(result.contentType, /text\/event-stream/);
  const events = parseEvents(result.body);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.deepEqual(events.at(-1).response.output, completed.response.output);
  assert.equal(f.attempts.length, 1);
});

test("V1 compact JSON and explicit non-SSE responses do not gain an SSE failure", async (t) => {
  for (const [options, v1] of [[{ contentType: null }, true], [{ contentType: "application/json" }, true], [{ contentType: "application/json" }, false]]) {
    const f = await fixture(t, { ...options, initial: '{"output":[' });
    const result = await f.compact({ v1 });
    assert.doesNotMatch(result.body, /event:|response.failed/);
    assert.equal(f.attempts.length, 1);
  }
});
