import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  APPLY_PATCH_TOOL_NAME,
  GROK_APPLY_PATCH_CREATE_EXAMPLE,
  GROK_APPLY_PATCH_GUIDANCE_MARKER,
  GROK_APPLY_PATCH_UPDATE_EXAMPLE,
} from "../src/grok-apply-patch-guidance.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";
import { GROK_STRUCTURED_PATCH_CODEC, MAX_STRUCTURED_PATCH_BYTES, serializeStructuredPatch } from "../src/grok-structured-patch.mjs";
import { routedModel } from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

import { GROK_PATCH_HOOK_PREFIX, GROK_PATCH_HOOK_HEADER, GROK_PATCH_HOOK_CAPABILITY } from "../src/grok-patch-hook-transport.mjs";
import { CODEX_PATCH_HOOK_BASE_PATH } from "../src/codex-patch-hook-endpoint.mjs";

const nativeHook = process.argv.includes("--native-hook");
const hookEndpoint = process.argv.includes("--native-hook-endpoint");
if (hookEndpoint && !nativeHook) throw new Error("--native-hook-endpoint requires --native-hook");
const structured = nativeHook || process.argv.includes("--structured");
const codexBinary = process.argv.find((arg) => arg.startsWith("--codex="))?.slice("--codex=".length);
if (codexBinary && !structured) throw new Error("--codex requires --structured or --native-hook");
const nativeFault = process.argv.find((arg) => arg.startsWith("--native-fault="))?.slice("--native-fault=".length);
if (nativeFault && (!codexBinary || !["disconnect", "duplicate-close", "invalid-arguments"].includes(nativeFault))) {
  throw new Error("--native-fault=disconnect|duplicate-close|invalid-arguments requires --codex");
}
const nativeHookControl = process.argv.find((arg) => arg.startsWith("--native-hook-control="))?.slice("--native-hook-control=".length);
if (nativeHookControl && (!nativeHook || !codexBinary || nativeFault || !["missing", "untrusted", "changed"].includes(nativeHookControl))) {
  throw new Error("--native-hook-control=missing|untrusted|changed requires --native-hook --codex and no --native-fault");
}
const nativeOutsideDir = process.argv.find((arg) => arg.startsWith("--native-outside-dir="))?.slice("--native-outside-dir=".length);
if (nativeOutsideDir && (!nativeHook || !codexBinary || nativeFault || nativeHookControl || !path.isAbsolute(nativeOutsideDir))) {
  throw new Error("--native-outside-dir=/absolute/parent requires --native-hook --codex and no other control/fault");
}
const singleNativeControl = Boolean(nativeHookControl || nativeOutsideDir);
let outsideCanaryDirectory;
const paddingOption = process.argv.find((arg) => arg.startsWith("--native-error-padding="))?.slice("--native-error-padding=".length);
const errorPadding = paddingOption === undefined ? 0 : Number(paddingOption);
if (paddingOption !== undefined && (!nativeHook || !codexBinary || singleNativeControl || nativeFault || !Number.isSafeInteger(errorPadding) || errorPadding < 0 || errorPadding > MAX_STRUCTURED_PATCH_BYTES - 24)) {
  throw new Error("--native-error-padding=N requires --native-hook --codex, no controls/faults, and bounded nonnegative padding");
}
const structuredOperations = { operations: [{ op: "add", path: 'café "quotes".txt', lines: ["hello “unicode”"] }] };
let nativeRecoveryProbe;
let hookRawWireArguments;
const nativeInvalidArguments = ' { "operations" : [] } \n' + " ".repeat(errorPadding);
const hookHeaders = nativeHook && !hookEndpoint ? { [GROK_PATCH_HOOK_HEADER]: GROK_PATCH_HOOK_CAPABILITY } : {};
const clientBaseUrl = (port) => callerBaseUrl(port, CALLER_KEY) + (hookEndpoint ? CODEX_PATCH_HOOK_BASE_PATH.slice(3) : "");
const wirePatchInput = (args) => nativeHook ? GROK_PATCH_HOOK_PREFIX + args : serializeStructuredPatch(JSON.parse(args));

const python = process.argv[2] || process.env.LITELLM_PYTHON;
if (!python) {
  throw new Error(
    "usage: node scripts/verify-grok-apply-patch-guidance.mjs <venv-python>",
  );
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const LITELLM_HEALTH_MS = 300_000;
const SERVICE_HEALTH_MS = 15_000;

const V4A_GRAMMAR = [
  "start: begin_patch hunk+ end_patch",
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  "",
  "hunk: add_hunk | delete_hunk | update_hunk",
  'add_hunk: "*** Add File: " filename LF add_line+',
  'delete_hunk: "*** Delete File: " filename LF',
  'update_hunk: "*** Update File: " filename LF change_move? change?',
  "filename: /(.+)/",
  'add_line: "+" /(.+)/ LF -> line',
  'change_move: "*** Move to: " filename LF',
  "change: (change_context | change_line)+ eof_line?",
  'change_context: ("@@" | "@@ " /(.+)/) LF',
  'change_line: ("+" | "-" | " ") /(.+)/ LF',
  'eof_line: "*** End of File" LF',
  "%import common.LF",
].join("\n");

const HISTORY_PATCH = [
  "*** Begin Patch",
  "*** Add File: seed.txt",
  "+before",
  "*** End Patch",
].join("\n");

const UNICODE_PATCH = [
  "*** Begin Patch",
  '*** Add File: café "quotes".txt',
  "+hello “unicode”",
  "*** End Patch",
].join("\n");

const MALFORMED_PATCH = "*** Begin Patch\nnot-a-json-object";

const children = [];
const workspace = mkdtempSync(path.join(os.tmpdir(), "grok-apply-patch-guidance-"));
const capturedGrok = [];
let cancelStreamClosed;

function redact(text) {
  return String(text || "")
    .replaceAll(CALLER_KEY, "[caller-key]")
    .replaceAll(INTERNAL_KEY, "[internal-key]")
    .replaceAll("fake-access", "[session-key]");
}

function sse(events) {
  return `${events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function nativeProbeEnvironment(home) {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...environment, HOME: home, USERPROFILE: home, CODEX_HOME: home,
    CODEX_API_KEY: "offline-protocol-fixture-not-a-real-key",
    OPENAI_API_KEY: "offline-protocol-fixture-not-a-real-key" };
}

function spawnChild(command, args, env, { detached = false, cwd = root, interactive = false, inheritEnvironment = true } = {}) {
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    cwd,
    env: { ...(inheritEnvironment ? process.env : {}), ...env },
    stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
    detached,
    ...spawnable.options,
  });
  let output = "";
  const collect = (chunk) => {
    output = (output + redact(chunk.toString("utf8"))).slice(-128 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.testOutput = () => output;
  children.push(child);
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("exit", done);
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5_000).unref();
  });
}

async function waitHttp(url, child, { headers = {}, timeoutMs = SERVICE_HEALTH_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`exited before ${url}: ${child.testOutput()}`);
    }
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // not bound yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${url}: ${child?.testOutput?.() || ""}`);
}

function itemsByCallId(sseBody) {
  const byCallId = new Map();
  for (const line of sseBody.split(/\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const item = event.item;
    if (item?.call_id) byCallId.set(item.call_id, item);
  }
  return byCallId;
}

function larkFence(description) {
  const match = String(description || "").match(/Format:\n```lark\n([\s\S]*?)\n```/);
  return match ? match[1] : undefined;
}

function applyPatchRequest({ historyInput, historyId }) {
  return {
    model: "grok-oauth/grok-4.6",
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "patch notes" }] },
      {
        type: "custom_tool_call",
        id: historyId,
        call_id: "call_history",
        name: APPLY_PATCH_TOOL_NAME,
        input: historyInput,
      },
      { type: "custom_tool_call_output", call_id: "call_history", output: "Done!" },
    ],
    tools: [
      {
        type: "custom",
        name: APPLY_PATCH_TOOL_NAME,
        description: "Apply a patch.",
        format: { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR },
      },
      {
        type: "function",
        name: APPLY_PATCH_TOOL_NAME,
        description: "ordinary same-name function",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        type: "function",
        name: "read_file",
        description: "unrelated ordinary function",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };
}

function mockFunctionCall(callId, argumentsText, name = APPLY_PATCH_TOOL_NAME, includeArgumentDone = false) {
  return sse([
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name,
      },
    },
    ...[argumentsText.slice(0, 13), argumentsText.slice(13, 29), argumentsText.slice(29)].map((delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: `fc_${callId}`,
      delta,
    })),
    ...(includeArgumentDone ? [{
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      arguments: argumentsText,
    }] : []),
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name,
        arguments: argumentsText,
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 9 } } },
  ]);
}

// Discovery and exact-command trust use the official app-server API. Only the
// disposable CODEX_HOME is changed; the caller's real trust/config is untouched.
async function prepareTrustedNativeHook(codexHome, fixtureDir) {
  const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `${shellQuote(process.execPath)} ${shellQuote(path.join(root, "scripts", "grok-patch-hook.mjs"))}`;
  const configPath = path.join(codexHome, "config.toml");
  const hooksPath = path.join(codexHome, "hooks.json");
  const writeHook = (configuredCommand) => writeFileSync(hooksPath, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "^apply_patch$", hooks: [{ type: "command", command: configuredCommand, timeout: 10 }] }],
  } }), { mode: 0o600 });
  if (nativeHookControl !== "missing") writeHook(command);
  writeFileSync(configPath, "[features]\nhooks = true\nplugins = false\nremote_plugin = false\n", { mode: 0o600 });
  async function listHooks() {
    const child = spawnChild(codexBinary, ["app-server"], nativeProbeEnvironment(codexHome), { cwd: fixtureDir, interactive: true, inheritEnvironment: false });
    let partial = "";
    let nextId = 0;
    const pending = new Map();
    child.stdout.on("data", (chunk) => {
      partial += chunk.toString("utf8");
      while (partial.includes("\n")) {
        const end = partial.indexOf("\n");
        const line = partial.slice(0, end);
        partial = partial.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    let timer;
    try {
      return await Promise.race([
        (async () => {
          await rpc("initialize", { clientInfo: { name: "router-hook-protocol-proof", version: "1" }, capabilities: { experimentalApi: true } });
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          const result = await rpc("hooks/list", { cwds: [fixtureDir] });
          return result.data.flatMap((entry) => entry.hooks);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("native hook discovery deadline")), 20_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      await stopChild(child);
    }
  }
  const initial = await listHooks();
  if (nativeHookControl === "missing") {
    assert.equal(initial.length, 0);
    return;
  }
  assert.equal(initial.length, 1, "only the prepared hook may be loaded");
  assert.equal(initial[0].command, command);
  assert.equal(initial[0].trustStatus, "untrusted");
  assert.ok(initial[0].key && initial[0].currentHash);
  if (nativeHookControl === "untrusted") return;
  writeFileSync(configPath, readFileSync(configPath, "utf8") +
    `\n[hooks.state.${JSON.stringify(initial[0].key)}]\ntrusted_hash = ${JSON.stringify(initial[0].currentHash)}\n`, { mode: 0o600 });
  const trusted = await listHooks();
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].command, command);
  assert.equal(trusted[0].currentHash, initial[0].currentHash);
  assert.equal(trusted[0].trustStatus, "trusted");
  if (nativeHookControl === "changed") {
    // Changing the discovered command invalidates trust. This control is not a
    // claim that native command trust hashes the hook's source/dependencies.
    const changedCommand = command + " --changed-trust-control";
    writeHook(changedCommand);
    const changed = await listHooks();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].command, changedCommand);
    assert.notEqual(changed[0].currentHash, trusted[0].currentHash);
    assert.equal(changed[0].trustStatus, "modified");
  }
}

let mockFailure;
const mockXai = http.createServer((request, response) => {
  handleMockRequest(request, response).catch((error) => {
    mockFailure = error;
    if (!response.headersSent) response.writeHead(500);
    response.end("Offline fixture assertion failed");
  });
});
async function handleMockRequest(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  capturedGrok.push({
    authorizationPresent: Boolean(request.headers.authorization),
    body,
  });
  const structuredTool = body.tools?.find((tool) => tool.parameters?.properties?.operations);
  const toolName = structured ? structuredTool?.name : APPLY_PATCH_TOOL_NAME;
  if (nativeRecoveryProbe) {
    const probe = nativeRecoveryProbe;
    probe.requests += 1;
    if (probe.requests > (nativeFault === "invalid-arguments" && !nativeHook ? 6 : 3) || !structuredTool) {
      response.writeHead(500);
      response.end("Unexpected native probe request");
      return;
    }
    const outputs = (body.input || []).filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
    if (nativeFault === "invalid-arguments" && outputs.length > 0) probe.invalidArgumentFeedback = true;
    if (nativeHook) {
      for (const [callId, raw] of probe.expectedHistory) {
        const history = (body.input || []).find((item) => item.type === "function_call" && item.call_id === callId);
        const feedback = outputs.find((item) => item.call_id === callId);
        assert.equal(history?.arguments, raw, `native history for ${callId} must be restored byte-exactly`);
        assert.ok(feedback, `native output must keep ${callId}`);
      }
      if (probe.requests === 2) {
        assert.equal(readFileSync(probe.fixturePath, "utf8"), nativeFault === "duplicate-close" ? "old\nmarker\n" : "old\n", "first call must remain unwritten after rejection/disconnect, or execute once after identical duplicate deduplication");
        if (singleNativeControl) {
          const rejected = outputs.find((item) => item.call_id === "call_native_repair");
          assert.match(String(rejected?.output), nativeOutsideDir ? /writing outside of the project/i : /apply_patch verification failed/i);
          if (nativeOutsideDir) assert.equal(readFileSync(probe.targetPath, "utf8"), "old\n", "native permissions must protect the outside canary");
          probe.controlFeedback = true;
        } else if (!nativeFault || nativeFault === "invalid-arguments") {
          const denied = outputs.find((item) => item.call_id === "call_native_invalid");
          assert.match(String(denied?.output), /Invalid structured apply_patch arguments \(array_bounds\)/);
          probe.invalidArgumentFeedback = true;
          probe.invalidFeedbackBytes = Buffer.byteLength(String(denied.output), "utf8");
        }
      }
    }
    probe.contextFailure ||= outputs.some((item) => item.call_id === "call_native_missing" && /Failed to find expected lines/.test(String(item.output)));
    probe.successFeedback ||= outputs.some((item) => item.call_id === "call_native_repair" && /Success/.test(String(item.output)));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (nativeFault === "invalid-arguments" && !nativeHook) {
      response.end(mockFunctionCall("call_invalid_native", '{"operations":[]}', toolName));
      return;
    }
    if (nativeHook && !singleNativeControl && (!nativeFault || nativeFault === "invalid-arguments") && probe.requests === 1) {
      probe.expectedHistory.set("call_native_invalid", nativeInvalidArguments);
      response.end(mockFunctionCall("call_native_invalid", nativeInvalidArguments, toolName));
      return;
    }
    if (probe.requests < (singleNativeControl ? 2 : 3) && (!nativeFault || !probe.successFeedback)) {
      const operations = { operations: [{ op: "update", path: probe.targetPath || "fixture.txt", hunks: [{ lines: [
        { kind: "remove", text: !nativeHook && !nativeFault && probe.requests === 1 ? "absent" : "old" },
        { kind: "add", text: nativeFault && nativeFault !== "invalid-arguments" ? "old" : "new" },
        ...(nativeFault && nativeFault !== "invalid-arguments" ? [{ kind: "add", text: "marker" }] : []),
      ] }] }] };
      const callId = !nativeHook && !nativeFault && probe.requests === 1 ? "call_native_missing" : "call_native_repair";
      const argumentsText = JSON.stringify(operations);
      if (nativeHook && !(nativeFault === "disconnect" && probe.requests === 1)) probe.expectedHistory.set(callId, argumentsText);
      const wire = mockFunctionCall(callId, argumentsText, toolName);
      if (nativeFault && probe.requests === 1) {
        const terminalOffset = wire.indexOf("event: response.completed");
        assert.ok(terminalOffset > 0);
        const prefix = wire.slice(0, terminalOffset);
        if (nativeFault === "disconnect") {
          response.write(prefix);
          setTimeout(() => response.destroy(), 50);
        } else {
          const duplicate = sse([{ type: "response.output_item.done", item: {
            type: "function_call", id: `fc_${callId}`, call_id: callId, name: toolName, arguments: argumentsText,
          } }]).replace("data: [DONE]\n\n", "");
          response.end(prefix + duplicate + wire.slice(terminalOffset));
        }
      } else response.end(wire);
    } else {
      const item = { type: "message", id: "msg_native_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "probe complete", annotations: [] }] };
      response.end(sse([
        { type: "response.created", response: { id: "resp_native_final", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "probe complete" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_native_final", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
      ]));
    }
    return;
  }
  const history = (body.input || []).find(
    (item) => item?.type === "function_call" && item.name === toolName,
  );
  const historyArgs = typeof history?.arguments === "string" ? history.arguments : "";
  if (structured && historyArgs.includes("CODEC_CANCEL_WIRE")) {
    cancelStreamClosed = new Promise((resolve) => response.once("close", resolve));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_cancel", call_id: "call_cancel", name: toolName, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_cancel", delta: '{"operations":[' },
    ]).replace("data: [DONE]\n\n", ""));
    return;
  }
  if (structured && historyArgs.includes("CODEC_REJECT_WIRE")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(mockFunctionCall("call_rejected", '{"operations":[]}', toolName));
    return;
  }
  if (nativeHook && hookRawWireArguments !== undefined) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(mockFunctionCall("call_raw_roundtrip", hookRawWireArguments, toolName, true));
    return;
  }
  if (nativeHook && (historyArgs.includes("HOOK_DISCONNECT_WIRE") || historyArgs.includes("HOOK_DUPLICATE_WIRE"))) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const args = JSON.stringify(structuredOperations);
    const wire = mockFunctionCall("call_hook_fault", args, toolName);
    const terminalOffset = wire.indexOf("event: response.completed");
    const prefix = wire.slice(0, terminalOffset);
    if (historyArgs.includes("HOOK_DISCONNECT_WIRE")) {
      response.write(prefix);
      setTimeout(() => response.destroy(), 50);
    } else {
      const duplicate = sse([{ type: "response.output_item.done", item: {
        type: "function_call", id: "fc_call_hook_fault", call_id: "call_hook_fault", name: toolName, arguments: args,
      } }]).replace("data: [DONE]\n\n", "");
      response.end(prefix + duplicate + wire.slice(terminalOffset));
    }
    return;
  }
  if (nativeHook && historyArgs.includes("HOOK_RAW_JSON_WIRE")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(mockFunctionCall("call_raw_json", '{"operations":[not-json', toolName));
    return;
  }
  const malformed = historyArgs.includes("not-a-json-object");
  const outgoingArgs = structured ? JSON.stringify(structuredOperations) : malformed ? historyArgs : JSON.stringify({ content: UNICODE_PATCH });
  const callId = malformed ? "call_malformed" : "call_unicode";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(mockFunctionCall(callId, outgoingArgs, toolName));
}

try {
  await new Promise((resolve, reject) => {
    mockXai.once("error", reject);
    mockXai.listen(0, "127.0.0.1", resolve);
  });
  const xaiPort = mockXai.address().port;

  const grokPort = await openPort();
  const gatewayPort = await openPort();
  const routerPort = await openPort();
  const pythonDir = path.dirname(python);
  const litellmBin = path.join(
    pythonDir,
    process.platform === "win32" ? "litellm.exe" : "litellm",
  );
  assert.ok(existsSync(python), `venv python missing: ${python}`);
  assert.ok(existsSync(litellmBin), `litellm entry point missing: ${litellmBin}`);

  const authPath = path.join(workspace, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ "https://auth.x.ai::test-client-id": { key: "fake-access" } }),
    { mode: 0o600 },
  );
  const litellmConfig = path.join(workspace, "litellm.yaml");
  writeFileSync(
    litellmConfig,
    [
      "model_list:",
      '  - model_name: "grok-oauth-grok-4-6"',
      "    litellm_params:",
      '      model: "openai/grok-4.6"',
      "      api_base: os.environ/GROK_OAUTH_FORWARD_BASE_URL",
      '      api_key: "os.environ/CODEX_ROUTER_INTERNAL_KEY"',
      "      use_chat_completions_api: true",
      "      num_retries: 0",
      "",
      "litellm_settings:",
      "  drop_params: true",
      "  request_timeout: 60",
      "",
      "router_settings:",
      "  disable_cooldowns: true",
      "",
      "general_settings:",
      "  disable_spend_logs: true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const sharedEnv = {
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY: "0",
    CODEX_ROUTER_GROK_STRUCTURED_PATCH: structured && !nativeHook ? "1" : "0",
    CODEX_ROUTER_GROK_PATCH_HOOK: nativeHook ? "1" : "0",
    LITELLM_MASTER_KEY: INTERNAL_KEY,
    LITELLM_LOG: "ERROR",
    LITELLM_TELEMETRY: "False",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    NO_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PATH: `${pythonDir}${path.delimiter}${process.env.PATH || ""}`,
  };

  const grokChild = spawnChild(
    process.execPath,
    [path.join(root, "src", "grok-oauth-forwarder.mjs")],
    {
      ...sharedEnv,
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort),
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${xaiPort}`,
      GROK_CLI: path.join(root, "test", "fixtures", "missing-grok-cli"),
      GROK_AUTH_PATH: authPath,
    },
  );
  await waitHttp(`http://127.0.0.1:${grokPort}/health`, grokChild, {
    headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
  });

  const litellmChild = spawnChild(
    litellmBin,
    ["--config", litellmConfig, "--host", "127.0.0.1", "--port", String(gatewayPort)],
    {
      ...sharedEnv,
      GROK_OAUTH_FORWARD_BASE_URL: `http://127.0.0.1:${grokPort}/v1`,
    },
    { detached: process.platform !== "win32" },
  );
  await waitHttp(`http://127.0.0.1:${gatewayPort}/health/liveliness`, litellmChild, {
    timeoutMs: LITELLM_HEALTH_MS,
  });

  const stateDir = path.join(workspace, "state");
  const codexHome = path.join(workspace, "codex-home");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["grok-oauth"] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const routerChild = spawnChild(process.execPath, [path.join(root, "src", "router.mjs")], {
    ...sharedEnv,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health/liveliness`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${grokPort}/health`,
    MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort),
  });
  await waitHttp(`http://127.0.0.1:${routerPort}/health`, routerChild);

  const routerUrl = `${clientBaseUrl(routerPort)}/responses`;

  async function postTurn(payload) {
    const response = await fetch(routerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALLER_KEY}`,
        "Content-Type": "application/json",
        ...hookHeaders,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.text();
    if (mockFailure) throw mockFailure;
    assert.equal(response.status, 200, redact(body));
    return body;
  }

  const unicodeBody = await postTurn(
    applyPatchRequest({ historyInput: HISTORY_PATCH, historyId: "ctc_history" }),
  );
  assert.equal(capturedGrok.length, 1);
  const grokRequest = capturedGrok[0].body;
  const grokTools = grokRequest.tools || [];
  const grokApply = grokTools.filter((tool) => structured
    ? tool.parameters?.properties?.operations
    : tool.type === "function" && tool.name === APPLY_PATCH_TOOL_NAME);
  assert.equal(grokApply.length, 1);
  assert.equal(grokApply[0].description.includes("Apply a patch."), true);
  if (structured) {
    assert.deepEqual(grokApply[0].parameters, GROK_STRUCTURED_PATCH_CODEC.parameters);
    assert.notEqual(grokApply[0].name, APPLY_PATCH_TOOL_NAME);
    const ordinary = grokTools.find((tool) => tool.name === APPLY_PATCH_TOOL_NAME);
    assert.equal(ordinary?.description, "ordinary same-name function");
    assert.deepEqual(ordinary.parameters.properties, { path: { type: "string" } });
  } else {
    assert.equal(grokApply[0].description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), true);
    assert.equal(grokApply[0].description.includes(GROK_APPLY_PATCH_CREATE_EXAMPLE), true);
    assert.equal(grokApply[0].description.includes(GROK_APPLY_PATCH_UPDATE_EXAMPLE), true);
    assert.equal(larkFence(grokApply[0].description), V4A_GRAMMAR);
    assert.deepEqual(grokApply[0].parameters?.required, ["content"]);
    assert.equal(grokApply[0].parameters?.properties?.path, undefined);
  }
  const readFile = grokTools.find((tool) => tool.type === "function" && tool.name === "read_file");
  assert.equal(readFile?.description, "unrelated ordinary function");
  assert.equal(String(readFile?.description || "").includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), false);

  const historyCall = (grokRequest.input || []).find(
    (item) => item?.type === "function_call" && item.call_id === "call_history",
  );
  assert.ok(historyCall, "history call_id must survive LiteLLM and the Grok forwarder");
  assert.equal(historyCall.name, grokApply[0].name);
  assert.deepEqual(JSON.parse(historyCall.arguments), structured ? { input: HISTORY_PATCH } : { content: HISTORY_PATCH });
  const historyResult = (grokRequest.input || []).find(
    (item) => item?.type === "function_call_output" && item.call_id === "call_history",
  );
  assert.equal(historyResult?.output, "Done!");

  const unicodeItem = itemsByCallId(unicodeBody).get("call_unicode");
  assert.equal(unicodeItem?.type, "custom_tool_call");
  assert.equal(unicodeItem.input, structured ? wirePatchInput(JSON.stringify(structuredOperations)) : UNICODE_PATCH);

  const malformedBody = await postTurn(
    applyPatchRequest({ historyInput: MALFORMED_PATCH, historyId: "ctc_malformed" }),
  );
  assert.equal(capturedGrok.length, 2);
  const malformedHistory = (capturedGrok[1].body.input || []).find(
    (item) => item?.type === "function_call" && item.call_id === "call_history",
  );
  assert.deepEqual(JSON.parse(malformedHistory.arguments), structured ? { input: MALFORMED_PATCH } : { content: MALFORMED_PATCH });
  const malformedItem = itemsByCallId(malformedBody).get("call_malformed");
  assert.equal(malformedItem?.type, "custom_tool_call");
  assert.equal(malformedItem.input, structured ? wirePatchInput(JSON.stringify(structuredOperations)) : MALFORMED_PATCH);
  if (structured) {
    const rejected = await postTurn(applyPatchRequest({ historyInput: "CODEC_REJECT_WIRE", historyId: "ctc_reject" }));
    assert.equal(capturedGrok.length, 3, "invalid arguments must not cause a hidden Router request");
    if (nativeHook) {
      assert.equal(itemsByCallId(rejected).get("call_rejected")?.input, GROK_PATCH_HOOK_PREFIX + '{"operations":[]}');
      assert.ok(rejected.includes('"type":"response.completed"'), "semantic errors reach the native hook as a completed tool call");
    } else {
      assert.ok(rejected.includes('"type":"error"') || rejected.includes('"type":"response.failed"'), "invalid arguments must surface a transport error");
      assert.equal(rejected.includes("*** Begin Patch"), false, "invalid arguments must not produce executable patch input");
      assert.equal(itemsByCallId(rejected).get("call_rejected")?.input || "", "");
      assert.equal(rejected.includes('"type":"response.completed"'), false);
    }

    const canceler = new AbortController();
    const held = fetch(routerUrl, {
      method: "POST", headers: { "Content-Type": "application/json", ...hookHeaders },
      body: JSON.stringify(applyPatchRequest({ historyInput: "CODEC_CANCEL_WIRE", historyId: "ctc_cancel" })),
      signal: canceler.signal,
    }).then((response) => response.text()).then(() => undefined, (error) => error);
    const startedDeadline = Date.now() + 10_000;
    while (!cancelStreamClosed && Date.now() < startedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    canceler.abort();
    const canceled = await held;
    assert.ok(cancelStreamClosed, "the canceled request must have reached the mock upstream");
    assert.equal(canceled?.name, "AbortError");
    // Check the replay invariant before waiting for the close. A late teardown
    // must never pre-empt it: a cancelled turn that quietly issues a second
    // upstream request is the costlier failure of the two.
    assert.equal(capturedGrok.length, 4, "client cancellation must not trigger a replay");
    // A client abort has to tear down the whole local path -- Router, LiteLLM,
    // Grok forwarder, upstream -- because that is what stops the provider
    // generating (and billing) once the user cancels. Hosted macOS runners have
    // needed more than the original 10 s for the mock to see that close (4 of
    // ~51 runs by 2026-09-12; Linux and Windows never). Waiting longer keeps the
    // guarantee on every platform instead of trading it away for quiet CI: the
    // extra budget costs time only when teardown is late, and a close that never
    // arrives still fails the run. Runs slower than the old budget report the
    // measured time, so the lagging hop can be diagnosed from CI output.
    const CANCEL_CLOSE_BUDGET_MS = 60_000;
    const CANCEL_CLOSE_EXPECTED_MS = 10_000;
    const cancelCloseStarted = Date.now();
    let closeTimer;
    const cancelClosed = await Promise.race([
      cancelStreamClosed.then(() => true),
      new Promise((resolve) => { closeTimer = setTimeout(() => resolve(false), CANCEL_CLOSE_BUDGET_MS); }),
    ]).finally(() => clearTimeout(closeTimer));
    const cancelCloseMs = Date.now() - cancelCloseStarted;
    if (!cancelClosed) {
      throw new Error(`cancellation did not reach mock upstream within ${CANCEL_CLOSE_BUDGET_MS} ms on ${process.platform}`);
    }
    if (cancelCloseMs > CANCEL_CLOSE_EXPECTED_MS) {
      process.stdout.write(`::warning title=Grok cancellation::upstream close took ${cancelCloseMs} ms on ${process.platform}, over the ${CANCEL_CLOSE_EXPECTED_MS} ms this path used to need\n`);
    }
    process.stdout.write(`ok semantic errors ${nativeHook ? "reach the client hook" : "fail closed"} without a hidden request; client cancellation closes the complete local upstream path in ${cancelCloseMs} ms\n`);
  }
  if (nativeHook) {
    // Preserve original argument bytes, including whitespace, duplicate keys and
    // malformed JSON, after both denied and successful calls. This checks the
    // full protocol bridge without requiring the optional native executable.
    const rawArguments = [
      ' { "operations" : [] } \n',
      '{"operations":[],"operations":[]}',
      '{"operations":[],"number":1.0,"escaped":"\\u0061","unicode":"🧙"}',
      '{"operations":[not-json',
      JSON.stringify(structuredOperations),
    ];
    for (const raw of rawArguments) {
      const before = capturedGrok.length;
      hookRawWireArguments = raw;
      const wire = await postTurn(applyPatchRequest({ historyInput: GROK_PATCH_HOOK_PREFIX + raw, historyId: "ctc_raw_history" }));
      hookRawWireArguments = undefined;
      assert.equal(itemsByCallId(wire).get("call_raw_roundtrip")?.input, GROK_PATCH_HOOK_PREFIX + raw, "provider arguments must reach the native hook without parsing or reserialization");
      assert.equal(capturedGrok.length, before + 1);
      const history = capturedGrok.at(-1).body.input.find((item) => item.type === "function_call" && item.call_id === "call_history");
      assert.equal(history.arguments, raw, "hook history must restore the exact original argument string");
      const result = capturedGrok.at(-1).body.input.find((item) => item.type === "function_call_output" && item.call_id === "call_history");
      assert.equal(result.output, "Done!");
    }
    for (const fault of ["HOOK_DISCONNECT_WIRE", "HOOK_DUPLICATE_WIRE"]) {
      const before = capturedGrok.length;
      const failed = await postTurn(applyPatchRequest({ historyInput: fault, historyId: "ctc_hook_fault" }));
      assert.equal(capturedGrok.length, before + 1, "transport fault must not trigger hidden Router replay");
      if (fault === "HOOK_DISCONNECT_WIRE") {
        assert.equal(failed.includes('"type":"response.completed"'), false, "disconnected upstream must not complete");
        assert.equal(itemsByCallId(failed).get("call_hook_fault")?.input || "", "", "incomplete call must never yield native input");
        assert.ok(failed.includes('"type":"error"') || failed.includes('"type":"response.failed"'));
      } else {
        // The full bridge deduplicates identical upstream closes.
        // This is one valid call, distinct from a contradictory duplicate close
        // reaching the Router, which the relay's unit contract rejects.
        const closed = failed.split("\n").filter((line) => line.startsWith("data:") && line.includes('"type":"response.output_item.done"'))
          .map((line) => JSON.parse(line.slice(5))).filter((event) => event.item?.call_id === "call_hook_fault");
        assert.equal(closed.length, 1, "identical upstream duplicate must produce exactly one completed native call");
        assert.equal(closed[0].item.input, GROK_PATCH_HOOK_PREFIX + JSON.stringify(structuredOperations));
        assert.ok(failed.includes('"type":"response.completed"'));
      }
    }
    const malformedWire = await postTurn(applyPatchRequest({ historyInput: "HOOK_RAW_JSON_WIRE", historyId: "ctc_raw_json" }));
    const malformedWireItem = itemsByCallId(malformedWire).get("call_raw_json");
    assert.equal(malformedWireItem?.input, GROK_PATCH_HOOK_PREFIX + '{"operations":[not-json');
    // This subprocess proves the repository entrypoint contract in CI, but does
    // not claim native hook trust, permissions or apply_patch execution.
    for (const [input, expectedDecision] of [[malformedWireItem.input, "deny"], [unicodeItem.input, "allow"]]) {
      const hook = spawnSync(process.execPath, [path.join(root, "scripts", "grok-patch-hook.mjs")], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", model: "grok-oauth/grok-4.6", tool_name: "apply_patch", tool_input: { command: input } }),
        encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(hook.status, 0, hook.stderr);
      const decision = JSON.parse(hook.stdout).hookSpecificOutput;
      assert.equal(decision.permissionDecision, expectedDecision);
      if (expectedDecision === "deny") assert.equal(decision.updatedInput, undefined);
      else assert.equal(decision.updatedInput.command, serializeStructuredPatch(structuredOperations));
    }
    process.stdout.write("ok exact hook argument history restored through the complete protocol path, including malformed JSON; local hook entrypoint denies malformed input and compiles Unicode operations\n");
  }
  if (codexBinary) {
    // Offline handler integration only. This separate CLI process is not a
    // native Desktop benchmark or evidence of benchmark read isolation.
    const fixtureDir = path.join(workspace, "native-fixture");
    mkdirSync(fixtureDir);
    writeFileSync(path.join(fixtureDir, "fixture.txt"), "old\n");
    if (nativeOutsideDir) {
      outsideCanaryDirectory = mkdtempSync(path.join(nativeOutsideDir, "grok-hook-permission-"));
      writeFileSync(path.join(outsideCanaryDirectory, "fixture.txt"), "old\n", { mode: 0o600 });
    }
    // Match the Router's catalog conversion. Unknown-model fallback metadata
    // does not advertise native apply_patch and cannot exercise this bridge.
    const bundled = spawnSync(codexBinary, ["debug", "models", "--bundled"], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
      env: nativeProbeEnvironment(codexHome),
    });
    assert.equal(bundled.status, 0, "read the installed binary's bundled model metadata");
    const nativeModels = JSON.parse(bundled.stdout).models;
    const template = nativeModels.find((model) => model.apply_patch_tool_type === "freeform");
    assert.ok(template, "bundled metadata must provide the native freeform patch tool");
    const catalogPath = path.join(workspace, "probe-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [routedModel(template, MODEL_BY_SLUG.get("grok-oauth/grok-4.6"))] }));
    nativeRecoveryProbe = { requests: 0, contextFailure: false, successFeedback: false, invalidArgumentFeedback: false,
      ...(nativeHook ? { expectedHistory: new Map(), fixturePath: path.join(fixtureDir, "fixture.txt"),
        ...(outsideCanaryDirectory ? { targetPath: path.join(outsideCanaryDirectory, "fixture.txt") } : {}),
      } : {}),
    };
    if (nativeHook) await prepareTrustedNativeHook(codexHome, fixtureDir);
    const args = ["exec", "--ephemeral", ...(!nativeHook ? ["--ignore-user-config"] : []), "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "--json", "--model", "grok-oauth/grok-4.6", "--cd", fixtureDir, "--disable", "plugins", "--disable", "remote_plugin"];
    for (const setting of [
      'model_provider="local-protocol"',
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      'model_providers.local-protocol.name="Offline structured patch proof"',
      `model_providers.local-protocol.base_url=${JSON.stringify(clientBaseUrl(routerPort))}`,
      'model_providers.local-protocol.wire_api="responses"',
      'model_providers.local-protocol.requires_openai_auth=false',
      'model_providers.local-protocol.supports_websockets=false',
      'approval_policy="never"',
      'model_reasoning_effort="high"',
    ]) args.push("-c", setting);
    if (nativeHook && !hookEndpoint) args.push("-c", `model_providers.local-protocol.http_headers={${JSON.stringify(GROK_PATCH_HOOK_HEADER)}=${JSON.stringify(GROK_PATCH_HOOK_CAPABILITY)}}`);
    if (hookEndpoint) args.push("-c", 'model_provider="openai"', "-c", `openai_base_url=${JSON.stringify(clientBaseUrl(routerPort))}`);
    args.push("Offline tool protocol test. Only fixture.txt in this temporary workspace may be edited. Process the supplied tool calls and finish.");
    const client = spawnChild(codexBinary, args, nativeProbeEnvironment(codexHome), { cwd: fixtureDir, inheritEnvironment: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The shared shutdown path escalates to SIGKILL after five seconds;
      // a client ignoring SIGTERM must not keep the deadline promise pending.
      void stopChild(client);
    }, 60_000);
    const exit = await new Promise((resolve, reject) => {
      client.once("error", reject);
      client.once("exit", (code) => resolve(code));
    }).finally(() => clearTimeout(timer));
    if (mockFailure) throw mockFailure;
    if (hookEndpoint) assert.equal(/falling back to HTTP|Falling back from WebSockets/i.test(client.testOutput()), false, "built-in provider must complete through the capability WebSocket endpoint without HTTP fallback");
    assert.equal(timedOut, false, "native offline handler probe deadline");
    if (exit !== 0 && nativeFault !== "invalid-arguments") {
      process.stderr.write(`offline probe state: ${JSON.stringify(nativeRecoveryProbe)}\n`);
      process.stderr.write(`Router: ${routerChild.testOutput()}\nForwarder: ${grokChild.testOutput()}\nLiteLLM: ${litellmChild.testOutput()}\n`);
    }
    if (singleNativeControl) {
      assert.equal(exit, 0, client.testOutput());
      assert.equal(nativeRecoveryProbe.requests, 2);
      assert.equal(nativeRecoveryProbe.controlFeedback, true);
      assert.equal(nativeRecoveryProbe.successFeedback, false);
      assert.equal(readFileSync(path.join(fixtureDir, "fixture.txt"), "utf8"), "old\n");
      if (nativeOutsideDir) assert.equal(readFileSync(nativeRecoveryProbe.targetPath, "utf8"), "old\n");
      process.stdout.write(`ok native ${nativeOutsideDir ? "outside-workspace permission" : nativeHookControl + " hook"}: valid structured operation refused without a write, call ID and raw history preserved\n`);
    } else if (nativeHook && (!nativeFault || nativeFault === "invalid-arguments")) {
      assert.equal(exit, 0, client.testOutput());
      assert.equal(nativeRecoveryProbe.requests, 3);
      assert.equal(nativeRecoveryProbe.invalidArgumentFeedback, true);
      assert.equal(nativeRecoveryProbe.successFeedback, true, client.testOutput());
      assert.equal(nativeRecoveryProbe.expectedHistory.size, 2);
      assert.equal(readFileSync(path.join(fixtureDir, "fixture.txt"), "utf8"), "new\n");
      process.stdout.write("ok trusted native hook denied invalid semantic arguments, preserved exact call history, then native workspace-write apply_patch executed the corrected call through the full offline bridge\n");
      process.stdout.write(`native denial measurement: argumentBytes=${Buffer.byteLength(nativeInvalidArguments, "utf8")} providerVisibleFeedbackBytes=${nativeRecoveryProbe.invalidFeedbackBytes}; native feedback may echo the complete command\n`);
    } else if (nativeFault === "invalid-arguments") {
      assert.equal(exit, 1, "invalid arguments currently fail the Codex turn");
      assert.deepEqual(nativeRecoveryProbe, { requests: 6, contextFailure: false, successFeedback: false, invalidArgumentFeedback: false });
      assert.equal(readFileSync(path.join(fixtureDir, "fixture.txt"), "utf8"), "old\n");
      assert.match(client.testOutput(), /turn.failed/);
      process.stdout.write("observed limitation: invalid structured arguments leave the fixture unchanged, but Codex makes six transport attempts and fails without native tool feedback\n");
    } else if (nativeFault) {
      assert.equal(exit, 0, client.testOutput());
      assert.ok(nativeRecoveryProbe.requests >= 2 && nativeRecoveryProbe.requests <= 3);
      assert.equal(nativeRecoveryProbe.successFeedback, true, client.testOutput());
      assert.equal(readFileSync(path.join(fixtureDir, "fixture.txt"), "utf8"), "old\nmarker\n", "fault/retry must not apply the insertion twice");
      process.stdout.write(`ok installed Codex ${nativeFault}: one marker, ${nativeRecoveryProbe.requests} upstream requests${nativeHook ? nativeFault === "disconnect" ? "; disconnected first call unwritten, native retry succeeded" : "; identical duplicate produced one native call" : " after fault/retry"}\n`);
    } else {
      assert.equal(exit, 0, client.testOutput());
      assert.deepEqual(nativeRecoveryProbe, { requests: 3, contextFailure: true, successFeedback: true, invalidArgumentFeedback: false });
      assert.equal(readFileSync(path.join(fixtureDir, "fixture.txt"), "utf8"), "new\n");
      process.stdout.write("ok installed Codex workspace-write handler received context failure, then applied repair through the complete local protocol path\n");
    }
  }
} finally {
  await Promise.all(children.map((child) => stopChild(child)));
  mockXai.closeAllConnections();
  if (mockXai.listening) await new Promise((resolve) => mockXai.close(resolve));
  rmSync(workspace, { recursive: true, force: true });
  if (outsideCanaryDirectory) rmSync(outsideCanaryDirectory, { recursive: true, force: true });
}

process.stdout.write(`ok grok apply_patch ${nativeHook ? "native hook transport" : structured ? "structured codec" : "guidance"} through Router, LiteLLM, Grok forwarder, and mock xAI\n`);
