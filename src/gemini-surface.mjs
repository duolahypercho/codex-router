// The Gemini-shaped caller surface.
//
// Gemini CLI builds `{GOOGLE_GEMINI_BASE_URL}/v1beta/models/{model}:{method}`
// through @google/genai and speaks nothing else, so a client integration for it
// needs this leaf. What it must not become is a second request path: everything
// the router does for a turn -- tool-result ageing, the vision bridge,
// prompt-token substitution, upstream retry, model failover, usage accounting
// -- lives on `/v1/responses`, and a surface that reached providers directly
// would have to reimplement all of it and then keep the two in step.
//
// So this handler translates and re-enters. `gemini-shape.mjs` converts the
// request, this file sends it through the router's own Responses endpoint over
// the loopback, and the answer is converted back. The extra hop is one local
// socket; the alternative is two copies of the only path that matters.

import { formatErrorChain, readRequestBody, writeJson } from "./http-utils.mjs";
import {
  createGeminiStreamTranslator,
  estimateGeminiTokens,
  geminiModelListPayload,
  geminiToResponsesPayload,
  parseGeminiPath,
  responsesPayloadToGemini,
} from "./gemini-shape.mjs";

export const GEMINI_ROUTE_PREFIX = "/gemini";

// google.rpc.Code names, which is what a Gemini client reads off `error.status`
// to decide whether a failure is worth retrying.
const RPC_STATUS = new Map([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "PERMISSION_DENIED"],
  [404, "NOT_FOUND"],
  [408, "DEADLINE_EXCEEDED"],
  [409, "ABORTED"],
  [413, "INVALID_ARGUMENT"],
  [415, "INVALID_ARGUMENT"],
  [422, "INVALID_ARGUMENT"],
  [429, "RESOURCE_EXHAUSTED"],
  [499, "CANCELLED"],
  [500, "INTERNAL"],
  [501, "UNIMPLEMENTED"],
  [502, "UNAVAILABLE"],
  [503, "UNAVAILABLE"],
  [504, "DEADLINE_EXCEEDED"],
]);

export function isGeminiRoute(route) {
  return (
    typeof route === "string" &&
    (route === GEMINI_ROUTE_PREFIX || route.startsWith(`${GEMINI_ROUTE_PREFIX}/`))
  );
}

function geminiError(response, status, message) {
  writeJson(response, status, {
    error: {
      code: status,
      message,
      status: RPC_STATUS.get(status) || "INTERNAL",
    },
  });
}

// The same two guards `requireCodexTransport` applies to the routed path, in
// the shape this surface answers in. A browser can reach a loopback port, and
// the caller capability is in the URL -- which is exactly what a page that
// learned the URL would replay.
function transportRejected(request, response) {
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    geminiError(
      response,
      403,
      "Browser-originated requests are not accepted by the local model router.",
    );
    return true;
  }
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    geminiError(response, 415, "Gemini router requests require Content-Type: application/json.");
    return true;
  }
  return false;
}

function upstreamMessage(text) {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message;
    return typeof message === "string" && message ? message : undefined;
  } catch {
    return undefined;
  }
}

// The loopback carries no credential on purpose.
//
// The key the CLI presents is this router's own caller capability, and the path
// it presented it on is already the proof. Relaying it upstream would put a
// router secret on a hop that can be substituted onto a provider; leaving the
// header off is also what makes `callerBroughtNoUpstreamCredential` true, which
// is how a client with no ChatGPT session of its own reaches native models.
function loopbackHeaders() {
  return { "content-type": "application/json", accept: "text/event-stream" };
}

async function readSseFrames(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchSseBlock(block, onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatchSseBlock(buffer, onEvent);
}

function dispatchSseBlock(block, onEvent) {
  // Per the SSE grammar a dispatch may carry several `data:` lines, which
  // concatenate with newlines. The router's own writers emit one, but an
  // upstream that wraps long deltas emits more, and joining only the first
  // would truncate the JSON into an unparsable fragment.
  const data = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return;
  const payload = data.join("\n");
  if (payload === "[DONE]") return;
  try {
    onEvent(JSON.parse(payload));
  } catch {
    // A frame the router did not write is not a reason to fail the turn; the
    // translator's own closer still supplies a finish reason.
  }
}

async function streamTurn({ response, upstream, model }) {
  const translator = createGeminiStreamTranslator({ model });
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const write = (chunks) => {
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  try {
    if (upstream.body) {
      await readSseFrames(upstream.body, (event) => write(translator.push(event)));
    }
  } finally {
    // Always: the SDK waits for a finishReason before it considers the turn
    // over, so an upstream that drops mid-stream would otherwise leave the CLI
    // holding an open turn until its own timeout.
    write(translator.finish());
    response.end();
  }
}

// The upstream turn should die with the client, but `request.signal` is not how
// to say so. It does not exist before Node 22, and on Node 24 it aborts as soon
// as the request body has been *read* -- which is before the loopback call is
// made, so forwarding it failed every routed turn with an instant 502 on CI
// while passing locally on a Node that has no `signal` at all. The response
// closing is the event that actually means "the caller is gone", and it means
// the same thing on every supported version.
function clientGoneSignal(response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  return {
    signal: controller.signal,
    release: () => response.off("close", abort),
  };
}

async function relayTurn({ response, model, body, stream, responsesUrl, fetchImpl }) {
  const payload = geminiToResponsesPayload({ model, body, stream });
  const client = clientGoneSignal(response);
  let upstream;
  try {
    upstream = await fetchImpl(responsesUrl, {
      method: "POST",
      headers: loopbackHeaders(),
      body: JSON.stringify(payload),
      signal: client.signal,
    });
  } catch (error) {
    client.release();
    // Naming the cause chain is the difference between a diagnosable failure
    // and "could not be reached" repeated on every turn. `messages: false`
    // keeps any upstream response text out of it; this reports names and codes.
    geminiError(
      response,
      502,
      `The local model router could not be reached: ${formatErrorChain(error, { messages: false })}`,
    );
    return;
  }
  if (!upstream.ok) {
    client.release();
    const text = await upstream.text().catch(() => "");
    geminiError(
      response,
      upstream.status,
      upstreamMessage(text) || "The local model router refused the request.",
    );
    return;
  }
  if (!stream) {
    const answered = await upstream.json().catch(() => undefined);
    client.release();
    if (!answered) {
      geminiError(response, 502, "The local model router returned an unreadable response.");
      return;
    }
    writeJson(response, 200, responsesPayloadToGemini(answered, { model }));
    return;
  }
  try {
    await streamTurn({ response, upstream, model });
  } finally {
    client.release();
  }
}

/**
 * Serves one Gemini API request.
 *
 * `route` is the path with the caller capability already stripped, so it starts
 * at `/gemini`. `routedModels()` supplies the publishable set -- the same one
 * the settings document advertises -- and a model outside it is refused by
 * name: falling through would send an unregistered slug to `/v1/responses`,
 * where it is treated as native GPT traffic, so a typo would quietly become a
 * ChatGPT-session request instead of an error anybody can read.
 */
export async function handleGeminiRequest(
  request,
  response,
  route,
  { responsesUrl, routedModels, fetchImpl = fetch } = {},
) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const parsed = parseGeminiPath(route.slice(GEMINI_ROUTE_PREFIX.length));
  if (!parsed) {
    geminiError(response, 404, `Unsupported Gemini route: ${url.pathname}`);
    return;
  }

  if (parsed.method === "list") {
    if (request.method !== "GET") {
      geminiError(response, 405, "The model list is served on GET.");
      return;
    }
    writeJson(response, 200, geminiModelListPayload(routedModels()));
    return;
  }

  if (request.method !== "POST") {
    geminiError(response, 405, `${parsed.method} is served on POST.`);
    return;
  }
  if (transportRejected(request, response)) return;

  if (parsed.method === "embedContent") {
    geminiError(
      response,
      501,
      "The router serves chat turns only; no routed provider exposes an embedding endpoint through it.",
    );
    return;
  }

  const known = routedModels().some((model) => String(model.slug) === parsed.model);
  if (!known) {
    geminiError(response, 404, `${parsed.model} is not a routed model on this router.`);
    return;
  }

  let body;
  try {
    body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
  } catch {
    geminiError(response, 400, "The request body is not valid JSON.");
    return;
  }

  if (parsed.method === "countTokens") {
    writeJson(response, 200, { totalTokens: estimateGeminiTokens(body) });
    return;
  }

  const stream = parsed.method === "streamGenerateContent";
  if (stream && url.searchParams.get("alt") !== "sse") {
    // Without `alt=sse` the real API answers with a JSON array rather than an
    // event stream. Serving SSE anyway hands the client a body it cannot parse.
    geminiError(response, 400, "streamGenerateContent is served only with alt=sse.");
    return;
  }

  await relayTurn({ response, model: parsed.model, body, stream, responsesUrl, fetchImpl });
}
