import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  readSubagentProofs,
  recordProbeResult,
  recordProbeStarted,
} from "./subagent-proofs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Enabling a model as a subagent is the assignment; this module answers
// whether the assignment can hold. Verification is capability research, not
// trust: the probe spends two live requests proving the model streams and
// answers a forced tool call through the installed router, and only that
// evidence — never the toggle itself — advertises the model to Codex as a
// v2 subagent (as "experimental", until a real spawn settles it).

// Which of these slugs need a probe at all. Registry-v2 models shipped with
// the full native proof; slugs already carrying local evidence keep it.
export function subagentVerificationCandidates(slugs, { force = false } = {}) {
  const proofs = readSubagentProofs().proofs;
  const seen = new Set();
  const candidates = [];
  for (const raw of slugs || []) {
    const slug = String(raw || "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const model = MODEL_BY_SLUG.get(slug);
    if (!model) continue;
    if (model.multiAgentVersion === "v2") continue;
    const status = proofs[slug]?.status;
    if (!force && (status === "experimental" || status === "proven" || status === "checking")) {
      continue;
    }
    candidates.push(slug);
  }
  return candidates;
}

export async function verifySubagentCandidates(slugs, { probe, force = false } = {}) {
  const runProbe =
    probe ||
    (await import("./compatibility-test.mjs")).subagentCapabilityProbe;
  const results = [];
  for (const slug of subagentVerificationCandidates(slugs, { force })) {
    recordProbeStarted(slug);
    let outcome;
    try {
      outcome = await runProbe(slug);
    } catch (error) {
      outcome = {
        ok: false,
        checks: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    results.push({
      slug,
      ...recordProbeResult(slug, {
        ok: outcome.ok,
        checks: outcome.checks,
        detail: outcome.detail,
      }),
    });
  }
  return results;
}

// The tray's toggle cannot wait on a live network probe, so control hands the
// candidate list to a detached worker (the same shape as the vision-model
// download worker): state moves to "checking" immediately, the worker records
// the verdict and republishes the catalog when it lands.
export function spawnDetachedVerification(slugs, { execPath = process.execPath } = {}) {
  const candidates = subagentVerificationCandidates(slugs);
  if (candidates.length === 0) return { spawned: false, candidates: [] };
  for (const slug of candidates) recordProbeStarted(slug);
  const child = spawn(
    execPath,
    [path.join(REPO_ROOT, "src", "subagent-verify.mjs"), "--worker", ...candidates],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return { spawned: true, candidates };
}

function refreshCatalog() {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "catalog.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
    stdio: "ignore",
  });
  return result.status === 0;
}

async function workerMain(slugs) {
  // The parent already marked these "checking"; force re-runs them past that.
  await verifySubagentCandidates(slugs, { force: true });
  // Publish whatever the verdicts imply. A failed refresh leaves the proofs
  // recorded; the next control mutation republishes them.
  refreshCatalog();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    workerMain(args.slice(1)).catch(() => {
      process.exit(1);
    });
  }
}
