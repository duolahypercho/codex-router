import { Readable } from "node:stream";

import { secretEqual } from "./caller-auth.mjs";
import { TARGET } from "./paths.mjs";

export const MAX_BODY_BYTES = Number(
  process.env.MODEL_ROUTER_MAX_BODY_BYTES ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_MAX_BODY_BYTES || process.env.KIMI_PROXY_MAX_BODY_BYTES
      : undefined) ||
    64 * 1024 * 1024,
);

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

export function httpErrorStatus(error, fallback = 502) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

export function copyResponseHeaders(upstream, response, denylist = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!denylist.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

export async function pipeResponse(upstream, response, denylist, transform) {
  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response, denylist);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body);
    stream.once("error", reject);
    if (transform) transform.once("error", reject);
    response.once("finish", resolve);
    response.once("error", reject);
    if (transform) stream.pipe(transform).pipe(response);
    else stream.pipe(response);
  });
}

export function requireInternalAuth(request, response, secret) {
  const authorized = secretEqual(
    request.headers.authorization,
    `Bearer ${secret}`,
  ) || secretEqual(request.headers["x-api-key"], secret);
  if (!authorized) {
    writeJson(response, 401, {
      error: {
        type: "authentication_error",
        message: "This internal loopback route requires the router service key.",
      },
    });
  }
  return authorized;
}
