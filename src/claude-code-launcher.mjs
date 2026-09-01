import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, claudeBaseUrl } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  CLAUDE_CATALOG_PATH,
  CLAUDE_SETTINGS_PATH,
  PORTS,
} from "./paths.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

function readJson(target) {
  if (!existsSync(target)) return undefined;
  try { return JSON.parse(readFileSync(target, "utf8")); } catch { return undefined; }
}

function explicitModel(args) {
  return args.some((value, index) => value === "--model" || value.startsWith("--model=") ||
    (index > 0 && args[index - 1] === "--model"));
}

export function claudeRouterEnvironment({
  environment = process.env,
  args = [],
  secret,
  catalog = readJson(CLAUDE_CATALOG_PATH),
  settings = readJson(CLAUDE_SETTINGS_PATH),
} = {}) {
  const env = {
    ...environment,
    ANTHROPIC_BASE_URL: claudeBaseUrl(PORTS.router, secret),
    ANTHROPIC_AUTH_TOKEN: secret,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Routed model ids are intentionally gateway-owned rather than names from
    // Claude Code's built-in Anthropic catalog. Let the gateway report their
    // real limits instead of imposing Claude Code's unknown-model 200k cap.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    // Claude Code's attribution header changes the system prompt. A gateway
    // that translates protocols must opt out so provider prompt caching and
    // the router's request transforms see stable instructions.
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    // Deferred tool loading emits Anthropic-only tool_reference blocks. Keep
    // the ordinary concrete schemas until the canonical Responses path has a
    // proven representation for that beta feature.
    ENABLE_TOOL_SEARCH: "false",
  };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  delete env.CLAUDE_CODE_USE_MANTLE;

  const saved = typeof settings?.model === "string" ? settings.model : "";
  if (!explicitModel(args) && !saved.startsWith("codex_router/anthropic/") && catalog?.defaultModel) {
    // ANTHROPIC_DEFAULT_MODEL only exists in Claude Code 2.1.236+. The older
    // ANTHROPIC_MODEL works on supported versions and is still overridden by
    // an explicit `--model` argument.
    env.ANTHROPIC_MODEL = String(catalog.defaultModel);
  }
  return env;
}

export function launchClaudeCode(args = process.argv.slice(2)) {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The router caller key is missing; run ./bin/model-router claude doctor --fix.");
  }
  if (!existsSync(CLAUDE_CATALOG_PATH)) {
    throw new Error("Claude Code has not been connected; run ./bin/model-router claude enable.");
  }
  const secret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  const command = process.env.CLAUDE_CODE_BIN || (process.platform === "win32" ? "claude.cmd" : "claude");
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    env: claudeRouterEnvironment({ args, secret }),
    stdio: "inherit",
    ...spawnable.options,
  });
  child.once("error", (error) => {
    console.error(`Could not start ${command}: ${error.message}. Install Claude Code first, or set CLAUDE_CODE_BIN.`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { launchClaudeCode(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
