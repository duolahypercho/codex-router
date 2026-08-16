import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMPRESSED_FLAG,
  END_STREAM_FLAG,
  createEnvelopeScanner,
  encodeEnvelope,
  parseEndStreamPayload,
} from "../src/connect-stream-audit.mjs";
import { DEFAULT_MAX_TOKENS } from "../src/devin-probe-checks.mjs";
import { runProbe } from "../src/devin-cli-probe.mjs";

// The provider's own modules land with the Devin CLI branch. The probe takes
// them by injection so its wiring -- which stage runs, which check fires on
// which observation, whether anything is spent -- is exercised here against a
// fabricated upstream, on a machine with neither an account nor those sources.

const utf8 = (text) => new TextEncoder().encode(text);

function varint(value) {
  const out = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// A deliberately tiny writer and reader, so the fixtures below are byte-exact
// and owe nothing to the encoder the provider ships.
function encodeMessage(schema, value) {
  const parts = [];
  for (const [name, field] of Object.entries(schema || {})) {
    const held = value?.[name];
    if (held === undefined || held === null) continue;
    for (const item of field.repeated ? held : [held]) {
      if (item === undefined || item === null) continue;
      if (field.type === "message") {
        const nested = encodeMessage(field.message, item);
        parts.push(Uint8Array.from([...varint(field.no * 8 + 2), ...varint(nested.length)]), nested);
      } else if (field.type === "string") {
        const text = utf8(String(item));
        parts.push(Uint8Array.from([...varint(field.no * 8 + 2), ...varint(text.length)]), text);
      } else {
        parts.push(Uint8Array.from([...varint(field.no * 8), ...varint(field.type === "bool" ? (item ? 1 : 0) : item)]));
      }
    }
  }
  return concatBytes(parts);
}

function decodeMessage(schema, buffer) {
  const byNumber = new Map(Object.entries(schema || {}).map(([name, field]) => [field.no, { name, field }]));
  const bytes = Uint8Array.from(buffer || []);
  const out = {};
  let offset = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[offset];
      offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (offset < bytes.length) {
    const tag = Number(readVarint());
    const no = tag >>> 3;
    const wireType = tag & 7;
    let raw;
    if (wireType === 2) {
      const length = Number(readVarint());
      raw = bytes.subarray(offset, offset + length);
      offset += length;
    } else {
      raw = readVarint();
    }
    const known = byNumber.get(no);
    if (!known) continue;
    const { name, field } = known;
    let value;
    if (field.type === "message") value = decodeMessage(field.message, raw);
    else if (field.type === "string") value = new TextDecoder().decode(raw);
    else if (field.type === "bool") value = raw !== 0n;
    else value = Number(raw);
    if (field.repeated) (out[name] || (out[name] = [])).push(value);
    else out[name] = value;
  }
  return out;
}

const TOOL_CALL = { id: { no: 1, type: "string" }, name: { no: 2, type: "string" }, argumentsJson: { no: 3, type: "string" } };
const USAGE = { inputTokens: { no: 2, type: "uint64" }, outputTokens: { no: 3, type: "uint64" } };
const RESPONSE = {
  messageId: { no: 1, type: "string" },
  deltaText: { no: 3, type: "string" },
  stopReason: { no: 5, type: "enum" },
  deltaToolCalls: { no: 6, type: "message", message: TOOL_CALL, repeated: true },
  usage: { no: 7, type: "message", message: USAGE },
  requestId: { no: 17, type: "string" },
  actualModelUid: { no: 23, type: "string" },
};
const MODEL_CONFIG = {
  label: { no: 1, type: "string" },
  disabled: { no: 4, type: "bool" },
  isPremium: { no: 7, type: "bool" },
  modelUid: { no: 22, type: "string" },
};
const MODELS_RESPONSE = { clientModelConfigs: { no: 1, type: "message", message: MODEL_CONFIG, repeated: true } };
const REQUEST = {
  metadata: { no: 1, type: "message", message: { apiKey: { no: 3, type: "string" } } },
  prompt: { no: 2, type: "string" },
  chatMessagePrompts: { no: 3, type: "message", message: { prompt: { no: 3, type: "string" } }, repeated: true },
  requestType: { no: 7, type: "enum" },
  configuration: { no: 8, type: "message", message: { maxTokens: { no: 2, type: "uint64" } } },
  chatModelUid: { no: 21, type: "string" },
};

const proto = {
  SERVICE_PATH: "exa.api_server_pb.ApiServerService",
  GET_CHAT_MESSAGE: "GetChatMessage",
  GET_CASCADE_MODEL_CONFIGS: "GetCascadeModelConfigs",
  STOP_REASON: { FUNCTION_CALL: 10, STOP_PATTERN: 2 },
  GET_CHAT_MESSAGE_REQUEST: REQUEST,
  GET_CHAT_MESSAGE_RESPONSE: RESPONSE,
  GET_CASCADE_MODEL_CONFIGS_REQUEST: { metadata: { no: 1, type: "message", message: { apiKey: { no: 3, type: "string" } } } },
  GET_CASCADE_MODEL_CONFIGS_RESPONSE: MODELS_RESPONSE,
};

function fakeProvider({ configured = true, maxTokensSeen } = {}) {
  return {
    status: { devinCliStatus: () => ({ configured, authPath: "/fake/credentials.toml", setup: "Run `devin auth login`" }) },
    session: { readDevinSession: () => ({ apiKey: "TOKEN", apiServerUrl: "https://cascade.invalid" }) },
    proto,
    wire: { encodeMessage, decodeMessage },
    turn: {
      buildChatMessageRequest: (chat, { token, modelUid }) => {
        if (maxTokensSeen) maxTokensSeen.push(chat.max_tokens);
        return {
          metadata: { apiKey: token },
          prompt: "system",
          chatMessagePrompts: (chat.messages || []).filter((m) => m.role !== "system").map((m) => ({ prompt: String(m.content) })),
          requestType: 5,
          configuration: { maxTokens: chat.max_tokens || 128_000 },
          chatModelUid: modelUid,
        };
      },
      usageFrom: (stats) => ({ prompt_tokens: stats.inputTokens || 0, completion_tokens: stats.outputTokens || 0 }),
    },
    connect: {
      connectAuthorization: (token) => `Basic ${token}-${token}`,
      // Mirrors the shipped client, including the part that matters most: a
      // Connect stream reports failure inside the terminator with HTTP 200
      // already sent, so the terminator has to be raised, not ignored.
      async *connectServerStream({ responseSchema, fetchImpl }) {
        const response = await fetchImpl();
        const scanner = createEnvelopeScanner();
        for await (const chunk of response.body) {
          for (const frame of scanner.push(chunk)) {
            if (frame.endOfStream) {
              const parsed = parseEndStreamPayload(frame.payload);
              if (parsed.error) throw new Error(parsed.error.message || parsed.error.code);
              return;
            }
            yield decodeMessage(responseSchema, frame.payload);
          }
        }
      },
    },
  };
}

function okResponse(bytes, { contentType = "application/proto" } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (key) => (key === "content-type" ? contentType : undefined) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function streamResponse(chunks) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/connect+proto" },
    body: (async function* body() {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

function errorResponse(status, payload) {
  return {
    ok: false,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(payload),
  };
}

const modelsBody = (configs) => encodeMessage(MODELS_RESPONSE, { clientModelConfigs: configs });

function runner({ models = [{ modelUid: "swe-1", label: "SWE 1", isPremium: true }], live } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith("/GetCascadeModelConfigs")) return okResponse(modelsBody(models));
    return live();
  };
  return { calls, fetchImpl };
}

async function probe(argv, provider, fetchImpl) {
  const written = [];
  const { code, report } = await runProbe(argv, {
    provider,
    fetchImpl,
    stdout: { write: (text) => written.push(text) },
    cliVersion: () => "3000.4.25",
  });
  return { code, report, output: written.join(""), checks: report?.checks || [] };
}

const statusOf = (checks, name) => checks.filter((check) => check.name === name).map((check) => check.status);
const checkOf = (checks, name) => checks.find((check) => check.name === name);

test("the free run reads the session, audits its own request and lists models without spending anything", async () => {
  const { calls, fetchImpl } = runner({ live: () => assert.fail("the free run must not start a turn") });
  const { code, checks, output } = await probe([], fakeProvider(), fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cascade.invalid/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs");
  assert.equal(calls[0].init.headers.authorization, "Basic TOKEN-TOKEN");
  assert.deepEqual(statusOf(checks, "request encoding"), ["pass"]);
  assert.deepEqual(statusOf(checks, "model list"), ["pass"]);
  assert.deepEqual(statusOf(checks, "live turn"), ["skip"]);
  assert.equal(code, 0);
  assert.match(output, /VERDICT PARTIAL/);
  assert.match(output, /Paste everything between the fences/);
});

test("the session and the token never reach the output a tester pastes in public", async () => {
  const { fetchImpl } = runner({ live: () => assert.fail("no live turn") });
  const { output } = await probe([], fakeProvider(), fetchImpl);
  assert.equal(output.includes("TOKEN"), false);
  assert.match(output, /cascade host: cascade\.invalid/);
});

test("a model list that decodes to nothing fails and names the fields that did arrive", async () => {
  // A ClientModelConfig whose uid moved off field 22 produces exactly this: a
  // well-formed response, no usable model, and -- before this change -- an OK.
  const renumbered = encodeMessage(
    { clientModelConfigs: { no: 1, type: "message", message: { movedUid: { no: 31, type: "string" } }, repeated: true } },
    { clientModelConfigs: [{ movedUid: "swe-1" }] },
  );
  const fetchImpl = async () => okResponse(renumbered);
  const { code, checks } = await probe([], fakeProvider(), fetchImpl);

  assert.deepEqual(statusOf(checks, "model list"), ["fail"]);
  assert.match(checkOf(checks, "model list").observed, /clientModelConfigs\.field 31 .* -> UNKNOWN/);
  assert.equal(code, 1);
});

test("an unauthenticated model list names the connect code and points at devin auth login", async () => {
  const fetchImpl = async () => errorResponse(401, { code: "unauthenticated", message: "invalid api key" });
  const { code, checks } = await probe([], fakeProvider(), fetchImpl);
  const check = checkOf(checks, "model list");
  assert.equal(check.status, "fail");
  assert.match(check.observed, /http=401 connect-code=unauthenticated known=true retriable=false/);
  assert.match(check.fix, /devin auth login/);
  assert.equal(code, 1);
});

test("a wrong service path shows up as unimplemented, which the fix line says is not the account's fault", async () => {
  const fetchImpl = async () => errorResponse(404, { code: "unimplemented", message: "unknown method" });
  const { checks } = await probe([], fakeProvider(), fetchImpl);
  assert.match(checkOf(checks, "model list").fix, /service path or method name is wrong/);
});

test("a missing session stops before any request is made", async () => {
  let called = false;
  const { checks, code } = await probe([], fakeProvider({ configured: false }), async () => {
    called = true;
    return okResponse(new Uint8Array(0));
  });
  assert.equal(called, false);
  assert.deepEqual(statusOf(checks, "devin cli session"), ["fail"]);
  assert.equal(code, 1);
});

test("a healthy live tool turn passes every wire assumption and caps its own spend", async () => {
  const maxTokensSeen = [];
  const frames = [
    encodeEnvelope(encodeMessage(RESPONSE, { messageId: "m1", deltaText: "one moment" })),
    encodeEnvelope(
      encodeMessage(RESPONSE, {
        deltaToolCalls: [{ id: "call_1", name: "ping", argumentsJson: '{"value":1}' }],
        stopReason: 10,
        usage: { inputTokens: 42, outputTokens: 7 },
        requestId: "req-1",
        actualModelUid: "swe-1",
      }),
    ),
    encodeEnvelope(utf8("{}"), { flags: END_STREAM_FLAG }),
  ];
  const { fetchImpl } = runner({ live: () => streamResponse(frames) });
  const { code, checks } = await probe(["--live", "--tools"], fakeProvider({ maxTokensSeen }), fetchImpl);

  assert.deepEqual(statusOf(checks, "stream framing"), ["pass"]);
  assert.deepEqual(statusOf(checks, "frame compression"), ["pass"]);
  assert.deepEqual(statusOf(checks, "end-of-stream terminator"), ["pass"]);
  assert.deepEqual(statusOf(checks, "turn produced output"), ["pass"]);
  assert.deepEqual(statusOf(checks, "usage accounting"), ["pass"]);
  assert.deepEqual(statusOf(checks, "served model"), ["pass"]);
  assert.deepEqual(statusOf(checks, "tool calls decoded"), ["pass"]);
  assert.deepEqual(statusOf(checks, "tool call ids"), ["pass"]);
  assert.deepEqual(statusOf(checks, "tool call arguments"), ["pass"]);
  assert.deepEqual(statusOf(checks, "transport replay"), ["pass"]);
  assert.equal(code, 0);
  // Every turn the probe builds is capped; the default is 64, not the
  // provider's 128k fallback.
  assert.deepEqual(maxTokensSeen, [64, 64]);
});

test("a tool call that moved off its field number is reported as a dropped call, not a shy model", async () => {
  // The quiet failure a prior review flagged. The upstream says it made a
  // function call; the decoder sees field 19 and skips it.
  const moved = { deltaToolCalls: { no: 19, type: "message", message: TOOL_CALL, repeated: true }, stopReason: { no: 5, type: "enum" } };
  const frames = [
    encodeEnvelope(encodeMessage(moved, { deltaToolCalls: [{ id: "call_1", name: "ping", argumentsJson: "{}" }], stopReason: 10 })),
    encodeEnvelope(utf8("{}"), { flags: END_STREAM_FLAG }),
  ];
  const { fetchImpl } = runner({ live: () => streamResponse(frames) });
  const { code, checks } = await probe(["--live", "--tools"], fakeProvider(), fetchImpl);

  const check = checkOf(checks, "tool calls decoded");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /dropped on the wire, not declined by the model/);
  assert.match(check.observed, /field 19 .* -> UNKNOWN/);
  assert.equal(code, 1);
});

test("a stream that ends with a Connect error after HTTP 200 fails with that error's code", async () => {
  const frames = [
    encodeEnvelope(
      utf8(JSON.stringify({ error: { code: "invalid_argument", message: "chat_model_uid is required" } })),
      { flags: END_STREAM_FLAG },
    ),
  ];
  const { fetchImpl } = runner({ live: () => streamResponse(frames) });
  const { code, checks } = await probe(["--live"], fakeProvider(), fetchImpl);

  const check = checkOf(checks, "end-of-stream terminator");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /chat_model_uid is required/);
  assert.match(check.observed, /code=invalid_argument/);
  assert.deepEqual(statusOf(checks, "stream framing"), ["fail"]);
  // The transport is supposed to raise that terminator. Replaying the bytes and
  // calling the raise a transport fault would send a tester after a defect that
  // does not exist.
  assert.deepEqual(statusOf(checks, "transport replay"), ["pass"]);
  assert.equal(code, 1);
});

test("a transport that swallows a terminator error is reported as the transport's fault", async () => {
  const frames = [encodeEnvelope(utf8(JSON.stringify({ error: { code: "internal" } })), { flags: END_STREAM_FLAG })];
  const { fetchImpl } = runner({ live: () => streamResponse(frames) });
  const provider = fakeProvider();
  provider.connect.connectServerStream = async function* swallow() {};
  const { checks } = await probe(["--live"], provider, fetchImpl);
  const check = checkOf(checks, "transport replay");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /did not raise/);
});

test("compressed frames fail instead of decoding to an empty answer", async () => {
  const frames = [
    encodeEnvelope(utf8("not really gzip"), { flags: COMPRESSED_FLAG }),
    encodeEnvelope(utf8("{}"), { flags: END_STREAM_FLAG }),
  ];
  const { fetchImpl } = runner({ live: () => streamResponse(frames) });
  const { checks } = await probe(["--live"], fakeProvider(), fetchImpl);

  assert.deepEqual(statusOf(checks, "frame compression"), ["fail"]);
  assert.deepEqual(statusOf(checks, "turn produced output"), ["fail"]);
});

test("a stream cut mid-frame is a failure, not a short answer", async () => {
  const complete = encodeEnvelope(encodeMessage(RESPONSE, { deltaText: "hello" }));
  const partial = encodeEnvelope(encodeMessage(RESPONSE, { deltaText: "world" })).subarray(0, 4);
  const { fetchImpl } = runner({ live: () => streamResponse([complete, partial]) });
  const { checks, code } = await probe(["--live"], fakeProvider(), fetchImpl);

  assert.deepEqual(statusOf(checks, "stream completeness"), ["fail"]);
  assert.deepEqual(statusOf(checks, "end-of-stream terminator"), ["fail"]);
  assert.equal(code, 1);
});

test("frames split across arbitrary chunk boundaries read the same as whole ones", async () => {
  const whole = concatBytes([
    encodeEnvelope(encodeMessage(RESPONSE, { deltaText: "ready" })),
    encodeEnvelope(utf8("{}"), { flags: END_STREAM_FLAG }),
  ]);
  const chunks = [];
  for (let offset = 0; offset < whole.length; offset += 3) chunks.push(whole.subarray(offset, offset + 3));
  const { fetchImpl } = runner({ live: () => streamResponse(chunks) });
  const { checks, code } = await probe(["--live"], fakeProvider(), fetchImpl);

  assert.deepEqual(statusOf(checks, "stream framing"), ["pass"]);
  assert.deepEqual(statusOf(checks, "turn produced output"), ["pass"]);
  assert.deepEqual(statusOf(checks, "transport replay"), ["pass"]);
  assert.equal(code, 0);
});

test("a live turn refused with invalid_argument says the request shape is wrong", async () => {
  const { fetchImpl } = runner({ live: () => errorResponse(400, { code: "invalid_argument", message: "unknown field 21" }) });
  const { checks, code } = await probe(["--live"], fakeProvider(), fetchImpl);
  const check = checkOf(checks, "live turn");
  assert.equal(check.status, "fail");
  assert.match(check.fix, /request shape being wrong/);
  assert.match(check.observed, /connect-code=invalid_argument/);
  assert.equal(code, 1);
});

test("a team setting that refuses Cascade is called out as a plan question", async () => {
  const { fetchImpl } = runner({ live: () => errorResponse(403, { code: "permission_denied", message: "cascade disabled" }) });
  const { checks } = await probe(["--live"], fakeProvider(), fetchImpl);
  assert.match(checkOf(checks, "live turn").fix, /disable_cascade|allowed_model_uids/);
});

test("a model uid not on the account's list is flagged before the turn is judged", async () => {
  const frames = [encodeEnvelope(encodeMessage(RESPONSE, { deltaText: "hi" })), encodeEnvelope(utf8("{}"), { flags: END_STREAM_FLAG })];
  const { fetchImpl } = runner({ live: () => streamResponse(frames) });
  const { checks } = await probe(["--live", "--model", "not-listed"], fakeProvider(), fetchImpl);
  assert.equal(statusOf(checks, "live turn")[0], "warn");
});

test("a mistyped flag fails the run instead of quietly downgrading it", async () => {
  const { code, checks } = await probe(["--live", "--tool"], fakeProvider(), async () => assert.fail("nothing should be sent"));
  assert.deepEqual(statusOf(checks, "arguments"), ["fail"]);
  assert.equal(code, 1);
});

test("--help prints the cost of --live and exits clean without touching the network", async () => {
  const { code, output } = await probe(["--help"], fakeProvider(), async () => assert.fail("nothing should be sent"));
  assert.equal(code, 0);
  assert.match(output, /spends ACU credit on your account/);
});

test("--json prints the same verdict as the text form", async () => {
  const { fetchImpl } = runner({ live: () => assert.fail("no live turn") });
  const { output, code } = await probe(["--json"], fakeProvider(), fetchImpl);
  const parsed = JSON.parse(output);
  assert.equal(parsed.verdict, "PARTIAL");
  assert.equal(parsed.environment["devin cli"], "3000.4.25");
  assert.ok(parsed.checks.some((check) => check.name === "model list" && check.status === "pass"));
  assert.equal(code, 0);
});

test("a missing provider module is named, with the branch that carries it", async () => {
  const absent = { missing: "./devin-proto.mjs", reason: "Cannot find module './devin-proto.mjs'" };
  const { code, checks, output } = await probe([], absent, async () => assert.fail("nothing should be sent"));
  const check = checkOf(checks, "devin provider sources");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /devin-proto\.mjs is not present/);
  assert.match(check.fix, /feat\/devin-cli-provider/);
  assert.match(output, /VERDICT FAIL/);
  assert.equal(code, 1);
});

test("with nothing injected the probe resolves the real modules, on either branch", async () => {
  // The provider's sources are absent on main and present on the Devin CLI
  // branch. Both are legitimate; what must never happen is an unhandled module
  // resolution error, so this asserts the probe reached one outcome or the other.
  const { checks } = await probe([], undefined, async () => {
    throw new Error("the network is not reachable from a test");
  });
  const missing = checkOf(checks, "devin provider sources");
  if (missing) assert.match(missing.fix, /feat\/devin-cli-provider/);
  else assert.ok(checks.some((check) => check.name === "devin cli session"), "the probe should have gone on to read the session");
});

// The tester instructions live in the repository rather than in a GitHub
// comment so they can be reviewed and cannot drift out of sync with the probe.
// These tie the two together.

test("the tester guide names the probe, the paid flag, and the cap the probe actually applies", () => {
  const guide = readFileSync(new URL("../docs/DEVIN-CLI-PROBE.md", import.meta.url), "utf8");
  assert.match(guide, /\.\/bin\/devin-probe --live --tools/);
  assert.match(guide, /`--live` is the only flag that spends anything/);
  assert.match(guide, new RegExp(`default ${DEFAULT_MAX_TOKENS}`));
  assert.match(guide, /issues\/270/);
});

test("every failure the checks can emit is explained in the guide", () => {
  const guide = readFileSync(new URL("../docs/DEVIN-CLI-PROBE.md", import.meta.url), "utf8");
  for (const name of [
    "devin cli session",
    "request encoding",
    "model list",
    "live turn",
    "stream framing",
    "frame compression",
    "stream completeness",
    "end-of-stream terminator",
    "turn produced output",
    "tool calls decoded",
    "tool call ids",
    "transport replay",
  ]) {
    assert.ok(guide.includes(`FAIL ${name}`), `docs/DEVIN-CLI-PROBE.md does not explain a "${name}" failure`);
  }
});

test("the guide is reachable from the README index rather than only from a link someone remembers", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /\(docs\/DEVIN-CLI-PROBE\.md\)/);
});
