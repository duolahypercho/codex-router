import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { spawnableCommand } from "./spawnable-command.mjs";

const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;

function assistantText(event) {
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) return "";
  return event.message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function boundedFailure(value) {
  return String(value || "Claude Code rejected the agent request.")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Claude Code's supported print/SDK transport. Authentication stays entirely
 * inside the official CLI; the bridge supplies no API key and never reads the
 * Claude credential store. Tools are disabled until the desktop app can relay
 * explicit permission decisions.
 */
export class ClaudeAgentBridge {
  constructor({ binary = "claude", cwd, spawnImpl = spawn, promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS } = {}) {
    this.binary = binary;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.promptTimeoutMs = promptTimeoutMs;
    this.active = new Map();
  }

  async newSession({ cwd = this.cwd || process.cwd() } = {}) {
    return { sessionId: randomUUID(), cwd };
  }

  async loadSession(sessionId, { cwd = this.cwd || process.cwd() } = {}) {
    if (!sessionId) throw new Error("A Claude session ID is required.");
    return { sessionId, cwd };
  }

  async prompt(sessionId, prompt, { cwd = this.cwd || process.cwd(), resume = false } = {}) {
    if (!sessionId) throw new Error("A Claude session ID is required.");
    const text = String(prompt || "");
    if (!text.trim()) throw new Error("A non-empty prompt is required.");
    if (this.active.has(sessionId)) throw new Error("That Claude session already has an active prompt.");
    const args = [
      "-p",
      "--input-format", "text",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "dontAsk",
      "--tools", "",
      ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ];
    const spawnable = spawnableCommand(this.binary, args);
    const child = this.spawnImpl(spawnable.command, spawnable.args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...spawnable.options,
    });
    this.active.set(sessionId, child);
    // Send the prompt through stdin so it is not exposed in the process list.
    child.stdin.end(text);
    child.stderr.on("data", () => {});

    return await new Promise((resolve, reject) => {
      const chunks = [];
      let resultText = "";
      let resultEvent;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(sessionId);
        lines.close();
        if (error) reject(error);
        else resolve({
          sessionId: resultEvent?.session_id || sessionId,
          stopReason: resultEvent?.subtype || "completed",
          text: resultText || chunks.join(""),
          result: resultEvent,
        });
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        const error = new Error("The Claude agent prompt timed out.");
        error.code = "claude_prompt_timeout";
        finish(error);
      }, this.promptTimeoutMs);
      timer.unref?.();
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const delta = assistantText(event);
        if (delta) chunks.push(delta);
        if (event?.type === "result") {
          resultEvent = event;
          if (typeof event.result === "string") resultText = event.result;
        }
      });
      child.once("error", finish);
      child.once("exit", (code, signal) => {
        if (code === 0 && resultEvent && !resultEvent.is_error && !resultEvent.api_error_status) finish();
        else {
          const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
          const rejected = resultEvent && (resultEvent.is_error || resultEvent.api_error_status);
          const error = rejected
            ? new Error(`Claude Code rejected the agent bridge: ${boundedFailure(resultEvent.result)}`)
            : new Error(`Claude Code stopped with ${detail}. Check \`claude auth status\` and retry.`);
          error.code = rejected ? "claude_agent_rejected" : "claude_agent_exited";
          if (Number.isInteger(resultEvent?.api_error_status)) error.status = resultEvent.api_error_status;
          finish(error);
        }
      });
    });
  }

  async cancel(sessionId) {
    const child = this.active.get(sessionId);
    if (!child) return { sessionId, cancelled: false };
    child.kill("SIGTERM");
    return { sessionId, cancelled: true };
  }

  async close() {
    for (const child of this.active.values()) child.kill("SIGTERM");
    this.active.clear();
  }
}
