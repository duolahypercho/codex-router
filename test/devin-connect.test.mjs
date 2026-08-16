import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { CONNECT_CODE_STATUS } from "../src/connect-stream-audit.mjs";
import { connectAuthorization, connectServerStream, connectUnary } from "../src/devin-connect.mjs";
import { encodeMessage } from "../src/protobuf-wire.mjs";
import { isRetryableStatus } from "../src/upstream-retry.mjs";

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

// -- the full Connect code table ---------------------------------------------

const refuseUnary = (code) =>
  connectUnary({
    baseUrl: "https://x", service: "S", method: "M", token: "t",
    requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ code, message: "refused" }),
    }),
  });

const refuseStream = async (code) => {
  const terminator = new TextEncoder().encode(JSON.stringify({ error: { code, message: "refused" } }));
  for await (const _ of connectServerStream({
    baseUrl: "https://x", service: "S", method: "M", token: "t",
    requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
    fetchImpl: async () => streamResponse([envelope(terminator, 2)]),
  })) void _;
};

// A code the table does not carry falls through to the HTTP status the upstream
// happened to send, which for a Connect failure is routinely a 5xx. Half the
// spec's codes were missing, so a permanent refusal arrived wearing a transient
// status. The mapping is not decoration: it decides whether anything above this
// module sends the same doomed request again.
test("every Connect error code the spec defines has a status of its own", async () => {
  for (const [code, expected] of Object.entries(CONNECT_CODE_STATUS)) {
    await assert.rejects(refuseUnary(code), (error) => {
      assert.equal(error.status, expected, `unary ${code}`);
      assert.equal(error.code, `devin_${code}`);
      return true;
    });
    await assert.rejects(refuseStream(code), (error) => {
      assert.equal(error.status, expected, `stream terminator ${code}`);
      assert.equal(error.code, `devin_${code}`);
      return true;
    });
  }
});

// `unimplemented` is what an upstream answers when the service path or the
// method name is wrong -- a transcription that drifted, which the next attempt
// reproduces exactly. It must never leave here wearing a status the retry
// vocabulary reads as "the gateway had a bad moment".
const PERMANENT_CODES = [
  "unimplemented",
  "invalid_argument",
  "permission_denied",
  "unauthenticated",
  "not_found",
  "failed_precondition",
  "out_of_range",
  "already_exists",
  "canceled",
];

test("a refusal that can never succeed does not carry a retryable status", async () => {
  for (const code of PERMANENT_CODES) {
    for (const [shape, refuse] of [["unary", refuseUnary], ["stream terminator", refuseStream]]) {
      await assert.rejects(refuse(code), (error) => {
        assert.equal(
          isRetryableStatus(error.status),
          false,
          `${shape} ${code} mapped to ${error.status}, which the router's retry table treats as transient`,
        );
        return true;
      });
    }
  }
});

test("an unknown code still falls back to the status the upstream sent", async () => {
  await assert.rejects(
    connectUnary({
      baseUrl: "https://x", service: "S", method: "M", token: "t",
      requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
      fetchImpl: async () => ({
        ok: false,
        status: 418,
        text: async () => JSON.stringify({ code: "teapot", message: "no" }),
      }),
    }),
    (error) => {
      assert.equal(error.status, 418);
      assert.equal(error.code, "devin_teapot");
      return true;
    },
  );
});

// -- the envelope compression bit --------------------------------------------

test("asks for identity envelope encoding on both call shapes", async () => {
  let unaryInit;
  await connectUnary({
    baseUrl: "https://x", service: "S", method: "M", token: "t",
    requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
    fetchImpl: async (_url, init) => {
      unaryInit = init;
      return { ok: true, status: 200, arrayBuffer: async () => encodeMessage(SCHEMA, {}).buffer };
    },
  });
  assert.equal(unaryInit.headers["connect-accept-encoding"], "identity");

  let streamInit;
  for await (const _ of connectServerStream({
    baseUrl: "https://x", service: "S", method: "M", token: "t",
    requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
    fetchImpl: async (_url, init) => {
      streamInit = init;
      return streamResponse([envelope(new TextEncoder().encode("{}"), 2)]);
    },
  })) void _;
  assert.equal(streamInit.headers["connect-accept-encoding"], "identity");
});

// A compressed frame handed straight to the protobuf decoder is the worst
// available outcome: the bytes are not protobuf, so the turn either ends with
// no text at all or dies quoting a wire type nobody can act on. Neither says
// what happened. Name it instead.
test("refuses a compressed message frame by name instead of decoding the bytes", async () => {
  const compressed = new Uint8Array(gzipSync(Buffer.from(encodeMessage(SCHEMA, { text: "hidden" }))));
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const message of connectServerStream({
        baseUrl: "https://x", service: "S", method: "M", token: "t",
        requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
        fetchImpl: async () => streamResponse([envelope(compressed, 1), envelope(new Uint8Array(0), 2)]),
      })) seen.push(message);
    })(),
    (error) => {
      assert.equal(error.code, "devin_compressed_frame");
      assert.equal(error.status, 501);
      assert.equal(isRetryableStatus(error.status), false);
      assert.match(error.message, /compress/i);
      return true;
    },
  );
  assert.deepEqual(seen, []);
});

test("refuses a compressed end-of-stream frame rather than reading it as success", async () => {
  const compressed = new Uint8Array(gzipSync(Buffer.from("{}")));
  await assert.rejects(
    (async () => {
      for await (const _ of connectServerStream({
        baseUrl: "https://x", service: "S", method: "M", token: "t",
        requestSchema: SCHEMA, responseSchema: SCHEMA, message: {},
        fetchImpl: async () => streamResponse([envelope(compressed, 3)]),
      })) void _;
    })(),
    (error) => {
      assert.equal(error.code, "devin_compressed_frame");
      return true;
    },
  );
});
