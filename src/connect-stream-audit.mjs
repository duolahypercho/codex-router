// Connect-protocol facts, owned in one place: the envelope frame layout, the
// full error-code table, and a scanner that reads a stream without decoding it.
//
// The scanner exists for the probe, which must not test a transport with the
// transport. The constants and the code table are shared with the client in
// `devin-connect.mjs`, because the alternative -- a second table restated there
// -- is exactly the drift this module was written to catch. Nothing here
// imports the client, so the direction stays one-way.
//
// A transport reads frames in order to yield messages, and drops everything it
// does not need: the compression bit, the frames it never completed, the shape
// of the end-of-stream terminator. Those are exactly the things a probe has to
// report, because each one has a quiet failure mode:
//
//   * A frame flagged compressed carries bytes that are not protobuf. Handed
//     straight to a decoder they yield no fields, or a wire-type error naming
//     nothing the reader can act on; either way the turn produces no text and
//     no tool calls. The client refuses such a frame by name and asks for
//     `connect-accept-encoding: identity` so a compliant server never sends
//     one.
//   * A stream that ends mid-frame yields every complete message before it and
//     then stops, which reads as a short answer.
//   * A Connect stream reports failure inside the terminator with HTTP 200
//     already sent, so a client that ignores the terminator reports success.
//
// The status table below is the full set of Connect error codes. An incomplete
// table is not a cosmetic gap: a code that falls through lands on 502, which is
// the first entry in `RETRYABLE_STATUSES` (`upstream-retry.mjs`), is transient
// to the vision bridge's "any 5xx" rule, and costs Codex one of its own
// reconnects when relayed. `unimplemented` -- the code an upstream returns when
// the service path or method name is wrong -- must never arrive dressed that
// way, because it will never succeed.

export const COMPRESSED_FLAG = 0x01;
export const END_STREAM_FLAG = 0x02;
export const ENVELOPE_HEADER_BYTES = 5;

export const CONNECT_CODE_STATUS = Object.freeze({
  canceled: 499,
  unknown: 502,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 502,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
});

// Only these are worth another attempt. Everything else describes a request the
// upstream will refuse identically next time.
const RETRIABLE_CODES = new Set(["unavailable", "resource_exhausted", "deadline_exceeded", "aborted"]);

export function connectStatusFor(code, fallback = 502) {
  if (typeof code !== "string") return fallback;
  const status = CONNECT_CODE_STATUS[code.toLowerCase()];
  return status === undefined ? fallback : status;
}

export function isRetriableConnectCode(code) {
  return typeof code === "string" && RETRIABLE_CODES.has(code.toLowerCase());
}

export function isKnownConnectCode(code) {
  return typeof code === "string" && Object.hasOwn(CONNECT_CODE_STATUS, code.toLowerCase());
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return Uint8Array.from(input || []);
}

function concat(left, right) {
  if (!left.length) return right;
  if (!right.length) return left;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function readUint32BigEndian(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

// Incremental so a caller can feed it the chunks a response body actually
// produces. A frame header split across two chunks, or a payload split across
// five, must not be observable to the caller.
export function createEnvelopeScanner() {
  let buffered = new Uint8Array(0);
  let index = 0;
  let ended = false;

  return {
    push(chunk) {
      buffered = concat(buffered, toBytes(chunk));
      const frames = [];
      for (;;) {
        if (buffered.length < ENVELOPE_HEADER_BYTES) break;
        const flags = buffered[0];
        const length = readUint32BigEndian(buffered, 1);
        if (buffered.length < ENVELOPE_HEADER_BYTES + length) break;
        const payload = buffered.slice(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + length);
        buffered = buffered.subarray(ENVELOPE_HEADER_BYTES + length);
        const frame = {
          index,
          flags,
          length,
          payload,
          compressed: (flags & COMPRESSED_FLAG) !== 0,
          endOfStream: (flags & END_STREAM_FLAG) !== 0,
        };
        index += 1;
        if (frame.endOfStream) ended = true;
        frames.push(frame);
      }
      return frames;
    },
    // Bytes the upstream sent that never became a frame. Non-empty at the end
    // of a stream means the connection died mid-frame.
    get pending() {
      return buffered.length;
    },
    get sawEndOfStream() {
      return ended;
    },
  };
}

export function scanEnvelopes(input) {
  const scanner = createEnvelopeScanner();
  const frames = scanner.push(input);
  return { frames, pending: scanner.pending, sawEndOfStream: scanner.sawEndOfStream };
}

export function encodeEnvelope(payload, { flags = 0 } = {}) {
  const bytes = toBytes(payload);
  const framed = new Uint8Array(ENVELOPE_HEADER_BYTES + bytes.length);
  framed[0] = flags;
  framed[1] = (bytes.length >>> 24) & 0xff;
  framed[2] = (bytes.length >>> 16) & 0xff;
  framed[3] = (bytes.length >>> 8) & 0xff;
  framed[4] = bytes.length & 0xff;
  framed.set(bytes, ENVELOPE_HEADER_BYTES);
  return framed;
}

// The terminator is JSON, `{}` on success and `{"error":{"code","message"}}` on
// failure. A terminator that is neither is reported as malformed rather than
// silently treated as success, because "we could not read the terminator" and
// "the upstream said the turn succeeded" are different claims.
export function parseEndStreamPayload(payload) {
  const text = new TextDecoder().decode(toBytes(payload));
  const trimmed = text.trim();
  if (!trimmed) return { text: "", json: {}, malformed: false, error: undefined };
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { text: trimmed.slice(0, 500), json: undefined, malformed: true, error: undefined };
  }
  if (!json || typeof json !== "object") {
    return { text: trimmed.slice(0, 500), json, malformed: true, error: undefined };
  }
  const failure = json.error;
  if (!failure || typeof failure !== "object") {
    return { text: trimmed.slice(0, 500), json, malformed: false, error: undefined };
  }
  const code = typeof failure.code === "string" ? failure.code : undefined;
  return {
    text: trimmed.slice(0, 500),
    json,
    malformed: false,
    error: {
      code,
      message: typeof failure.message === "string" ? failure.message : undefined,
      status: connectStatusFor(code),
      retriable: isRetriableConnectCode(code),
      known: isKnownConnectCode(code),
    },
  };
}
