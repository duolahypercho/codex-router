import { Readable } from "node:stream";

export const MAX_BODY_BYTES = Number(
  process.env.CODEX_ROUTER_MAX_BODY_BYTES ||
    process.env.KIMI_PROXY_MAX_BODY_BYTES ||
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

export function copyResponseHeaders(upstream, response, denylist = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!denylist.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

export async function pipeResponse(upstream, response, denylist) {
  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response, denylist);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body);
    stream.once("error", reject);
    response.once("finish", resolve);
    response.once("error", reject);
    stream.pipe(response);
  });
}

export function requireInternalAuth(request, response, secret) {
  const authorized = request.headers.authorization === `Bearer ${secret}`;
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
