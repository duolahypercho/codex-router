import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GROK_QUALITY_SOURCE_FILES, GROK_FINAL_VALIDATION_SOURCE_FILES, reconcileInterruptedQualityRuns,
} from '../scripts/grok-quality-resume.mjs';

const limits = { generationsPerRun: 12, providerGenerations: 114 };
const attempts = (runId, length) => Array.from({ length }, (_, index) => ({ runId, index }));

test('quality and final-validation snapshots include the operation-lowering source', () => {
  for (const files of [GROK_QUALITY_SOURCE_FILES, GROK_FINAL_VALIDATION_SOURCE_FILES]) {
    assert.ok(files.includes('src/grok-tool-alternatives.mjs'));
    assert.equal(new Set(files).size, files.length);
    for (const file of files) assert.ok(readFileSync(new URL(`../${file}`, import.meta.url)).length > 0);
  }
});

test('a crash before the first recorded call excludes the run and reserves its whole allowance', () => {
  const report = { runs: [{ id: 1, status: 'running', success: true, providerRequests: 0 }], providerRequests: [] };
  assert.deepEqual(reconcileInterruptedQualityRuns(report, limits), {
    reconciledRuns: 1, providerBudgetUsedUpperBound: 12,
  });
  assert.equal(report.runs[0].status, 'interrupted');
  assert.equal(report.runs[0].success, false);
  assert.equal(report.runs[0].qualityEligible, false);
  assert.match(report.runs[0].reason, /unrecorded provider calls/);
  assert.equal(report.runs[0].providerRequestsUpperBound, 12);
  assert.equal(report.unaccountedProviderRequestsUpperBound, 12);
});

test('partial attempt records are counted once and only their unrecorded allowance is reserved', () => {
  const report = { runs: [{ id: 1, status: 'completed' }, { id: 2, status: 'running', providerRequests: 3 }],
    providerRequests: [...attempts(1, 4), ...attempts(2, 2)] };
  const result = reconcileInterruptedQualityRuns(report, limits);
  assert.equal(report.runs[1].recordedProviderRequests, 2);
  assert.equal(report.runs[1].unaccountedProviderRequestsUpperBound, 10);
  assert.equal(report.runs[1].providerRequestsUpperBound, 12);
  assert.equal(result.providerBudgetUsedUpperBound, 16);
  assert.equal(report.runs[1].providerRequests, 3, 'preserve the partial counter as evidence');
});

test('an existing total per-run reserve is not added to the aggregate twice', () => {
  const report = { runs: [{ id: 1, status: 'running', providerRequestsUpperBound: 12 }],
    providerRequests: attempts(1, 3), unaccountedProviderRequestsUpperBound: 9 };
  const result = reconcileInterruptedQualityRuns(report, limits);
  assert.equal(report.unaccountedProviderRequestsUpperBound, 9);
  assert.equal(report.runs[0].unaccountedProviderRequestsUpperBound, 9);
  assert.equal(result.providerBudgetUsedUpperBound, 12);
});

test('an existing partial unknown-call reserve is extended only by its missing allowance', () => {
  const report = { runs: [{ id: 1, status: 'running', unaccountedProviderRequestsUpperBound: 4 }],
    providerRequests: attempts(1, 3), unaccountedProviderRequestsUpperBound: 4 };
  const result = reconcileInterruptedQualityRuns(report, limits);
  assert.equal(report.unaccountedProviderRequestsUpperBound, 9);
  assert.equal(result.providerBudgetUsedUpperBound, 12);
  const checkpoint = structuredClone(report);
  assert.deepEqual(reconcileInterruptedQualityRuns(report, limits), {
    reconciledRuns: 0, providerBudgetUsedUpperBound: 12,
  });
  assert.deepEqual(report, checkpoint, 'repeated resumes are idempotent');
});

test('manually reconciled historical runs retain their evidence and existing reserve', () => {
  const historical = { id: 5, status: 'interrupted', success: false, qualityEligible: false,
    reason: 'Manual investigation; telemetry was not checkpointed.', providerRequests: null,
    providerRequestsUpperBound: 12 };
  const report = { runs: [historical, { id: 6, status: 'running', providerRequests: 0 }],
    providerRequests: attempts(4, 24), unaccountedProviderRequestsUpperBound: 12,
    interruption: { unknownInterruptedRun: 5, unknownGenerationUpperBound: 12 } };
  const previous = structuredClone(historical);
  assert.equal(reconcileInterruptedQualityRuns(report, limits).providerBudgetUsedUpperBound, 48);
  assert.deepEqual(historical, previous);
  assert.equal(report.unaccountedProviderRequestsUpperBound, 24);
  const checkpoint = structuredClone(report);
  reconcileInterruptedQualityRuns(report, limits);
  assert.deepEqual(report, checkpoint);
});

test('an ambiguous aggregate reserve fails before mutating or double-counting an interruption', () => {
  const report = { runs: [{ id: 1, status: 'running' }], providerRequests: [],
    unaccountedProviderRequestsUpperBound: 12 };
  const checkpoint = structuredClone(report);
  assert.throws(() => reconcileInterruptedQualityRuns(report, limits), /Ambiguous campaign unknown-call reserve/);
  assert.deepEqual(report, checkpoint);
});

test('all recorded calls exhaust a per-run allowance without an additional unknown-call reserve', () => {
  const report = { runs: [{ id: 1, status: 'running' }], providerRequests: attempts(1, 12) };
  assert.equal(reconcileInterruptedQualityRuns(report, limits).providerBudgetUsedUpperBound, 12);
  assert.equal(report.unaccountedProviderRequestsUpperBound, 0);
});

test('resumed budget accounting reaches and can exceed the total quota without granting more calls', () => {
  for (const recorded of [78, 79]) {
    const report = { runs: [1, 2, 3].map(id => ({ id, status: 'running' })), providerRequests: attempts(0, recorded) };
    const { providerBudgetUsedUpperBound } = reconcileInterruptedQualityRuns(report, limits);
    assert.equal(providerBudgetUsedUpperBound, recorded + 36);
    assert.ok(providerBudgetUsedUpperBound >= limits.providerGenerations);
  }
});

test('invalid saved reserves fail closed instead of bypassing the generation limit', () => {
  for (const reserve of [-1, null, 1.5, '12', Number.MAX_SAFE_INTEGER]) {
    const report = { runs: [], providerRequests: attempts(1, 1), unaccountedProviderRequestsUpperBound: reserve };
    assert.throws(() => reconcileInterruptedQualityRuns(report, limits), /Invalid campaign count|budget overflow/);
  }
});
