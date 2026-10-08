import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { END_STREAM_FLAG, encodeEnvelope } from "../src/connect-stream-audit.mjs";
import { GET_CHAT_MESSAGE_RESPONSE } from "../src/devin-proto.mjs";
import { gatewayErrorStatus, translateGatewayError, upstreamFailureKind } from "../src/error-translation.mjs";
import { classifyRoutedFailure } from "../src/model-failover.mjs";
import { encodeMessage } from "../src/protobuf-wire.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-devin-internal-service-key-with-sufficient-length";
const TOKEN = "fake-private-devin-session-token";
const PRIVATE_TEXT = [
  TOKEN,
  INTERNAL_KEY,
  "private-devin-caller-capability",
  "PRIVATE_DEVIN_USER_PROMPT",
  "PRIVATE_DEVIN_TOOL_DESCRIPTION",
  "FORGED_DEVIN_LOG_LINE",
];
const echoedPrivateText = `${PRIVATE_TEXT.join(" ")} Basic ${TOKEN}-${TOKEN} ` +
  `https://example.invalid/?token=${TOKEN}\r\nFORGED_DEVIN_LOG_LINE`;
const auth = { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" };

async function waitFor(check, child, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${child.testErrors()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} timeout: ${child.testErrors()}`);
}

function assertPrivate(text) {
  for (const value of PRIVATE_TEXT) assert.ok(!text.includes(value), `private value was echoed: ${value}`);
}

function translated(bodyText, status = 403) {
  return translateGatewayError({
    status,
    bodyText,
    modelName: "SWE-1",
    providerId: "devin-cli",
    providerName: "Devin",
    providerKind: "oauth",
  }).error;
}

test("Devin forwarder diagnoses failures without exposing upstream private text", async (t) => {
  // Positive control for every absence check below: the fixture really does
  // contain private values, and the detector rejects an unsanitized echo.
  assert.throws(() => assertPrivate(echoedPrivateText), /private value was echoed/);
  let scenario;
  let requests = 0;
  let seenAuthorization;
  const backend = http.createServer(async (request, response) => {
    for await (const _ of request) void _;
    requests += 1;
    seenAuthorization = request.headers.authorization;
    if (scenario.frames) {
      response.writeHead(200, { "Content-Type": "application/connect+proto" });
      for (const frame of scenario.frames) response.write(frame);
      response.end();
    } else {
      response.writeHead(scenario.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: scenario.code, message: scenario.message }));
    }
  });
  await new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(0, "127.0.0.1", resolve);
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "devin-fwd-"));
  const credentialsPath = path.join(dir, "credentials.toml");
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  writeFileSync(credentialsPath, `windsurf_api_key = "${TOKEN}"\napi_server_url = "${backendUrl}"\n`, { mode: 0o600 });
  const port = await openPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "src", "devin-cli-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: path.join(dir, "codex"),
      MODEL_ROUTER_STATE_DIR: path.join(dir, "router"),
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_DEVIN_CLI_HOST: "127.0.0.1",
      MODEL_ROUTER_DEVIN_CLI_PORT: String(port),
      MODEL_ROUTER_QUIET: "1",
      DEVIN_CREDENTIALS_PATH: credentialsPath,
      DEVIN_CASCADE_BASE_URL: backendUrl,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (text) => { errors += text; });
  child.testErrors = () => errors;
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(async () => {
    try { return (await fetch(`${base}/health`, { headers: auth })).ok; }
    catch { return false; }
  }, child, "health");

  async function request(next, { stream = false, models = false } = {}) {
    scenario = next;
    const before = requests;
    const response = await fetch(`${base}/v1/${models ? "models" : "chat/completions"}`, {
      method: models ? "GET" : "POST",
      headers: auth,
      ...(models ? {} : { body: JSON.stringify({
        model: "swe-1",
        messages: [{ role: "user", content: "PRIVATE_DEVIN_USER_PROMPT" }],
        tools: [{ type: "function", function: {
          name: "test_tool", description: "PRIVATE_DEVIN_TOOL_DESCRIPTION",
          parameters: { type: "object", properties: {} },
        } }],
        stream,
      }) }),
    });
    const bodyText = await response.text();
    assert.equal(requests - before, 1, "a refused or partial turn must not be replayed");
    assert.equal(seenAuthorization, `Basic ${TOKEN}-${TOKEN}`);
    assertPrivate(bodyText);
    return { status: response.status, bodyText };
  }

  for (const [name, message, expected] of [
    ["MCP configuration", "Unable to process request due to an MCP configuration issue.", /MCP configuration issue/],
    ["content policy", "Request rejected by content policy.", /content policy refusal/],
    ["account permissions", "Cascade is disabled for this team.", /account permissions and team or tool configuration/],
  ]) {
    await t.test(`${name} denial stays a permission error through the gateway`, async () => {
      const result = await request({ status: 403, code: "permission_denied", message: `${message} ${echoedPrivateText}` });
      const body = JSON.parse(result.bodyText);
      assert.equal(result.status, 403);
      assert.equal(body.error.code, "devin_permission_denied");
      assert.equal(body.error.type, "permission_error");
      assert.match(body.error.message, expected);
      assert.equal(translated(result.bodyText).type, "permission_error");
      assert.doesNotMatch(translated(result.bodyText).message, /Sign in|auth login|OAuth session/);
      assert.equal(upstreamFailureKind(result), undefined);
    });
  }

  await t.test("quoted quota and context text inside a policy denial does not change classification", async () => {
    for (const message of ["MCP configuration issue", "content policy refusal"]) {
      const result = await request({ status: 403, code: "permission_denied", message:
        `${message}: tool description says 'quota exhausted; maximum context length is 20 tokens; input 40'. ${echoedPrivateText}` });
      assert.equal(upstreamFailureKind(result), undefined);
      assert.equal(gatewayErrorStatus(result), 403);
      assert.equal(translated(result.bodyText).type, "permission_error");
    }
  });

  await t.test("ambiguous permission refusals cannot trigger failover from quoted billing text", async () => {
    for (const message of [
      'Access denied because this tool is not permitted. Tool description: "quota exhausted."',
      'Request violates our acceptable use policy. User prompt: "your quota is exhausted."',
      'Access denied by team configuration. Tool description: "your plan does not include this API."',
      '"Your quota is exhausted." is text from the denied prompt.',
      'Permission denied. ' + 'x'.repeat(2_000) + ' Your quota is exhausted.',
    ]) {
      const error = { code: "permission_denied", message: `${message} ${echoedPrivateText}` };
      for (const terminator of [false, true]) {
        const result = await request(terminator
          ? { frames: [encodeEnvelope(Buffer.from(JSON.stringify({ error })), { flags: END_STREAM_FLAG })] }
          : { status: 403, ...error }, { stream: terminator });
        assert.equal(result.status, 403);
        assert.equal(JSON.parse(result.bodyText).error.type, "permission_error");
        assert.equal(translated(result.bodyText).type, "permission_error");
        assert.equal(upstreamFailureKind(result), undefined);
        assert.deepEqual(classifyRoutedFailure(result), { swap: false });
        assert.doesNotMatch(result.bodyText, /billing_error|quota is exhausted|plan does not include/);
      }
    }
  });

  await t.test("billing and entitlement denials still give billing advice", async () => {
    for (const [message, kind] of [
      ["Your quota is exhausted.", "out_of_usage"],
      ["Your plan does not include this API.", "entitlement"],
    ]) {
      const error = { code: "permission_denied", message: `${message} ${echoedPrivateText}` };
      for (const terminator of [false, true]) {
        const result = await request(terminator
          ? { frames: [encodeEnvelope(Buffer.from(JSON.stringify({ error })), { flags: END_STREAM_FLAG })] }
          : { status: 403, ...error }, { stream: terminator });
        assert.equal(JSON.parse(result.bodyText).error.type, "billing_error");
        assert.equal(upstreamFailureKind(result), kind);
        assert.equal(translated(result.bodyText).type, "billing_error");
        assert.doesNotMatch(translated(result.bodyText).message, /Sign in|auth login/);
      }
    }
  });

  await t.test("unauthenticated errors still ask for CLI login", async () => {
    const result = await request({ status: 401, code: "unauthenticated", message: echoedPrivateText });
    const body = JSON.parse(result.bodyText);
    assert.equal(result.status, 401);
    assert.equal(body.error.code, "devin_unauthenticated");
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /devin auth login/);
    assert.equal(translated(result.bodyText, 401).type, "authentication_error");
  });

  const endFrame = (error) => encodeEnvelope(Buffer.from(JSON.stringify({ error })), { flags: END_STREAM_FLAG });
  const textFrame = encodeEnvelope(encodeMessage(GET_CHAT_MESSAGE_RESPONSE, { deltaText: "partial answer" }));
  await t.test("a Connect terminator failure before output becomes JSON 403", async () => {
    const result = await request({ frames: [endFrame({ code: "permission_denied", message: `MCP configuration issue ${echoedPrivateText}` })] }, { stream: true });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.bodyText).error.code, "devin_permission_denied");
    assert.match(result.bodyText, /MCP configuration issue/);
  });

  await t.test("a permission denial after output ends the stream with its safe cause", async () => {
    const result = await request({ frames: [textFrame, endFrame({ code: "permission_denied", message: `content policy ${echoedPrivateText}` })] }, { stream: true });
    assert.equal(result.status, 200);
    assert.match(result.bodyText, /partial answer/);
    assert.match(result.bodyText, /event: error/);
    assert.match(result.bodyText, /local_router_stream_failed/);
    assert.match(result.bodyText, /content policy refusal/);
    assert.doesNotMatch(result.bodyText, /\[DONE\]/);
  });

  await t.test("successful streams still finish normally", async () => {
    const result = await request({ frames: [textFrame, endFrame(undefined)] }, { stream: true });
    assert.equal(result.status, 200);
    assert.match(result.bodyText, /partial answer/);
    assert.match(result.bodyText, /data: \[DONE\]/);
    assert.doesNotMatch(result.bodyText, /event: error/);
  });

  await t.test("untrusted codes cannot leak text or forge logs in either catch path", async () => {
    for (const code of [`permission_denied\r\n${echoedPrivateText}`, TOKEN.repeat(100)]) {
      for (const models of [false, true]) {
        const result = await request({ status: 403, code, message: echoedPrivateText }, { models });
        assert.equal(result.status, 403);
        assert.equal(JSON.parse(result.bodyText).error.code, null);
        assert.equal(translated(result.bodyText).type, "authentication_error");
      }
    }
    // Stderr can lag behind the HTTP response; wait for the last diagnostic.
    await waitFor(() => errors.split("status=403 code=unknown").length === 5, child, "safe diagnostic");
    assertPrivate(errors);
    assert.match(errors, /status=403 code=devin_permission_denied/);
    assert.match(errors, /status=401 code=devin_unauthenticated/);
    const lines = errors.split("\n").filter((line) => line.includes("request failed"));
    for (const line of lines) assert.match(line, /^\[devin-cli\] request failed: status=\d{3} code=(?:devin_permission_denied|devin_unauthenticated|unknown)$/);
  });
});
