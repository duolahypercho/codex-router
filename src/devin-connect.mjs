// A Connect-protocol client for the two RPCs the Devin CLI provider needs.
//
// Connect (connectrpc.com) is plain HTTP POST. Unary calls send one serialized
// message and get one back; server-streaming calls send one message and read a
// sequence of length-prefixed envelopes. That is small enough to implement
// directly, which keeps the router's dependency list where it is.

import { COMPRESSED_FLAG, END_STREAM_FLAG, connectStatusFor } from "./connect-stream-audit.mjs";
import { decodeMessage, encodeMessage } from "./protobuf-wire.mjs";

const CONNECT_VERSION = "1";

// The client asks for uncompressed envelopes and refuses compressed ones, so
// there is no `zlib` here and no half-supported encoding list to keep in step
// with a server nobody has met. See `connectServerStream` for why.
const ENVELOPE_ENCODING = "identity";

function connectError(message, { status = 502, code = "devin_upstream_error" } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// The Connect code -> HTTP status table lives in `connect-stream-audit.mjs`,
// which carries all sixteen codes the protocol defines together with which of
// them are worth another attempt. It is imported rather than restated because
// two tables drift, and the half-table that used to live here is what drift
// looks like: six codes were missing, so a permanent refusal left this module
// as a 502.
//
// 502 is not a neutral default. It is the first entry in
// `RETRYABLE_STATUSES` (`upstream-retry.mjs`), the vision bridge treats any
// 5xx as transient and reads the image again, and Codex answers a relayed 5xx
// by spending one of its own reconnects. None of that can help a request the
// upstream will refuse identically next time, so `already_exists`, `aborted`,
// `out_of_range`, `canceled`, and `unimplemented` now leave here wearing
// statuses that say so.

export function connectAuthorization(token) {
  // Transcribed from the shipped client: the token is repeated either side of
  // a hyphen and sent as a `Basic` credential without base64 encoding.
  return `Basic ${token}-${token}`;
}

function requestUrl(baseUrl, service, method) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${service}/${method}`;
}

async function failureFromResponse(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const code = typeof parsed?.code === "string" ? parsed.code : undefined;
  const message = parsed?.message || body.slice(0, 500) || `HTTP ${response.status}`;
  return connectError(`Devin upstream refused the request: ${message}`, {
    status: connectStatusFor(code, response.status || 502),
    code: code ? `devin_${code}` : "devin_upstream_error",
  });
}

export async function connectUnary({
  baseUrl,
  service,
  method,
  token,
  requestSchema,
  responseSchema,
  message,
  signal,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(requestUrl(baseUrl, service, method), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": CONNECT_VERSION,
      "connect-accept-encoding": ENVELOPE_ENCODING,
      authorization: connectAuthorization(token),
    },
    body: encodeMessage(requestSchema, message),
  });
  if (!response.ok) throw await failureFromResponse(response);
  const body = new Uint8Array(await response.arrayBuffer());
  return decodeMessage(responseSchema, body);
}

function envelope(payload) {
  const framed = new Uint8Array(payload.length + 5);
  framed[0] = 0;
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

// Yields decoded response messages until the upstream sends its end-of-stream
// envelope. A Connect stream reports failure *inside* that final envelope with
// HTTP 200 already sent, so the terminator is inspected rather than ignored.
//
// Envelope compression is refused rather than implemented, and the request says
// so with `connect-accept-encoding: identity`. Connect allows a message to be
// compressed independently of the HTTP body, and those bytes are not protobuf:
// handing them to the decoder ends the turn with no text at all, or with a wire
// type nobody can act on. Decompressing them instead would mean shipping gzip,
// br, zstd, snappy, and deflate against a backend no maintainer has ever
// reached -- untestable code covering a case a compliant server will never
// produce once it has been told identity. So the transport asks for identity
// and names the violation if one arrives, which is the answer this provider's
// rules ask for everywhere else: fail loudly rather than parse tolerantly.
export async function* connectServerStream({
  baseUrl,
  service,
  method,
  token,
  requestSchema,
  responseSchema,
  message,
  signal,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(requestUrl(baseUrl, service, method), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/connect+proto",
      "connect-protocol-version": CONNECT_VERSION,
      "connect-accept-encoding": ENVELOPE_ENCODING,
      authorization: connectAuthorization(token),
    },
    body: envelope(encodeMessage(requestSchema, message)),
    duplex: "half",
  });
  if (!response.ok) throw await failureFromResponse(response);
  if (!response.body) throw connectError("Devin upstream returned no response stream.");

  let buffered = new Uint8Array(0);
  for await (const chunk of response.body) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const merged = new Uint8Array(buffered.length + incoming.length);
    merged.set(buffered, 0);
    merged.set(incoming, buffered.length);
    buffered = merged;

    for (;;) {
      if (buffered.length < 5) break;
      const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
      const flags = buffered[0];
      const length = view.getUint32(1, false);
      if (buffered.length < length + 5) break;
      const payload = buffered.subarray(5, length + 5);
      buffered = buffered.subarray(length + 5);
      // Checked before the end-of-stream branch: the terminator carries the
      // flag too, and a compressed one would otherwise be read as the empty
      // `{}` that means the turn succeeded.
      if ((flags & COMPRESSED_FLAG) !== 0) {
        throw connectError(
          "Devin upstream sent a compressed Connect frame; this transport asked for identity " +
            "envelope encoding and cannot decompress one.",
          { status: connectStatusFor("unimplemented"), code: "devin_compressed_frame" },
        );
      }
      if ((flags & END_STREAM_FLAG) !== 0) {
        let terminator;
        try {
          terminator = JSON.parse(new TextDecoder().decode(payload) || "{}");
        } catch {
          terminator = {};
        }
        if (terminator?.error) {
          const code = terminator.error.code;
          throw connectError(
            `Devin upstream ended the stream: ${terminator.error.message || code || "unknown error"}`,
            {
              status: connectStatusFor(code),
              code: code ? `devin_${code}` : "devin_upstream_error",
            },
          );
        }
        return;
      }
      yield decodeMessage(responseSchema, payload);
    }
  }
}
