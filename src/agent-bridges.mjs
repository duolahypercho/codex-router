import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { AcpAgentClient } from "./acp-agent-client.mjs";
import { agentBridgeSessions, recordAgentBridgeSession } from "./agent-bridge-state.mjs";
import { ClaudeAgentBridge, validateClaudePromptControls } from "./claude-agent-bridge.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

export const AGENT_BRIDGE_IDS = Object.freeze(["anthropic", "cursor", "gemini"]);

export function agentBridgeDefinitions(
  env = process.env,
  { commandResolver = commandOnPath } = {},
) {
  const claude = env.MODEL_ROUTER_CLAUDE_BIN || commandResolver("claude");
  const cursor = env.MODEL_ROUTER_CURSOR_AGENT_BIN || commandResolver("agent") || commandResolver("cursor-agent");
  const gemini = env.MODEL_ROUTER_GEMINI_BIN || commandResolver("gemini");
  return [
    {
      id: "anthropic",
      displayName: "Claude",
      protocol: "claude-code",
      binary: claude,
      loginCommand: claude ? [claude, "auth", "login"] : undefined,
      installed: Boolean(claude),
    },
    {
      id: "cursor",
      displayName: "Cursor Agent",
      protocol: "acp",
      binary: cursor,
      args: ["acp"],
      authMethod: "cursor_login",
      loginCommand: cursor ? [cursor, "login"] : undefined,
      installed: Boolean(cursor),
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      protocol: "acp",
      binary: gemini,
      args: ["--acp"],
      loginCommand: gemini ? [gemini] : undefined,
      installed: Boolean(gemini),
    },
  ];
}

export function agentBridgeStatus(env = process.env, options = {}) {
  return {
    version: 1,
    bridges: agentBridgeDefinitions(env, options).map((bridge) => ({
      id: bridge.id,
      displayName: bridge.displayName,
      protocol: bridge.protocol,
      installed: bridge.installed,
      sessions: agentBridgeSessions(bridge.id).length,
      // Deliberately do not infer authentication from another client's files.
      // A successful handshake/prompt is the only reliable proof.
      authentication: bridge.installed ? "client-owned" : "unavailable",
    })),
  };
}

export function createAgentBridge(id, { cwd, env = process.env, spawnImpl } = {}) {
  const definition = agentBridgeDefinitions(env).find((bridge) => bridge.id === id);
  if (!definition) throw new Error(`Unknown agent bridge: ${id}`);
  if (!definition.binary) {
    throw new Error(`${definition.displayName} is not installed or is not on PATH.`);
  }
  if (id === "anthropic") {
    return new ClaudeAgentBridge({ binary: definition.binary, cwd, spawnImpl });
  }
  return new AcpAgentClient({
    binary: definition.binary,
    args: definition.args,
    authMethod: definition.authMethod,
    cwd,
    spawnImpl,
  });
}

export async function probeAgentBridge(id, options = {}) {
  const definition = agentBridgeDefinitions(options.env || process.env).find((bridge) => bridge.id === id);
  if (!definition?.binary) throw new Error(`${definition?.displayName || id} is not installed or is not on PATH.`);
  if (id === "anthropic") {
    const spawnable = spawnableCommand(definition.binary, ["auth", "status", "--json"]);
    const checked = (options.spawnSyncImpl || spawnSync)(spawnable.command, spawnable.args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      ...spawnable.options,
    });
    let status;
    try {
      status = JSON.parse(checked.stdout || "{}");
    } catch {
      status = {};
    }
    if (checked.status !== 0 || status.loggedIn !== true) {
      throw new Error("Claude Code is installed but signed out. Run `claude auth login` and retry.");
    }
    // Do not return the email, organization ID/name, or any other account
    // fields printed by the official status command.
    return {
      id,
      installed: true,
      protocol: "claude-code",
      login: "ok",
      capability: "unverified",
      authentication: status.authMethod === "claude.ai" ? "claude.ai" : "configured",
      ...(typeof status.subscriptionType === "string" ? { subscription: status.subscriptionType } : {}),
    };
  }
  if (id === "cursor") {
    const spawnable = spawnableCommand(definition.binary, ["status", "--format", "json"]);
    const checked = (options.spawnSyncImpl || spawnSync)(spawnable.command, spawnable.args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      ...spawnable.options,
    });
    let status;
    try {
      status = JSON.parse(checked.stdout || "{}");
    } catch {
      status = {};
    }
    if (checked.status !== 0 || status.isAuthenticated !== true) {
      throw new Error("Cursor Agent is installed but signed out. Run `agent login` and retry.");
    }
  }
  const bridge = createAgentBridge(id, options);
  try {
    const initialize = await bridge.start();
    return {
      id,
      installed: true,
      protocol: "acp",
      handshake: "ok",
      authentication: id === "cursor" ? "cursor_login" : "client-owned",
      initialize,
    };
  } finally {
    await bridge.close();
  }
}

export async function promptAgentBridge(id, {
  prompt, cwd = process.cwd(), sessionId, model, effort, bridgeFactory = createAgentBridge,
} = {}) {
  if (id === "anthropic") validateClaudePromptControls({ model, effort });
  else if (model !== undefined || effort !== undefined) {
    throw new Error("Model and effort controls are only available for the Claude bridge.");
  }
  const bridge = bridgeFactory(id, { cwd });
  let session;
  try {
    if (sessionId) session = await bridge.loadSession(sessionId, { cwd });
    else session = await bridge.newSession({ cwd });
    const result = id === "anthropic"
      ? await bridge.prompt(session.sessionId, prompt, {
        cwd, resume: Boolean(sessionId),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      })
      : await bridge.prompt(session.sessionId, prompt);
    recordAgentBridgeSession({ id: result.sessionId || session.sessionId, bridge: id, cwd });
    return result;
  } finally {
    await bridge.close();
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function usage() {
  return [
    "Usage: agent-bridges status|sessions [BRIDGE]|probe BRIDGE|prompt BRIDGE [--session ID] [--cwd PATH] [--model MODEL] [--effort LEVEL]",
    "",
    "Prompt text is read from stdin so it never appears in the process list.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const [command, id, ...rest] = argv;
  if (command === "status") return agentBridgeStatus();
  if (command === "sessions") return { version: 1, sessions: agentBridgeSessions(id) };
  if (command === "probe" && AGENT_BRIDGE_IDS.includes(id)) return await probeAgentBridge(id);
  if (command === "prompt" && AGENT_BRIDGE_IDS.includes(id)) {
    let sessionId;
    let cwd = process.cwd();
    let model;
    let effort;
    for (let index = 0; index < rest.length; index += 1) {
      const option = rest[index];
      if (!["--session", "--cwd", "--model", "--effort"].includes(option)) {
        throw new Error(`Unknown prompt option: ${option}`);
      }
      const value = rest[++index];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${option}.`);
      if (option === "--session") sessionId = value;
      else if (option === "--cwd") cwd = value;
      else if (option === "--model") model = value;
      else effort = value;
    }
    if (id === "anthropic") validateClaudePromptControls({ model, effort });
    else if (model !== undefined || effort !== undefined) {
      throw new Error("Model and effort controls are only available for the Claude bridge.");
    }
    return await promptAgentBridge(id, { prompt: await readStdin(), cwd, sessionId, model, effort });
  }
  throw Object.assign(new Error(usage()), { exitCode: 2 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = error?.exitCode || 1;
    },
  );
}
