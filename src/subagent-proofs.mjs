import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// Machine-local subagent capability proofs.
//
// The registry's `multiAgentVersion: "v2"` marks models proven through the
// full native collaboration probe and shipped to every installer. This file
// holds the other kind of evidence: proofs collected on *this* machine, for
// models the operator enabled as subagents that the registry has not promoted.
// Local settings still never manufacture a v2 claim — the only writers here
// are the verifier (a live tool/stream probe) and the router's own
// observation of a real spawn succeeding or failing on the request path.
//
// Lifecycle per slug:
//   checking      the probe worker is running; nothing is advertised yet
//   experimental  the probe passed; the model is advertised to Codex as a v2
//                 subagent, and the first observed spawn settles the verdict
//   proven        the router watched a real child turn complete cleanly
//   failed        the probe failed, or an observed spawn failed structurally;
//                 the model stays v1 and the reason is shown where it was
//                 switched on
export const SUBAGENT_PROOFS_PATH =
  process.env.MODEL_ROUTER_SUBAGENT_PROOFS ||
  path.join(STATE_DIR, "multi-agent-proofs.json");

const PROMOTED_STATUSES = new Set(["experimental", "proven"]);
const KNOWN_STATUSES = new Set(["checking", "experimental", "proven", "failed"]);

// A file that exists but cannot be parsed promotes nothing: somebody's
// evidence was here and we can no longer read it, so the conservative v1
// default applies until the operator re-verifies.
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
    // Fall through to the empty (promote-nothing) state.
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
      status: "experimental",
      toolProbe: { ok: true, checks, at },
      reason: undefined,
    });
  }
  return updateProof(slug, {
    status: "failed",
    toolProbe: { ok: false, checks, at },
    reason: detail || "capability probe failed",
  });
}

export function recordSpawnObserved(slug, { status, at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "proven", spawn: { ok: true, status, at } });
}

export function recordSpawnFailure(slug, { status, reason, at = new Date().toISOString() } = {}) {
  return updateProof(slug, {
    status: "failed",
    spawn: { ok: false, status, at },
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

function promotedSlugs(proofs) {
  return new Set(
    Object.entries(proofs)
      .filter(([, proof]) => PROMOTED_STATUSES.has(proof.status))
      .map(([slug]) => slug),
  );
}

// Promote routed models this machine has verified. Runs after
// applyMultiAgentSettings, whose demotions must win: a slug the operator
// hid or switched off stays v1 whatever evidence exists for it.
export function applySubagentProofs(models, proofs, { hidden, disabled } = {}) {
  const promoted = promotedSlugs(proofs || {});
  if (promoted.size === 0) return models;
  const hiddenSet = hidden instanceof Set ? hidden : new Set(hidden || []);
  const disabledSet = disabled instanceof Set ? disabled : new Set(disabled || []);
  return models.map((model) => {
    const slug = String(model.slug);
    if (model.multiAgentVersion === "v2") return model;
    if (!promoted.has(slug)) return model;
    if (hiddenSet.has(slug) || disabledSet.has(slug)) return model;
    return { ...model, multiAgentVersion: "v2" };
  });
}

// Whether an observed child turn for this slug should settle a verdict:
// only models sitting in the experimental window are listening.
export function awaitingSpawnProof(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}
