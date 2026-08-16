// A Connect-protocol client for the two RPCs the Devin CLI provider needs.
//
// Connect (connectrpc.com) is plain HTTP POST. Unary calls send one serialized
// message and get one back; server-streaming calls send one message and read a
// sequence of length-prefixed envelopes. That is small enough to implement
// directly, which keeps the router's dependency list where it is.

import { decodeMessage, encodeMessage } from "./protobuf-wire.mjs";

const CONNECT_VERSION = "1";
const END_STREAM_FLAG = 0x02;

function connectError(message, { status = 502, code = "devin_upstream_error" } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Connect maps its error codes onto HTTP status codes. Preserving the
// distinction matters upstream of here: the router retries a 429 or a 5xx and
// must not retry an `invalid_argument`.
const STATUS_BY_CONNECT_CODE = Object.freeze({
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  invalid_argument: 400,
  failed_precondition: 400,
  resource_exhausted: 429,
  unavailable: 503,
  deadline_exceeded: 504,
  internal: 502,
  unknown: 502,
});

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
    status: STATUS_BY_CONNECT_CODE[code] || response.status || 502,
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
              status: STATUS_BY_CONNECT_CODE[code] || 502,
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
