// Minimal RFC 6455 WebSocket server implementation for the codex-router.
// Purpose: accept Codex's Responses WebSocket upgrade, relay the JSON request
// body into the existing HTTP request pipeline, and stream the SSE response
// back as WebSocket text frames.
//
// This is intentionally small and dependency-free: the router already ships
// undici (which has a WebSocket *client* but no server), and adding the `ws`
// package would put a new dependency on the install path. The protocol subset
// implemented here covers what Codex's Responses WebSocket client actually
// sends: masked client frames, text messages, ping/pong, and close.

import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// --- Frame encoding (server -> client, unmasked) ---

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// --- Frame decoding (client -> server, masked) ---

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    return this.tryParse();
  }

  tryParse() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
      len = Number(big);
      offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (masked && maskKey) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }
}

// --- Connection wrapper ---

export class WebSocketConnection {
  constructor(socket, request) {
    this.socket = socket;
    this.request = request;
    this.decoder = new FrameDecoder();
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    this.onError = null;

    socket.on("data", (chunk) => {
      try {
        const frame = this.decoder.push(chunk);
        if (frame) this.handleFrame(frame);
      } catch (err) {
        this.fail(err);
      }
    });
    socket.on("error", (err) => {
      if (this.onError) this.onError(err);
    });
    socket.on("close", () => {
      this.closed = true;
      if (this.onClose) this.onClose();
    });
  }

  handleFrame(frame) {
    switch (frame.opcode) {
      case 0x1: // text
        if (this.onMessage) this.onMessage(frame.payload.toString("utf8"));
        break;
      case 0x2: // binary
        if (this.onMessage) this.onMessage(frame.payload);
        break;
      case 0x8: // close
        this.close(1000);
        break;
      case 0x9: // ping
        this.sendFrame(0xa, frame.payload); // pong
        break;
      case 0xa: // pong
        break;
      default:
        break;
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      // socket gone; ignore
    }
  }

  sendText(text) {
    this.sendFrame(0x1, text);
  }

  close(code = 1000) {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.socket.write(encodeFrame(0x8, payload));
    } catch {
      // ignore
    }
    this.closed = true;
    this.socket.end();
  }

  fail(err) {
    if (this.onError) this.onError(err);
    this.closed = true;
    this.socket.destroy();
  }
}

// --- Handshake ---

export function acceptWebSocketUpgrade(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    return null;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n");
  socket.write(headers);
  return new WebSocketConnection(socket, request);
}