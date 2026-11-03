import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// Machine-local diagnostic history. These records never authorize subagent
// capabilities: the registry and explicit operator selection own that decision.
// Keep historical outcomes to avoid erasing evidence or repeating paid probes.
export const SUBAGENT_PROOFS_PATH =
  process.env.MODEL_ROUTER_SUBAGENT_PROOFS ||
  path.join(STATE_DIR, "multi-agent-proofs.json");

const KNOWN_STATUSES = new Set([
  "checking",
  "candidate",
  "experimental",
  "proven",
  "failed",
  "verified", // Historical records are retained as diagnostics, never authority.
]);

// An unreadable file supplies no diagnostics and changes no capabilities.
export function readSubagentProofs(filePath = SUBAGENT_PROOFS_PATH) {
  if (!existsSync(filePath)) return { version: 1, proofs: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.proofs && typeof parsed.proofs === "object") {
      const proofs = {};
      for (const [slug, proof] of Object.entries(parsed.proofs)) {
        if (proof && typeof proof === "object" && KNOWN_STATUSES.has(proof.status)) {
          proofs[slug] = proof;
        }
      }
      return { version: 1, proofs };
    }
  } catch {
    // Fall through to the empty diagnostic snapshot.
  }
  return { version: 1, proofs: {} };
}

function writeProofs(state, filePath = SUBAGENT_PROOFS_PATH) {
  writePrivateJson(filePath, state, { directoryMode: 0o700 });
}

function updateProof(slug, update, filePath = SUBAGENT_PROOFS_PATH) {
  const state = readSubagentProofs(filePath);
  const key = String(slug);
  const next = {
    version: 1,
    proofs: { ...state.proofs, [key]: { ...state.proofs[key], ...update } },
  };
  writeProofs(next, filePath);
  return next.proofs[key];
}

export function recordProbeStarted(slug, { at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "checking", startedAt: at });
}

export function recordProbeResult(slug, { ok, checks, detail, at = new Date().toISOString() }) {
  if (ok) {
    return updateProof(slug, {
      status: "candidate",
      toolProbe: { ok: true, checks, at },
      reason: undefined,
    });
  }
  return updateProof(slug, {
    status: "failed",
    toolProbe: { ok: false, checks, at },
    reason: detail || "compatibility probe failed",
  });
}

export function recordSpawnObserved(slug, { status, at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "proven", spawn: { ok: true, status, at } });
}

// `turns` and `newInputTokens` are carried so the recorded evidence says how
// much of a spawn it took, not just that one failed: the proofs snapshot is
// what `control subagents verify`, `control subagents status` and the tray
// render, so this is where negative diagnostic evidence becomes readable.
export function recordSpawnFailure(
  slug,
  { status, reason, turns, newInputTokens, at = new Date().toISOString() } = {},
) {
  return updateProof(slug, {
    status: "failed",
    spawn: {
      ok: false,
      status,
      at,
      ...(Number.isInteger(turns) && turns > 0 ? { turns } : {}),
      ...(Number.isInteger(newInputTokens) && newInputTokens > 0
        ? { newInputTokens }
        : {}),
    },
    reason: reason || `spawn failed with HTTP ${status}`,
  });
}

export function clearSubagentProof(slug, filePath = SUBAGENT_PROOFS_PATH) {
  const state = readSubagentProofs(filePath);
  if (!(String(slug) in state.proofs)) return;
  const proofs = { ...state.proofs };
  delete proofs[String(slug)];
  writeProofs({ version: 1, proofs }, filePath);
}

export function subagentProofSnapshot(filePath = SUBAGENT_PROOFS_PATH) {
  return readSubagentProofs(filePath).proofs;
}

// Legacy helper retained only to refine an historical experimental record from
// child traffic. New candidate records never reach Codex's v2 catalog.
export function awaitingSpawnProof(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}

// Whether child traffic may refine a legacy experimental diagnostic. This can
// change only the local record; it cannot demote or promote registry authority.
export function spawnProofRevocable(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}
