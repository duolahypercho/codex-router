import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./port-pool.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const internalKey = "fixture-internal-service-key-with-sufficient-length";
const upstreamKey = "fixture-aiml-api-key";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pr-backlog-provider-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = path.join(directory, "state");
  mkdirSync(state, { mode: 0o700 });
  const allowed = /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|PSModulePath|SystemDrive|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/i;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name))),
    HOME: directory, USERPROFILE: directory, TMPDIR: os.tmpdir(),
    CODEX_HOME: path.join(directory, "codex"), KIMI_CODE_HOME: path.join(directory, "kimi"),
    MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    CODEX_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_QUIET: "1", CODEX_ROUTER_QUIET: "1",
  };
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: [] }), { mode: 0o600 });
  return { directory, state, env };
}

function evaluate(code, env, args = []) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });
}

function launch(script, env) {
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child, exited, output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const killGroup = () => {
        // A separate POSIX group contains only this fixture and its descendants.
        if (process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        } else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      };
      // Teardown is bounded; graceful shutdown is covered by the lifecycle suite.
      const timer = setTimeout(killGroup, 5000);
      try { await exited; }
      finally { clearTimeout(timer); killGroup(); }
    },
  };
}

async function until(check, processFixture, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.equal(processFixture.child.exitCode, null, processFixture.output());
    assert.equal(processFixture.child.signalCode, null, processFixture.output());
    assert.ok(Date.now() < deadline, `fixture did not become ready: ${processFixture.output()}`);
    await delay(40);
  }
}

export async function runProviderScenarios(t) {
  await t.test("AIML discovery keeps chat metadata across duplicate endpoint identities and reports local usage", async (t) => {
    const f = fixture(t);
    const catalog = path.join(f.directory, "catalog.json");
    writeFileSync(catalog, JSON.stringify({ data: [
      { id: "vendor/chat", type: "anthropic/messages", info: { name: "Wrong native", contextLength: 999999 } },
      { id: "vendor/chat", type: "openai/chat-completions", info: { name: "Chat fixture", contextLength: 32768 } },
      { id: "vendor/chat", type: "openai/responses", info: { name: "Wrong responses", contextLength: 777777 } },
      { id: "vendor/image", type: "openai/image-generations" },
      { id: "vendor/audio", type: "openai/audio-transcriptions" },
      { id: "vendor/unknown" },
    ] }));
    const discovered = JSON.parse(execFileSync(process.execPath, ["src/model-discovery.mjs", "aimlapi", "--fixture", catalog, "--json"], {
      cwd: root, env: f.env, encoding: "utf8", timeout: 30_000,
    }));
    assert.deepEqual(discovered.discovered, ["vendor/chat"]);
    assert.deepEqual(discovered.addable, ["vendor/chat"]);
    assert.deepEqual(discovered.registered, []);
    assert.deepEqual(discovered.contextLengths, { "vendor/chat": 32768 });
    const model = discovered.modelMetadata.find((entry) => entry.upstreamId === "vendor/chat");
    assert.equal(model.contextWindow, 32768);
    assert.equal(model.displayName, "Chat fixture");
    const result = JSON.parse(evaluate(`
      import { PROVIDERS, CHECKED_IN_MODELS, resolveProviderBaseUrl } from './src/model-registry.mjs';
      import { providerAccountUsageSnapshot } from './src/provider-account-usage.mjs';
      const provider = PROVIDERS.get('aimlapi');
      const snapshot = await providerAccountUsageSnapshot({ providerIds: ['aimlapi'], fetchImpl: () => { throw new Error('unexpected account request'); } });
      console.log(JSON.stringify({ base: resolveProviderBaseUrl(provider).baseUrl, presets: CHECKED_IN_MODELS.filter(m => m.provider === 'aimlapi'), account: snapshot.aimlapi }));
    `, { ...f.env, AIMLAPI_API_KEY: upstreamKey }));
    assert.equal(result.base, "https://api.aimlapi.com/v1");
    assert.deepEqual(result.presets, []);
    assert.equal(result.account.status, "local-only");
    assert.equal(result.account.source, "local-router");
    assert.deepEqual(result.account.metrics, []);
    assert.equal(result.account.dashboardUrl, "https://aimlapi.com/app/");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(upstreamKey));
  });

  await t.test("curated AIML route uses the actual forwarder for JSON and streamed tool turns without attribution", async (t) => {
    const f = fixture(t);
    const seen = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      seen.push({ url: request.url, headers: request.headers, body });
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          { id: "chatcmpl-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "lookup", arguments: '{"value":' } }] }, finish_reason: null }] },
          { id: "chatcmpl-fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: null }] },
          { id: "chatcmpl-fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "chatcmpl-fixture", choices: [{ index: 0, message: { role: "assistant", content: "fixture-ok" }, finish_reason: "stop" }] }));
      }
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
    const port = await freePort();
    const env = { ...f.env, MODEL_ROUTER_API_PORT: String(port), AIMLAPI_API_KEY: upstreamKey,
      AIMLAPI_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` };
    const entry = JSON.parse(evaluate(`
      import { userModelEntry, writeUserModels } from './src/user-models.mjs';
      import { writeProviderSelection } from './src/provider-selection.mjs';
      const entry = userModelEntry({ providerId: 'aimlapi', upstreamId: 'vendor/chat-fixture', priority: 101 });
      writeUserModels([entry]); writeProviderSelection(['aimlapi']); console.log(JSON.stringify(entry));
    `, env));
    const forwarder = launch("api-forwarder.mjs", env);
    try {
      const base = `http://127.0.0.1:${port}`;
      const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
      await until(async () => {
        try { return (await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
      }, forwarder);
      const send = (body) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: entry.gatewayModel, ...body }), signal: AbortSignal.timeout(10_000) });
      const plain = await send({ messages: [{ role: "user", content: "hello" }] });
      assert.equal(plain.status, 200, await plain.clone().text());
      assert.equal((await plain.json()).choices[0].message.content, "fixture-ok");
      const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } } }];
      const streamed = await send({ stream: true, messages: [{ role: "user", content: "look up 1" }], tools });
      assert.equal(streamed.status, 200);
      const stream = await streamed.text();
      const events = stream.split("\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(6)));
      const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || []);
      assert.equal(calls[0].id, "call-fixture");
      assert.equal(calls[0].function.name, "lookup");
      assert.equal(calls.map((call) => call.function.arguments || "").join(""), '{"value":1}');
      assert.match(stream, /\[DONE\]/);
      const toolResult = await send({ messages: [
        { role: "user", content: "look up 1" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-fixture", type: "function", function: { name: "lookup", arguments: '{"value":1}' } }] },
        { role: "tool", tool_call_id: "call-fixture", content: "found" },
      ], tools });
      assert.equal(toolResult.status, 200);
      await toolResult.arrayBuffer();
      assert.equal(seen.length, 3);
      assert.deepEqual(seen[1].body.tools, tools);
      assert.equal(seen[2].body.messages.at(-1).tool_call_id, "call-fixture");
      for (const request of seen) {
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.body.model, "vendor/chat-fixture");
        assert.equal(request.headers.authorization, `Bearer ${upstreamKey}`);
        for (const name of ["x-aimlapi-source", "x-aimlapi-partner-id", "x-title", "http-referer", "referer"]) assert.equal(request.headers[name], undefined);
      }
      assert.doesNotMatch(forwarder.output(), new RegExp(`${upstreamKey}|${internalKey}`));
    } finally { await forwarder.stop(); }
  });

  await t.test("startup proceeds past two real venv probe timeouts and keeps conclusive failures fatal", { skip: process.platform === "win32" }, async (t) => {
    for (const outcome of ["timeout-ready", "timeout-unready", "failed", "missing"]) {
      await t.test(outcome, async (t) => {
        const f = fixture(t);
        const source = path.join(f.directory, "source");
        const bin = path.join(source, ".venv", "bin");
        mkdirSync(bin, { recursive: true });
        for (const name of ["src", "config"]) symlinkSync(path.join(root, name), path.join(source, name), "dir");
        const marker = path.join(f.directory, "gateway-started");
        const probes = path.join(f.directory, "probes");
        if (outcome !== "missing") writeFileSync(path.join(bin, "python"), outcome === "failed"
          ? "#!/bin/sh\nprintf 'ModuleNotFoundError: encodings\\n' >&2\nexit 1\n"
          : `#!/bin/sh\nprintf 'probe\\n' >> '${probes}'\ntrap 'exit 0' TERM\nwhile :; do :; done\n`, { mode: 0o755 });
        writeFileSync(path.join(bin, "litellm"), `#!${process.execPath}\nconst http=require('node:http'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'started');http.createServer((req,res)=>{${outcome === "timeout-unready" ? "return;" : ""}res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"healthy"}');}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');\n`, { mode: 0o755 });
        for (const [name, key] of [["internal-secret", internalKey], ["caller-secret", "fixture-caller-key-with-sufficient-length"]]) writeFileSync(path.join(f.state, name), key, { mode: 0o600 });
        const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
        // Keep the symlinked main entry recognizable to forwarders with an isMain guard.
        const env = { ...f.env, CODEX_ROUTER_SOURCE_ROOT: source, NODE_OPTIONS: "--preserve-symlinks-main",
          MODEL_ROUTER_PORT: String(ports[0]), MODEL_ROUTER_GATEWAY_PORT: String(ports[1]), MODEL_ROUTER_OAUTH_PORT: String(ports[2]), MODEL_ROUTER_API_PORT: String(ports[3]), MODEL_ROUTER_GROK_OAUTH_PORT: String(ports[4]),
          CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "1000", CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS: "1000",
          CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: "1500", CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "20000",
        };
        const startup = launch("start.mjs", env);
        try {
          if (outcome === "timeout-ready") {
            await until(() => startup.output().includes("ready (authenticated loopback endpoint)"), startup);
            assert.equal(existsSync(marker), true);
            assert.equal(existsSync(path.join(f.state, "startup-attempts.json")), false);
          } else {
            let timer;
            let result;
            try { result = await Promise.race([startup.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(startup.output())), 30_000); })]); }
            finally { clearTimeout(timer); }
            assert.equal(result.code, 1, startup.output());
            if (outcome === "timeout-unready") {
              assert.equal(existsSync(marker), true);
              const record = JSON.parse(readFileSync(path.join(f.state, "startup-attempts.json"), "utf8"));
              assert.equal(record.lastReason, "health-timeout");
              assert.equal(record.consecutiveFailures, 1);
            } else {
              assert.match(startup.output(), /virtual environment is broken/);
              assert.match(startup.output(), outcome === "missing" ? /ENOENT/ : /exited with code 1/);
              assert.equal(existsSync(marker), false);
              assert.equal(existsSync(path.join(f.state, "startup-attempts.json")), false);
            }
          }
          if (outcome.startsWith("timeout")) {
            assert.equal(readFileSync(probes, "utf8"), "probe\nprobe\n");
            assert.match(startup.output(), /continuing with the bounded gateway readiness check/);
          }
        } finally { await startup.stop(); }
      });
    }
  });
}
