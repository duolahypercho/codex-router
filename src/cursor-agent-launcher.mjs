import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, cursorCliBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

function cursorAgentBinary() {
  const configured = process.env.CURSOR_AGENT_BIN;
  if (configured) return configured;
  return process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
}

export function launchCursorAgent(args = process.argv.slice(2)) {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The router caller key is missing; run ./bin/model-router cursor doctor.");
  }
  const secret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  const command = cursorAgentBinary();
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    env: {
      ...process.env,
      // Cursor caches the auth exchange by endpoint and API-key identifier.
      // Version this non-secret marker so an upgrade can recover from a failed
      // exchange cached by an older local adapter.
      CURSOR_API_KEY: "codex-router-local-v3",
      CURSOR_API_ENDPOINT: cursorCliBaseUrl(PORTS.router, secret),
    },
    stdio: "inherit",
    ...spawnable.options,
  });
  child.once("error", (error) => {
    console.error(
      `Could not start ${command}: ${error.message}. Install Cursor Agent first, or set CURSOR_AGENT_BIN.`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    launchCursorAgent();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
