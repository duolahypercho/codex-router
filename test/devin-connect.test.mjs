import assert from "node:assert/strict";
import test from "node:test";

import { connectAuthorization, connectServerStream, connectUnary } from "../src/devin-connect.mjs";
import { encodeMessage } from "../src/protobuf-wire.mjs";

const SCHEMA = { text: { no: 1, type: "string" } };

function envelope(payload, flags = 0) {
  const framed = new Uint8Array(payload.length + 5);
  framed[0] = flags;
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

function streamResponse(chunks, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    text: async () => "",
  };
}

test("sends the token as the doubled Basic credential the upstream expects", () => {
  assert.equal(connectAuthorization("devin-session-token$x"), "Basic devin-session-token$x-devin-session-token$x");
});

test("posts a unary call to the service path with the proto content type", async () => {
  let seen;
  const result = await connectUnary({
    baseUrl: "https://server.codeium.com/",
    service: "exa.api_server_pb.ApiServerService",
    method: "GetCascadeModelConfigs",
    token: "tok",
    requestSchema: SCHEMA,
    responseSchema: SCHEMA,
    message: { text: "ask" },
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => encodeMessage(SCHEMA, { text: "answer" }).buffer,
      };
    },
  });
  assert.equal(seen.url, "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs");
  assert.equal(seen.init.headers["content-type"], "application/proto");
  assert.equal(seen.init.headers["connect-protocol-version"], "1");
  assert.deepEqual(result, { text: "answer" });
});

test("frames a streaming request in one envelope", async () => {
  let body;
  const stream = connectServerStream({
    baseUrl: "https://server.codeium.com",
    service: "S",
    method: "M",
    token: "tok",
    requestSchema: SCHEMA,
    responseSchema: SCHEMA,
    message: { text: "hi" },
    fetchImpl: async (_url, init) => {
      body = init.body;
      return streamResponse([envelope(new Uint8Array(0), 2)]);
    },
  });
  for await (const _ of stream) void _;
  const payload = encodeMessage(SCHEMA, { text: "hi" });
  assert.equal(body[0], 0);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(1, false), payload.length);
  assert.deepEqual([...body.subarray(5)], [...payload]);
});

test("yields each message and stops at the end-of-stream envelope", async () => {
  const chunks = [
    envelope(encodeMessage(SCHEMA, { text: "one" })),
    envelope(encodeMessage(SCHEMA, { text: "two" })),
    envelope(new TextEncoder().encode("{}"), 2),
    envelope(encodeMessage(SCHEMA, { text: "never" })),
  ];
  const seen = [];
  for await (const message of connectServerStream({
    baseUrl: "https://x", service: "S", method: "M", token: "t",
    requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
    fetchImpl: async () => streamResponse(chunks),
  })) seen.push(message.text);
  assert.deepEqual(seen, ["one", "two"]);
});

// An envelope can arrive split across TCP reads; a parser that assumed whole
// frames would drop or mis-decode the tail of a long turn.
test("reassembles an envelope split across chunk boundaries", async () => {
  const whole = envelope(encodeMessage(SCHEMA, { text: "split" }));
  const chunks = [whole.subarray(0, 3), whole.subarray(3, 7), whole.subarray(7), envelope(new Uint8Array(0), 2)];
  const seen = [];
  for await (const message of connectServerStream({
    baseUrl: "https://x", service: "S", method: "M", token: "t",
    requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
    fetchImpl: async () => streamResponse(chunks),
  })) seen.push(message.text);
  assert.deepEqual(seen, ["split"]);
});

// Connect reports stream failures inside the terminator with HTTP 200 already
// sent. Ignoring it would turn a refused turn into a silently empty answer.
test("raises the error carried by the end-of-stream envelope", async () => {
  const terminator = new TextEncoder().encode(
    JSON.stringify({ error: { code: "resource_exhausted", message: "out of credits" } }),
  );
  await assert.rejects(
    (async () => {
      for await (const _ of connectServerStream({
        baseUrl: "https://x", service: "S", method: "M", token: "t",
        requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
        fetchImpl: async () => streamResponse([envelope(terminator, 2)]),
      })) void _;
    })(),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "devin_resource_exhausted");
      assert.match(error.message, /out of credits/);
      return true;
    },
  );
});

test("maps an unauthenticated rejection to 401 so the caller is told to sign in again", async () => {
  await assert.rejects(
    connectUnary({
      baseUrl: "https://x", service: "S", method: "M", token: "t",
      requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ code: "unauthenticated", message: "bad token" }),
      }),
    }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "devin_unauthenticated");
      return true;
    },
  );
});
