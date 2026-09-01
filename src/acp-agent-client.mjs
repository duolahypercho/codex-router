import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { spawnableCommand } from "./spawnable-command.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;

function protocolError(message, code = "acp_protocol_error") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanError(value) {
  if (value instanceof Error) return value;
  if (value && typeof value === "object") {
    const error = new Error(String(value.message || "The ACP agent returned an error."));
    if (value.code !== undefined) error.code = value.code;
    if (value.data !== undefined) error.data = value.data;
    return error;
  }
  return new Error(String(value || "The ACP agent returned an error."));
}

function textFromUpdate(update) {
  if (update?.sessionUpdate !== "agent_message_chunk") return "";
  return typeof update.content?.text === "string" ? update.content.text : "";
}

function rejectionOption(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const explicit = options.find((option) => /reject|deny/i.test(String(option?.optionId || option?.id || "")));
  return explicit?.optionId || explicit?.id || "reject-once";
}

/**
 * A deliberately small ACP client shared by Cursor Agent and Gemini CLI.
 *
 * It speaks only newline-delimited JSON-RPC over stdio. File-system and
 * terminal capabilities are not advertised, and permission requests are
 * rejected unless the caller supplies an explicit handler. That makes the
 * transport useful before the desktop app grows a human approval surface,
 * without quietly turning a background child into a workspace executor.
 */
export class AcpAgentClient extends EventEmitter {
  constructor({
    binary,
    args,
    cwd,
    authMethod,
    clientName = "codex-router-agent-bridge",
    clientVersion = "0.1.0",
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
    permissionHandler,
    spawnImpl = spawn,
  }) {
    super();
    if (!binary) throw new Error("An ACP agent binary is required.");
    this.binary = binary;
    this.args = Array.isArray(args) ? [...args] : [];
    this.cwd = cwd;
    this.authMethod = authMethod;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.requestTimeoutMs = requestTimeoutMs;
    this.promptTimeoutMs = promptTimeoutMs;
    this.permissionHandler = permissionHandler;
    this.spawnImpl = spawnImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.promptChunks = new Map();
    this.started = false;
    this.closed = false;
  }

  async start({ authenticate = false } = {}) {
    if (this.started) return this.initializeResult;
    if (this.closed) throw protocolError("This ACP client is already closed.", "acp_client_closed");
    const spawnable = spawnableCommand(this.binary, this.args);
    this.child = this.spawnImpl(spawnable.command, spawnable.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...spawnable.options,
    });
    this.started = true;
    this.child.once("error", (error) => this.#failAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.#failAll(protocolError(`The ACP agent stopped with ${detail}.`, "acp_agent_exited"));
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.#receive(line));
    // Drain stderr so a verbose child cannot block on a full pipe. It is not
    // relayed or persisted: an official CLI owns its diagnostics and may put
    // account or workspace details in them.
    this.child.stderr.on("data", () => {});

    this.initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });
    if (authenticate && this.authMethod) {
      await this.request("authenticate", { methodId: this.authMethod });
    }
    return this.initializeResult;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(protocolError("The ACP agent is not running.", "acp_not_running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError(`ACP request ${method} timed out.`, "acp_request_timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async newSession({ cwd = this.cwd || process.cwd(), mcpServers = [] } = {}) {
    await this.start();
    const result = await this.request("session/new", { cwd, mcpServers });
    if (!result?.sessionId) throw protocolError("The ACP agent created no session ID.");
    return result;
  }

  async loadSession(sessionId, { cwd = this.cwd || process.cwd(), mcpServers = [] } = {}) {
    if (!sessionId) throw new Error("An ACP session ID is required.");
    await this.start();
    const result = await this.request("session/load", { sessionId, cwd, mcpServers });
    return { ...result, sessionId: result?.sessionId || sessionId };
  }

  async prompt(sessionId, prompt) {
    if (!sessionId) throw new Error("An ACP session ID is required.");
    const text = String(prompt || "");
    if (!text.trim()) throw new Error("A non-empty prompt is required.");
    await this.start();
    this.promptChunks.set(sessionId, []);
    try {
      const result = await this.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        { timeoutMs: this.promptTimeoutMs },
      );
      return {
        sessionId,
        stopReason: result?.stopReason,
        text: this.promptChunks.get(sessionId)?.join("") || "",
        result,
      };
    } finally {
      this.promptChunks.delete(sessionId);
    }
  }

  async cancel(sessionId) {
    if (!sessionId) throw new Error("An ACP session ID is required.");
    await this.start();
    // ACP defines cancel as a notification. There is no response to wait for.
    this.#write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    return { sessionId, cancelled: true };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    if (this.child?.stdin?.writable) this.child.stdin.end();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
    this.#failAll(protocolError("The ACP client closed.", "acp_client_closed"));
  }

  #write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #respondError(id, code, message) {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async #incomingRequest(message) {
    if (message.method === "session/request_permission") {
      try {
        const outcome = this.permissionHandler
          ? await this.permissionHandler(message.params)
          : { outcome: "selected", optionId: rejectionOption(message.params) };
        this.#respond(message.id, { outcome });
      } catch (error) {
        this.#respondError(message.id, -32603, cleanError(error).message);
      }
      return;
    }
    // Cursor extension methods are blocking. A bridge without a foreground UI
    // cannot honestly answer a question or approve a plan for the user.
    if (message.method === "cursor/ask_question") {
      this.#respond(message.id, { answers: [], cancelled: true });
      return;
    }
    if (message.method === "cursor/create_plan") {
      this.#respond(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.#respondError(message.id, -32601, `Unsupported ACP client method: ${message.method}`);
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocol-warning", { code: "invalid_json" });
      return;
    }
    if (message.id !== undefined && (Object.hasOwn(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(cleanError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      const sessionId = message.params?.sessionId;
      const text = textFromUpdate(message.params?.update);
      if (text && this.promptChunks.has(sessionId)) this.promptChunks.get(sessionId).push(text);
      this.emit("update", message.params);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.#incomingRequest(message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #failAll(reason) {
    const error = cleanError(reason);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("stopped", error);
  }
}
