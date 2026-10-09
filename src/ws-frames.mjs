// The RFC 6455 frame codec shared by both directions of the Responses
// WebSocket protocol: the local edge speaks it as a server (see
// responses-websocket.mjs) and the upstream transport speaks it as a client
// (see responses-ws-client.mjs). Keeping the codec in one module means the
// client's masking is the exact inverse of the server's unmasking, and the
// bounds (message size, fragment count, close codes) cannot drift apart.

import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_FRAGMENT_FRAMES = 1_024;

// The protocol version token carried in the `OpenAI-Beta` header by both the
// server edge (accepting Codex's upgrade) and the upstream client (asking a
// provider for one). One constant, one place, no drift between directions.
export const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";

const CLOSE_CODES = [
  1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
];

export function validWebSocketKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 16 && decoded.toString("base64") === value;
}

export function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  if (socket.destroyed) return;
  const body = Buffer.from(
    JSON.stringify({ error: { type: "websocket_upgrade_rejected", message } }),
    "utf8",
  );
  const reason = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    426: "Upgrade Required",
  }[status] || "Error";
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${body.length}`,
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "ascii"), body]));
}

export function acceptUpgrade(request, socket) {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}${WS_GUID}`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  // Server-to-client frames are never masked (RFC 6455 s5.1).
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data], header.length + data.length);
}

export function encodeMaskedFrame(opcode, payload, mask = randomBytes(4)) {
  // The client-to-server mirror: every frame masked with a fresh 4-byte key.
  // Whole messages only, so the FIN bit is always set; control payloads are
  // capped at 125 bytes by the callers that build them.
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const masked = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index & 3];
  }
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, mask, masked], header.length + 4 + data.length);
}

export function closePayload(code, reason) {
  const text = Buffer.from(String(reason || ""), "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

export function validCloseCode(code) {
  return CLOSE_CODES.includes(code) || (code >= 3000 && code <= 4999);
}

export class WebSocketFrameParser {
  // One direction of one connection: raw socket bytes in, complete messages
  // and control frames out. `expectMasked` selects the direction -- a server
  // parses masked client frames, a client parses unmasked server frames --
  // because a frame the peer could not have sent is a protocol failure
  // (RFC 6455 s5.1), not a decoding detail.
  //
  // Close-frame validation (code range, UTF-8 reason) happens here because it
  // is part of the frame grammar; echoing the close and ending the socket are
  // the consumer's job, reached through the onClose callback.
  constructor({
    expectMasked,
    maxMessageBytes,
    onText,
    onBinary,
    onPing,
    onPong,
    onClose,
    onFail,
    maxFragmentFrames = MAX_FRAGMENT_FRAMES,
  }) {
    this.expectMasked = expectMasked;
    this.maxMessageBytes = maxMessageBytes;
    this.maxFragmentFrames = maxFragmentFrames;
    this.onText = onText;
    this.onBinary = onBinary;
    this.onPing = onPing;
    this.onPong = onPong;
    this.onClose = onClose;
    this.onFail = onFail;
    this.stopped = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentFrames = 0;
    this.fragmentOpcode = undefined;
  }

  stop() {
    this.stopped = true;
  }

  fail(code, reason) {
    if (this.stopped) return;
    this.stop();
    this.onFail?.(code, reason);
  }

  feed(chunk) {
    if (this.stopped || !chunk?.length) return;
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length)
      : Buffer.from(chunk);
    while (!this.stopped) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      if (first & 0x70) return this.fail(1002, "WebSocket extensions were not negotiated.");
      if (masked !== this.expectMasked) {
        return this.fail(
          1002,
          this.expectMasked
            ? "Client frames must be masked."
            : "Server frames must not be masked.",
        );
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          return this.fail(1009, "WebSocket frame is too large.");
        }
        length = Number(longLength);
        offset = 10;
      }
      if (opcode === 0x2) return this.fail(1003, "Binary messages are not supported.");
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) {
        return this.fail(1002, "Invalid WebSocket control frame.");
      }
      if (length > this.maxMessageBytes) {
        return this.fail(1009, "WebSocket message is too large.");
      }
      const frameBytes = offset + (masked ? 4 : 0) + length;
      if (this.buffer.length < frameBytes) return;
      let payload;
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const encoded = this.buffer.subarray(offset + 4, frameBytes);
        payload = Buffer.allocUnsafe(length);
        for (let index = 0; index < length; index += 1) {
          payload[index] = encoded[index] ^ mask[index & 3];
        }
      } else {
        payload = Buffer.from(this.buffer.subarray(offset, frameBytes));
      }
      this.buffer = this.buffer.subarray(frameBytes);
      this.handleFrame({ fin, opcode, payload });
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      if (payload.length === 1) return this.fail(1002, "Invalid WebSocket close frame.");
      let code;
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        if (!validCloseCode(code)) return this.fail(1002, "Invalid WebSocket close code.");
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
        } catch {
          return this.fail(1007, "Invalid WebSocket close reason.");
        }
      }
      this.onClose?.({
        code,
        reason: payload.subarray(2).toString("utf8"),
      });
      return;
    }
    if (opcode === 0x9) {
      this.onPing?.(payload);
      return;
    }
    if (opcode === 0xa) {
      this.onPong?.(payload);
      return;
    }
    if (![0x0, 0x1, 0x2].includes(opcode)) {
      return this.fail(1002, "Unsupported WebSocket opcode.");
    }
    if (opcode === 0x0) {
      if (this.fragmentOpcode === undefined) {
        return this.fail(1002, "Unexpected WebSocket continuation frame.");
      }
    } else if (this.fragmentOpcode !== undefined) {
      return this.fail(1002, "A fragmented WebSocket message is already in progress.");
    } else if (!fin) {
      this.fragmentOpcode = opcode;
    }
    this.fragmentBytes += payload.length;
    this.fragmentFrames += 1;
    if (this.fragmentFrames > this.maxFragmentFrames) {
      return this.fail(1009, "WebSocket message has too many fragments.");
    }
    if (this.fragmentBytes > this.maxMessageBytes) {
      return this.fail(1009, "WebSocket message is too large.");
    }
    this.fragments.push(payload);
    if (!fin) return;
    const complete = Buffer.concat(this.fragments, this.fragmentBytes);
    const completeOpcode = this.fragmentOpcode ?? opcode;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentFrames = 0;
    this.fragmentOpcode = undefined;
    if (completeOpcode === 0x2) {
      this.onBinary?.(complete);
      return;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
    } catch {
      return this.fail(1007, "WebSocket text is not valid UTF-8.");
    }
    this.onText?.(text);
  }
}
