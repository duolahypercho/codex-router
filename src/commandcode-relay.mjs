// Serving a Command Code turn over the CLI's own route.
//
// Kept out of the API forwarder because it is the only provider whose request
// leaves in a shape no other provider uses: everything else there forwards an
// OpenAI or Anthropic body more or less intact, while this one is rewritten
// into the `/alpha/generate` envelope and rewritten back on the way home.

import {
  GENERATE_ROUTE,
  generateHeaders,
  toGenerateRequest,
} from "./commandcode-generate.mjs";
import { GenerateTranslator, readGenerateEvents } from "./commandcode-stream.mjs";
import { VERSION } from "./version.mjs";

// The registry points Command Code at `https://api.commandcode.ai/provider/v1`
// because that is where the documented API lives. `/alpha/generate` hangs off
// the origin instead, so the route is derived from whatever base URL is in
// force -- an operator who redirected the provider with COMMANDCODE_BASE_URL
// gets both routes redirected together, which is the only coherent answer.
export function generateEndpoint(baseUrl) {
  return `${new URL(baseUrl).origin}${GENERATE_ROUTE}`;
}

function errorBody(status, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  // Two error shapes reach this line: the Provider API's
  // `{error:{message,type,code}}` and the alpha route's
  // `{success:false,message,cause}`. Callers downstream read `error.message`,
  // so both are normalized to that rather than relayed as-is.
  const message =
    parsed?.error?.message ||
    parsed?.message ||
    (raw ? String(raw).slice(0, 400) : `Command Code returned ${status}.`);
  return {
    error: {
      type: parsed?.error?.type || "commandcode_generate_error",
      ...(parsed?.error?.code ? { code: parsed.error.code } : {}),
      message,
    },
  };
}

function writeHead(response, contentType) {
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

/**
 * Run one turn through `/alpha/generate` and answer in the caller's protocol.
 *
 * Returns `{ status, ok, headers }`: the status for the forwarder's log line,
 * and the upstream's own headers so this route's quota reporting and cooldowns
 * work exactly as they do for a provider forwarded intact. Nothing here throws
 * for an upstream refusal -- a refusal is a response, and the caller sees the
 * gateway's own message rather than a generic proxy error.
 */
export async function relayCommandCodeGenerate({
  payload,
  model,
  provider,
  apiKey,
  baseUrl,
  response,
  signal,
  fetchImpl = fetch,
  at = Date.now(),
}) {
  const protocol = provider.protocol === "anthropic" ? "anthropic" : "openai";
  const streaming = payload?.stream === true;
  const upstream = await fetchImpl(generateEndpoint(baseUrl), {
    method: "POST",
    headers: {
      ...generateHeaders(apiKey),
      "User-Agent": `codex-router/${VERSION}`,
      "Accept-Encoding": "identity",
    },
    body: JSON.stringify(
      toGenerateRequest(payload, { protocol, model: model.upstreamModel, at }),
    ),
    signal,
  });

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    const body = JSON.stringify(errorBody(upstream.status, raw));
    response.writeHead(upstream.status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
    return { status: upstream.status, ok: false, headers: upstream.headers };
  }

  const outcome = (status) => ({ status, ok: upstream.ok, headers: upstream.headers });

  const translator = new GenerateTranslator({
    protocol,
    model: model.gatewayModel,
    created: Math.floor(at / 1000),
  });

  if (!streaming) {
    // The route only streams. A caller that asked for a whole response gets
    // one assembled here rather than a stream it never agreed to parse.
    for await (const event of readGenerateEvents(upstream.body)) translator.push(event);
    if (translator.error) {
      const body = JSON.stringify(errorBody(502, JSON.stringify({ message: translator.error })));
      response.writeHead(502, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
      return outcome(502);
    }
    const body = JSON.stringify(translator.body());
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
    return outcome(200);
  }

  writeHead(response, "text/event-stream");
  for await (const event of readGenerateEvents(upstream.body)) {
    const chunk = translator.push(event);
    if (chunk) response.write(chunk);
  }
  if (translator.error) {
    // The head is long gone, so the only honest place left to report a
    // mid-stream failure is inside the stream. Terminating cleanly afterwards
    // matters more than the shape: a caller still waiting on a terminal event
    // hangs until its own timeout otherwise.
    response.write(
      protocol === "anthropic"
        ? `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "api_error", message: translator.error },
          })}\n\n`
        : `data: ${JSON.stringify(errorBody(502, JSON.stringify({ message: translator.error })))}\n\n`,
    );
  }
  response.write(translator.finish());
  response.end();
  return outcome(200);
}
