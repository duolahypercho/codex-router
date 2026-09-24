import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routerNodeBinary } from "./node-runtime.mjs";

import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  clearSubagentProof,
  readSubagentProofs,
  recordProbeResult,
  recordProbeStarted,
} from "./subagent-proofs.mjs";
import { detachedOperationEnvironment } from "./process-tree.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Enabling a model as a subagent is the assignment; this module answers
// whether the assignment can hold. Verification is capability research, not
// trust: the probe spends two live requests proving the model streams and
// answers a forced tool call through the installed router. That low-cost
// result becomes certification evidence, not a v2 claim: only a reviewed
// v2_agent application plus registry entry may advertise the native role.

// A probe is two 180-second-capped requests, so any "checking" older than
// this ceiling was left behind by a worker that died — machine sleep, OOM, a
// kill — not one still working. Stale checking is retryable without force,
// which is what makes toggling a wedged model off and on recover it.
export const STALE_CHECKING_MS = 10 * 60_000;

function checkingIsStale(proof, now = Date.now()) {
  const startedAt = Date.parse(proof?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > STALE_CHECKING_MS;
}

// Which of these slugs need a probe at all. Registry-v2 models shipped with
// the full native proof. Explicit registry-v1 models were already reviewed
// and rejected for the native role, so a local probe must never reopen that
// decision; only unknown models are certification candidates.
export function subagentVerificationCandidates(slugs, { force = false, now = Date.now() } = {}) {
  const proofs = readSubagentProofs().proofs;
  const seen = new Set();
  const candidates = [];
  for (const raw of slugs || []) {
    const slug = String(raw || "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const model = MODEL_BY_SLUG.get(slug);
    if (!model) continue;
    if (model.multiAgentVersion === "v2" || model.multiAgentVersion === "v1") continue;
    const status = proofs[slug]?.status;
    if (!force) {
      if (status === "candidate" || status === "experimental" || status === "proven") continue;
      if (status === "checking" && !checkingIsStale(proofs[slug], now)) continue;
    }
    candidates.push(slug);
  }
  return candidates;
}

// The probe measures capability, and these statuses answer about the account
// or the moment, never about the model: rate limits, exhausted quota, and
// outages (402/408/429/5xx) clear on their own; missing credentials and plan
// entitlements (401/403) clear when the operator upgrades — a Command Code Go
// plan probing 30 models recorded 30 "incapable" verdicts when the truth was
// one un-entitled account. "failed" is reserved for evidence the model cannot
// hold the role; everything here clears the slot instead, so the next toggle
// or sweep simply researches again — the same distinction the request-path
// observer draws between a 400 and a 429.
const PROBE_STATUSES_ABOUT_THE_ACCOUNT = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

function probeAnsweredAboutTheAccount(outcome) {
  const failing = (outcome.checks || []).filter((check) => !check.ok);
  if (!failing.length) return false;
  return failing.every((check) => PROBE_STATUSES_ABOUT_THE_ACCOUNT.has(check.status));
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
      // A probe that never got an answer — router restarting, DNS, socket
      // refused — proved nothing about the model. Mark it unreachable so the
      // classifier below defers it rather than condemning it.
      outcome = {
        ok: false,
        unreachable: true,
        checks: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!outcome.ok && (outcome.unreachable || probeAnsweredAboutTheAccount(outcome))) {
      clearSubagentProof(slug);
      results.push({ slug, status: "deferred", reason: outcome.detail });
      continue;
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
export function spawnDetachedVerification(
  slugs,
  { execPath = routerNodeBinary(), deferCandidateResolution = false } = {},
) {
  // A curation transaction has just written a new model overlay, but this
  // process still holds the old registry module. Let the fresh worker resolve
  // those slugs after the overlay publication instead of silently dropping
  // them as "unknown" here.
  const candidates = deferCandidateResolution
    ? [...new Set((slugs || []).map((slug) => String(slug || "").trim()).filter(Boolean))]
    : subagentVerificationCandidates(slugs);
  if (candidates.length === 0) return { spawned: false, candidates: [] };
  if (!deferCandidateResolution) {
    for (const slug of candidates) recordProbeStarted(slug);
  }
  const child = spawn(
    execPath,
    [path.join(REPO_ROOT, "src", "subagent-verify.mjs"), "--worker", ...candidates],
    {
      cwd: REPO_ROOT,
      env: detachedOperationEnvironment(process.env, { MODEL_ROUTER_TARGET: "codex" }),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return { spawned: true, candidates };
}

function refreshCatalog() {
  const result = spawnSync(routerNodeBinary(), [path.join(REPO_ROOT, "src", "catalog.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
    stdio: "ignore",
  });
  return result.status === 0;
}

async function workerMain(slugs) {
  try {
    // The parent already marked these "checking"; force re-runs them past that.
    await verifySubagentCandidates(slugs, { force: true });
  } finally {
    // A worker that dies before a verdict must not strand its slugs: anything
    // still "checking" here failed to get an answer, and "failed" with a
    // reason is recoverable where a silent wedge is not. (A hard kill writes
    // nothing — the staleness ceiling above is that case's backstop.)
    const proofs = readSubagentProofs().proofs;
    for (const slug of slugs) {
      if (proofs[String(slug)]?.status === "checking") {
        recordProbeResult(slug, {
          ok: false,
          checks: [],
          detail: "the probe worker exited before a verdict; switch the model off and on to retry",
        });
      }
    }
    // Publish whatever the verdicts imply. A failed refresh leaves the proofs
    // recorded; the next control mutation republishes them.
    refreshCatalog();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    workerMain(args.slice(1)).catch(() => {
      process.exit(1);
    });
  }
}
