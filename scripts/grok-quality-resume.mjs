// Offline bookkeeping for the bounded Grok quality campaign. Keep resumptions
// conservative: a saved running record cannot prove how far its process got.
export const GROK_QUALITY_SOURCE_FILES = Object.freeze([
  'src/namespace-relay.mjs', 'src/grok-tool-facade.mjs', 'src/grok-structured-patch.mjs',
  'src/grok-oauth-forwarder.mjs', 'src/grok-oauth-turn.mjs', 'src/tool-schema-root.mjs',
  'src/chat-tool-surface.mjs', 'src/codex-app-tools.mjs', 'src/grok-tool-schema.mjs',
  'src/grok-tool-alternatives.mjs',
]);
export const GROK_FINAL_VALIDATION_SOURCE_FILES = Object.freeze([
  'src/grok-oauth-forwarder.mjs', 'src/grok-oauth-turn.mjs', 'src/grok-tool-schema.mjs',
  'src/grok-tool-alternatives.mjs',
]);

function count(value, name, fallback = 0) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid campaign count: ${name}`);
  return value;
}

/** Mutate only unfinished runs, preserving already reconciled historical data.
 * The aggregate unknown-call reserve includes any existing per-run reserves.
 * New reserves cover the entire unrecorded allowance, including a possible call
 * made immediately before a crash, rather than guessing from partial counters.
 */
export function reconcileInterruptedQualityRuns(report, { generationsPerRun }) {
  const allowance = count(generationsPerRun, 'generationsPerRun');
  if (!allowance || !Array.isArray(report.runs) || !Array.isArray(report.providerRequests)) {
    throw new Error('Invalid campaign resume state');
  }
  const recordedByRun = new Map();
  for (const attempt of report.providerRequests) {
    recordedByRun.set(attempt.runId, (recordedByRun.get(attempt.runId) || 0) + 1);
  }
  const existingReserve = run => {
    const explicit = count(run.unaccountedProviderRequestsUpperBound, 'run unaccountedProviderRequestsUpperBound');
    const total = count(run.providerRequestsUpperBound, 'run providerRequestsUpperBound');
    return Math.max(explicit, total - (recordedByRun.get(run.id) || 0), 0);
  };
  const allocatedReserve = report.runs.reduce((sum, run) => sum + existingReserve(run), 0);
  const aggregateReserve = count(report.unaccountedProviderRequestsUpperBound, 'unaccountedProviderRequestsUpperBound');
  if (aggregateReserve > allocatedReserve && report.runs.some(run => run.status === 'running' &&
      allowance - (recordedByRun.get(run.id) || 0) > existingReserve(run))) {
    // An unattributed aggregate might already cover this running record, or a
    // different interrupted run. Neither reusing it nor adding it again is a
    // sound reconstruction. Require explicit attribution before any mutation.
    throw new Error('Ambiguous campaign unknown-call reserve: attribute the existing reserve to its run before resuming.');
  }
  let reserve = Math.max(aggregateReserve, allocatedReserve);
  let reconciledRuns = 0;
  for (const run of report.runs) {
    if (run.status !== 'running') continue;
    const recorded = recordedByRun.get(run.id) || 0;
    const priorReserve = existingReserve(run);
    const requiredReserve = Math.max(priorReserve, allowance - recorded, 0);
    reserve += requiredReserve - priorReserve;
    run.status = 'interrupted';
    run.success = false;
    run.qualityEligible = false;
    run.reason ||= 'Previous campaign process ended before this run was finalized; unrecorded provider calls are conservatively reserved.';
    run.recordedProviderRequests = recorded;
    run.unaccountedProviderRequestsUpperBound = requiredReserve;
    run.providerRequestsUpperBound = recorded + requiredReserve;
    reconciledRuns++;
  }
  const providerBudgetUsedUpperBound = report.providerRequests.length + reserve;
  if (!Number.isSafeInteger(providerBudgetUsedUpperBound)) throw new Error('Campaign provider budget overflow');
  if (reconciledRuns || reserve !== aggregateReserve) {
    report.unaccountedProviderRequestsUpperBound = reserve;
    report.providerBudgetUsedUpperBound = providerBudgetUsedUpperBound;
  }
  return { reconciledRuns, providerBudgetUsedUpperBound };
}
