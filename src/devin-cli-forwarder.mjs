import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  applyKeepAliveTimeouts,
  endStreamedResponse,
  httpErrorStatus,
  installGracefulShutdown,
  readRequestBody,
  reportListenFailure,
  requireInternalAuth,
  writeEventStreamHead,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";
import { devinCliStatus } from "./devin-cli-status.mjs";
import { readDevinSession } from "./devin-cli-session.mjs";
import { connectServerStream, connectUnary } from "./devin-connect.mjs";
import { isKnownConnectCode } from "./connect-stream-audit.mjs";
import {
  GET_CLI_MODEL_CONFIGS,
  GET_CLI_MODEL_CONFIGS_REQUEST,
  GET_CLI_MODEL_CONFIGS_RESPONSE,
  GET_CHAT_MESSAGE,
  GET_CHAT_MESSAGE_REQUEST,
  GET_CHAT_MESSAGE_RESPONSE,
  SERVICE_PATH,
} from "./devin-proto.mjs";
import { buildChatMessageRequest, finishReasonFor, usageFrom } from "./devin-cli-turn.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";

installStableFetchTransport();

// LiteLLM speaks OpenAI Chat Completions to this forwarder. It reuses the
// official Devin CLI session and translates to Cascade's Connect RPC, which is
// the only interface Cognition's models answer on.

const LISTEN_HOST = process.env.MODEL_ROUTER_DEVIN_CLI_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.MODEL_ROUTER_DEVIN_CLI_PORT || PORTS.devinCli);
const INTERNAL_KEY = process.env.MODEL_ROUTER_INTERNAL_KEY;
const QUIET = process.env.MODEL_ROUTER_QUIET === "1";

function baseUrlFor(session) {
  return process.env.DEVIN_CASCADE_BASE_URL || session.apiServerUrl;
}

function safeErrorCode(error) {
  const code = error?.code;
  if (code === "devin_compressed_frame") return code;
  if (typeof code !== "string" || code.length > 64 || !code.startsWith("devin_")) return null;
  const connectCode = code.slice("devin_".length);
  return isKnownConnectCode(connectCode) ? `devin_${connectCode.toLowerCase()}` : null;
}

function permissionDeniedBillingKind(detail) {
  // These are the two wrappers authored by devin-connect.mjs. Strip one only;
  // quoted/suffix prompt or tool text must never become a billing diagnosis.
  const prefix = [
    "Devin upstream refused the request: ",
    "Devin upstream ended the stream: ",
  ].find((value) => detail.startsWith(value));
  const offset = prefix?.length || 0;
  const diagnostic = detail.slice(offset, offset + 256).trimStart();
  // This provider has no verified structured billing subcode. Recognize only
  // the bounded initial account-limit sentences the fixture actually proves;
  // every ambiguous permission refusal retains permission_error.
  if (/^Your quota is exhausted\.(?:\s|$)/i.test(diagnostic)) return "out_of_usage";
  if (/^Your plan does not include this API\.(?:\s|$)/i.test(diagnostic)) return "entitlement";
  return undefined;
}

function requestFailure(error) {
  const status = httpErrorStatus(error, 502);
  const code = safeErrorCode(error);
  let message = "The Devin CLI forwarder could not complete the request.";
  let type = "api_error";
  if (status === 401) {
    message = "Devin rejected the CLI session; run `devin auth login`.";
    type = "authentication_error";
  } else if (status === 403 && code === "devin_permission_denied") {
    // Error prose can echo tokens, URLs, prompts and tool descriptions. Keep
    // only an owned diagnosis, whose prefix survives LiteLLM's error wrappers.
    const detail = typeof error?.message === "string" ? error.message : "";
    const prefix = "Devin refused this request (devin_permission_denied):";
    type = "permission_error";
    if (/\bMCP\s+configuration\b/i.test(detail)) {
      message = `${prefix} the upstream reported an MCP configuration issue.`;
    } else if (/\bcontent[\s_-]+policy\b/i.test(detail)) {
      message = `${prefix} the upstream reported a content policy refusal.`;
    } else {
      // Preserve a proved initial account-limit diagnosis. Arbitrary prose
      // can echo a denied prompt, and its quota wording must not cause failover.
      const kind = permissionDeniedBillingKind(detail);
      if (kind === "entitlement") {
        message = "This Devin plan does not include this API.";
        type = "billing_error";
      } else if (kind === "out_of_usage") {
        message = "Devin reports that its quota is exhausted.";
        type = "billing_error";
      } else {
        message = `${prefix} check the account permissions and team or tool configuration.`;
      }
    }
  }
  return { status, error: { message, type, code } };
}

function logRequestFailure(failure) {
  // Only allowlisted codes: even an upstream code can contain prompt text or
  // credentials. Never log the original error, message, body or cause chain.
  console.error(`[devin-cli] request failed: status=${failure.status} code=${failure.error.code || "unknown"}`);
}

const chunk = (id, created, model, delta, finishReason = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

// Cascade streams whole tool calls rather than argument fragments, so a call
// arriving twice is the same call restated. Indexing by id keeps the OpenAI
// `tool_calls[].index` stable across restatements instead of emitting a second
// call the client would dispatch twice.
class ToolCallStream {
  constructor() {
    this.byId = new Map();
    this.collected = [];
  }

  accept(call) {
    const id = call.id || `call_${randomUUID()}`;
    const existing = this.byId.get(id);
    const entry = {
      id,
      type: "function",
      function: { name: call.name || existing?.function.name || "", arguments: call.argumentsJson || "" },
    };
    if (existing) {
      const index = this.collected.findIndex((held) => held.id === id);
      this.collected[index] = entry;
      this.byId.set(id, entry);
      return { index, entry, restated: true };
    }
    const index = this.collected.length;
    this.collected.push(entry);
    this.byId.set(id, entry);
    return { index, entry, restated: false };
  }
}

async function handleChatCompletions(request, response) {
  const chat = JSON.parse((await readRequestBody(request)).toString("utf8"));
  const wantsStream = chat.stream === true;
  const model = typeof chat.model === "string" ? chat.model : "";

  let session;
  try {
    session = readDevinSession();
  } catch {
    writeJson(response, 401, {
      error: {
        message: "The Devin CLI session is unavailable; run `devin auth login`.",
        type: "authentication_error",
        code: null,
      },
    });
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  const upstream = connectServerStream({
    baseUrl: baseUrlFor(session),
    service: SERVICE_PATH,
    method: GET_CHAT_MESSAGE,
    token: session.apiKey,
    requestSchema: GET_CHAT_MESSAGE_REQUEST,
    responseSchema: GET_CHAT_MESSAGE_RESPONSE,
    message: buildChatMessageRequest(chat, { token: session.apiKey, modelUid: model }),
    signal: controller.signal,
  });

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  const toolCalls = new ToolCallStream();
  let contentText = "";
  let reasoningText = "";
  let stopReason;
  let usage;
  let headersWritten = false;

  const openStream = () => {
    if (headersWritten || !wantsStream) return;
    headersWritten = true;
    writeEventStreamHead(response, 200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(chunk(id, created, model, { role: "assistant", content: "" }));
  };

  try {
    for await (const message of upstream) {
      openStream();
      if (message.deltaThinking) {
        reasoningText += message.deltaThinking;
        if (wantsStream) {
          response.write(chunk(id, created, model, { reasoning_content: message.deltaThinking }));
        }
      }
      if (message.deltaText) {
        contentText += message.deltaText;
        if (wantsStream) response.write(chunk(id, created, model, { content: message.deltaText }));
      }
      for (const call of message.deltaToolCalls || []) {
        const { index, entry, restated } = toolCalls.accept(call);
        if (!wantsStream) continue;
        response.write(
          chunk(id, created, model, {
            tool_calls: [
              restated
                ? { index, function: { arguments: entry.function.arguments } }
                : { index, id: entry.id, type: "function", function: { ...entry.function } },
            ],
          }),
        );
      }
      if (message.usage) usage = usageFrom(message.usage);
      if (message.stopReason !== undefined) stopReason = message.stopReason;
    }
  } catch (error) {
    const failure = requestFailure(error);
    logRequestFailure(failure);
    if (!headersWritten) {
      writeJson(response, failure.status, { error: failure.error });
      return;
    }
    // The turn already relayed bytes, so an ordinary [DONE] would certify a
    // partial message as complete. Report the failure in-band, then end the
    // HTTP body cleanly instead of resetting the socket.
    endStreamedResponse(response, {
      message: failure.error.message,
    });
    return;
  }

  const finishReason = finishReasonFor(stopReason, toolCalls.collected.length > 0);

  if (wantsStream) {
    openStream();
    response.write(chunk(id, created, model, {}, finishReason));
    if (usage) {
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  } else {
    const message = { role: "assistant", content: contentText || null };
    if (reasoningText) message.reasoning_content = reasoningText;
    if (toolCalls.collected.length) message.tool_calls = toolCalls.collected;
    writeJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });
  }

  if (!QUIET) console.error(`[devin-cli] model=${model} finish=${finishReason}`);
}

// Discovery asks the account which models it may spend. The answer is the
// operator's entitlement, not a checked-in list, so `bin/curate-models` reads
// it live rather than the registry shipping a guess.
export async function listCascadeModels({ session = readDevinSession(), signal } = {}) {
  const response = await connectUnary({
    baseUrl: baseUrlFor(session),
    service: SERVICE_PATH,
    method: GET_CLI_MODEL_CONFIGS,
    token: session.apiKey,
    requestSchema: GET_CLI_MODEL_CONFIGS_REQUEST,
    responseSchema: GET_CLI_MODEL_CONFIGS_RESPONSE,
    message: { metadata: { apiKey: session.apiKey, ideName: "windsurf", locale: "en" } },
    signal,
  });
  return (response.clientModelConfigs || [])
    .filter((config) => config.modelUid && !config.disabled)
    .map((config) => ({
      id: config.modelUid,
      label: config.label || config.modelUid,
      description: config.description || "",
      maxTokens: config.maxTokens || undefined,
      supportsImages: Boolean(config.supportsImages),
      premium: Boolean(config.isPremium),
      beta: Boolean(config.isBeta),
    }));
}

async function handleModels(response) {
  const models = await listCascadeModels();
  writeJson(response, 200, {
    object: "list",
    data: models.map((model) => ({ id: model.id, object: "model", owned_by: "devin" })),
  });
}

async function handleRequest(request, response) {
  if (!INTERNAL_KEY) {
    writeJson(response, 500, {
      error: { type: "api_error", message: "MODEL_ROUTER_INTERNAL_KEY is required." },
    });
    return;
  }
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || LISTEN_HOST}`);
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "codex-router-devin-cli-forwarder",
      credential_present: devinCliStatus().configured,
    });
    return;
  }
  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "POST" && route === "/chat/completions") {
    await handleChatCompletions(request, response);
    return;
  }
  if (request.method === "GET" && route === "/models") {
    await handleModels(response);
    return;
  }
  writeJson(response, 404, {
    error: { type: "proxy_route_not_found", message: "Unsupported Devin CLI route." },
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (!INTERNAL_KEY) throw new Error("MODEL_ROUTER_INTERNAL_KEY is required.");
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const failure = requestFailure(error);
      logRequestFailure(failure);
      if (!response.headersSent) {
        writeJson(response, failure.status, { error: failure.error });
      } else if (!response.writableEnded) {
        endStreamedResponse(response, {
          message: failure.error.message,
        });
      }
    });
  });

  applyKeepAliveTimeouts(server);
  reportListenFailure(server, { label: "devin-cli", host: LISTEN_HOST, port: LISTEN_PORT });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.error("[devin-cli] listening");
  });

  installGracefulShutdown(server, { label: "devin-cli" });
}
