import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const AGENT_BRIDGE_STATE_PATH = process.env.MODEL_ROUTER_AGENT_BRIDGE_STATE ||
  path.join(STATE_DIR, "agent-bridge-sessions.json");

function emptyState() {
  return { version: 1, sessions: [] };
}

export function readAgentBridgeState() {
  if (!existsSync(AGENT_BRIDGE_STATE_PATH)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(AGENT_BRIDGE_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.sessions)) {
      return {
        version: 1,
        sessions: parsed.sessions.filter((session) =>
          session && typeof session.id === "string" && typeof session.bridge === "string"),
      };
    }
  } catch {
    // A corrupt optional index must disable session discovery, not the router.
  }
  return emptyState();
}

export function recordAgentBridgeSession(session) {
  const current = readAgentBridgeState();
  const now = new Date().toISOString();
  const clean = {
    id: String(session.id),
    bridge: String(session.bridge),
    cwd: String(session.cwd || process.cwd()),
    createdAt: String(session.createdAt || now),
    updatedAt: now,
  };
  const sessions = current.sessions.filter((entry) =>
    !(entry.id === clean.id && entry.bridge === clean.bridge));
  sessions.unshift(clean);
  const next = { version: 1, sessions: sessions.slice(0, 500) };
  writePrivateJson(AGENT_BRIDGE_STATE_PATH, next, { directoryMode: 0o700 });
  return clean;
}

export function agentBridgeSessions(bridge) {
  return readAgentBridgeState().sessions.filter((session) => !bridge || session.bridge === bridge);
}
