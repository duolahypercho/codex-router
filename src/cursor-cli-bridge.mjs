import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installStableFetchTransport } from "./fetch-transport.mjs";
import {
  applyKeepAliveTimeouts,
  readRequestBody,
  writeJson,
} from "./http-utils.mjs";
import { PORTS, STATE_DIR } from "./paths.mjs";
import { cursorAgentPath, cursorCliStatus, validCursorModelId } from "./cursor-cli.mjs";
import {
  assistantDelta,
  buildCursorPrompt,
  createEventReader,
  isResult,
  resultError,
  resultText,
  usageFromResult,
} from "./cursor-cli-turn.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

// setGlobalDispatcher only reaches the process that calls it, and this is its
// own long-lived server: the doctor's reachability probe and anything else
// that fetches from inside it would otherwise keep Node's HTTP/2-capable
// default. Every server entry point in src/ installs this, and
// test/fetch-transport.test.mjs enforces that it stays that way.
installStableFetchTransport();

// A loopback chat-completions endpoint backed by `cursor-agent -p`. The
// registry entry for `cursor-cli` is `keyless` with this address, which is the
// same shape LM Studio and Ollama use: the operator's own software, on this
// machine, serving models they already pay for. Nothing here holds a
// credential -- the Cursor sign-in lives in cursor-agent's own store and is
// only ever read by cursor-agent itself.

// One turn is one process. Cursor's agent is heavier than an inference call
// (it starts a session and talks to Cursor's backend), so an unbounded server
// would answer a burst by forking a few dozen of them and thrashing.
const DEFAULT_CONCURRENCY = 4;
// Long enough for a real agent turn on a large prompt, short enough that a
// wedged child cannot hold a Codex request open forever.
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const MODEL_CACHE_MS = 60_000;

function positiveEnvInteger(name, fallback, environment) {
  const raw = Number(environment[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * The directory cursor-agent runs in.
 *
 * Deliberately an empty directory the router owns, not the caller's repository
 * and not the service's own checkout. A chat-completions request is a prompt,
 * not a work order: everything the model is meant to see was put in the prompt
 * by whoever called, and pointing an agent at a tree it was not asked about is
 * how a "summarize this text" turn ends up reading a private repository. An
 * operator who genuinely wants repository access sets the override.
 */
export function bridgeWorkspace(environment = process.env) {
  const override = environment.MODEL_ROUTER_CURSOR_WORKSPACE;
  const directory = override
    ? path.resolve(override)
    : path.join(STATE_DIR, "cursor-bridge-workspace");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * The argv for one turn.
 *
 * `--mode ask` and `--sandbox enabled` are not configurable and `--force` is
 * never passed. The router hands this process prompt text that arrived over a
 * socket; read-only is the only mode in which that is a safe thing to do, and
 * an operator who wants an editing agent has cursor-agent itself for that.
 */
export function turnArguments(model, { stream = true } = {}) {
  const id = validCursorModelId(model);
  return [
    "--print",
    "--output-format",
    "stream-json",
    ...(stream ? ["--stream-partial-output"] : []),
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    ...(id ? ["--model", id] : []),
  ];
}

function chunkFrame(id, created, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function completionId() {
  // Not security-relevant; it only has to be unique enough to correlate a
  // response with its chunks in a log.
  return `chatcmpl-cursor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openAiError(response, status, message, type = "invalid_request_error") {
  writeJson(response, status, { error: { message, type, param: null, code: null } });
}

class Semaphore {
  #limit;
  #active = 0;
  #waiting = [];

  constructor(limit) {
    this.#limit = limit;
  }

  async acquire() {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise((resolve) => this.#waiting.push(resolve));
    this.#active += 1;
  }

  release() {
    this.#active -= 1;
    const next = this.#waiting.shift();
    if (next) next();
  }
}

/**
 * Run one turn, feeding assistant text to `onDelta` as it arrives.
 *
 * Resolves with the final answer even when nothing streamed: an `assistant`
 * event is not guaranteed for a short turn, but the `result` event always
 * carries the complete text, so it is the authority and the deltas are an
 * optimization on top of it.
 */
export function runCursorTurn({
  binary,
  model,
  prompt,
  stream = true,
  cwd,
  environment = process.env,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  spawnImpl = spawn,
  signal,
  onDelta = () => {},
}) {
  return new Promise((resolve) => {
    const { command, args, options } = spawnableCommand(
      binary,
      turnArguments(model, { stream }),
    );
    const child = spawnImpl(command, args, {
      ...options,
      cwd,
      // NO_COLOR keeps chalk out of stdout even when a parent process has
      // handed this one a TTY; CI is the same signal for the progress spinner.
      env: { ...environment, NO_COLOR: "1", CI: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const reader = createEventReader();
    let streamed = "";
    let final = "";
    let failure;
    let usage;
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      failure = failure || `cursor-agent did not finish within ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);

    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });

    const consume = (event) => {
      const delta = assistantDelta(event);
      if (delta) {
        streamed += delta;
        onDelta(delta);
      }
      if (!isResult(event)) return;
      failure = failure || resultError(event);
      final = resultText(event);
      usage = usageFromResult(event) ?? usage;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const event of reader.push(chunk)) consume(event);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      // Bounded: a child that fails in a loop must not be able to grow the
      // router's heap while the turn is still open.
      if (stderr.length < 8192) stderr += chunk;
    });

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(payload);
    };

    child.on("error", (error) => {
      settle({ ok: false, error: `cursor-agent could not be started: ${error.message}` });
    });

    child.on("close", (code) => {
      for (const event of reader.flush()) consume(event);
      // `result` is the authority; `streamed` is what the caller already saw.
      // They agree in every observed run, and when they do not, the complete
      // text wins over a partial one.
      const text = final || streamed;
      if (failure) return settle({ ok: false, error: failure, streamed, usage });
      if (code !== 0 && !text) {
        return settle({
          ok: false,
          error: `cursor-agent exited ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ""}`,
          streamed,
        });
      }
      settle({ ok: true, text, streamed, usage });
    });

    child.stdin.on("error", () => {
      // EPIPE when the child dies before reading the prompt; `close` reports it.
    });
    child.stdin.end(prompt);
  });
}

async function handleChatCompletion(request, response, context) {
  let payload;
  try {
    payload = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
  } catch (error) {
    return openAiError(response, error?.status === 413 ? 413 : 400, "Request body is not valid JSON.");
  }
  const model = validCursorModelId(payload?.model);
  if (!model) {
    return openAiError(response, 400, `Unknown or unusable model: ${String(payload?.model ?? "")}`);
  }
  const prompt = buildCursorPrompt(payload?.messages);
  if (!prompt.trim()) {
    return openAiError(response, 400, "No prompt content: every message was empty.");
  }
  const binary = cursorAgentPath({ environment: context.environment });
  if (!binary) {
    return openAiError(
      response,
      503,
      "cursor-agent is not installed. Install it with `curl https://cursor.com/install -fsS | bash`.",
      "server_error",
    );
  }

  const stream = payload?.stream === true;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  request.on("aborted", () => controller.abort());

  await context.limiter.acquire();
  try {
    if (!stream) {
      const outcome = await runCursorTurn({
        binary,
        model,
        prompt,
        stream: false,
        cwd: context.workspace,
        environment: context.environment,
        timeoutMs: context.timeoutMs,
        signal: controller.signal,
      });
      if (!outcome.ok) return openAiError(response, 502, outcome.error, "server_error");
      return writeJson(response, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: outcome.text },
            finish_reason: "stop",
          },
        ],
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      });
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(chunkFrame(id, created, model, { role: "assistant" }));
    let emitted = 0;
    const outcome = await runCursorTurn({
      binary,
      model,
      prompt,
      stream: true,
      cwd: context.workspace,
      environment: context.environment,
      timeoutMs: context.timeoutMs,
      signal: controller.signal,
      onDelta: (delta) => {
        emitted += delta.length;
        response.write(chunkFrame(id, created, model, { content: delta }));
      },
    });
    if (!outcome.ok) {
      // The head is already sent, so the failure has to travel inside the
      // stream. A `[DONE]` with no error would read as a successful empty
      // turn, which is the one outcome a caller cannot distinguish from a
      // model that chose to say nothing.
      response.write(
        `data: ${JSON.stringify({ error: { message: outcome.error, type: "server_error", param: null, code: null } })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      return response.end();
    }
    // A turn whose text arrived only in `result` -- short answers routinely do
    // -- still has to reach the caller.
    if (!emitted && outcome.text) {
      response.write(chunkFrame(id, created, model, { content: outcome.text }));
    }
    response.write(chunkFrame(id, created, model, {}, "stop"));
    if (outcome.usage) {
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: outcome.usage })}\n\n`,
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  } finally {
    context.limiter.release();
  }
}

function handleModels(response, context) {
  const now = Date.now();
  if (!context.modelCache || now - context.modelCache.at > MODEL_CACHE_MS) {
    const status = cursorCliStatus({ environment: context.environment });
    context.modelCache = { at: now, status };
  }
  const { status } = context.modelCache;
  if (!status.signedIn) {
    return openAiError(response, 503, status.detail, "server_error");
  }
  writeJson(response, 200, {
    object: "list",
    data: status.models.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "cursor",
    })),
  });
}

export function createCursorBridge({ environment = process.env } = {}) {
  const context = {
    environment,
    workspace: bridgeWorkspace(environment),
    timeoutMs: positiveEnvInteger(
      "MODEL_ROUTER_CURSOR_TIMEOUT_MS",
      DEFAULT_TURN_TIMEOUT_MS,
      environment,
    ),
    limiter: new Semaphore(
      positiveEnvInteger("MODEL_ROUTER_CURSOR_CONCURRENCY", DEFAULT_CONCURRENCY, environment),
    ),
    modelCache: undefined,
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const route = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && ["/health", "/v1/health"].includes(route)) {
      return writeJson(response, 200, { ok: true, bridge: "cursor-cli" });
    }
    if (request.method === "GET" && ["/models", "/v1/models"].includes(route)) {
      return handleModels(response, context);
    }
    if (request.method === "POST" && ["/chat/completions", "/v1/chat/completions"].includes(route)) {
      return handleChatCompletion(request, response, context).catch((error) => {
        if (response.headersSent) return response.end();
        openAiError(response, 500, `Bridge failure: ${error.message}`, "server_error");
      });
    }
    openAiError(response, 404, `Unsupported route: ${route}`);
  });
  return applyKeepAliveTimeouts(server);
}

export function startCursorBridge({
  port = PORTS.cursorBridge,
  host = "127.0.0.1",
  environment = process.env,
} = {}) {
  const server = createCursorBridge({ environment });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only, always. This endpoint spawns a local agent process from
    // request content; there is no version of it that should accept a
    // connection from off-box.
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startCursorBridge();
  const { port } = server.address();
  process.stdout.write(`cursor-cli bridge listening on http://127.0.0.1:${port}/v1\n`);
}
