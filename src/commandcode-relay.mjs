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
import { writeEventStreamHead } from "./http-utils.mjs";
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

/**
 * Run one turn through `/alpha/generate` and answer in the caller's protocol.
 *
 * Returns `{ status, ok, headers }` as HTTP/credential health, not generation
 * success: a committed stream reports generation failure in its error frame.
 * The upstream's own headers keep this route's quota reporting and cooldowns
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
  deferErrors = false,
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

  const finishError = async (status, raw, { mayDefer = deferErrors } = {}) => {
    const body = JSON.stringify(errorBody(status, raw));
    const responseHeaders = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (mayDefer) {
      return {
        status,
        ok: false,
        committed: false,
        headers: upstream.headers,
        responseHeaders,
        bodyText: body,
      };
    }
    response.writeHead(status, responseHeaders);
    response.end(body);
    return { status, ok: false, committed: true, headers: upstream.headers };
  };

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    return finishError(upstream.ok ? 502 : upstream.status, raw);
  }

  const outcome = (status) => ({ status, ok: upstream.ok, committed: true, headers: upstream.headers });

  const translator = new GenerateTranslator({
    protocol,
    model: model.gatewayModel,
    created: Math.floor(at / 1000),
  });
  signal?.throwIfAborted();
  async function* generationEvents() {
    try {
      yield* readGenerateEvents(upstream.body);
    } catch {
      // HTTP success already dispatched the generation. A body read failure
      // belongs to this attempt, not another key; actual cancellation remains
      // the caller's responsibility rather than becoming a synthetic reply.
      signal?.throwIfAborted();
      yield { type: "error", message: "Command Code response stream stopped before completion." };
    }
    signal?.throwIfAborted();
  }

  if (!streaming) {
    // The route only streams. A caller that asked for a whole response gets
    // one assembled here rather than a stream it never agreed to parse.
    for await (const event of generationEvents()) translator.push(event);
    const answer = translator.body();
    if (translator.error) {
      // HTTP 200 already started a generation. Committing its failure prevents
      // an API-key pool from replaying that possibly executed request.
      return finishError(502, JSON.stringify({ message: translator.error }), { mayDefer: false });
    }
    const body = JSON.stringify(answer);
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
    return outcome(200);
  }

  writeEventStreamHead(response);
  for await (const event of generationEvents()) {
    const chunk = translator.push(event);
    if (chunk) response.write(chunk);
  }
  const terminal = translator.finish();
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
  } else {
    response.write(terminal);
  }
  response.end();
  return outcome(200);
}
