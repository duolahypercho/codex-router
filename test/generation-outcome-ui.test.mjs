import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "../apps/control-center/src/i18n.ts";
import { tokenCountFromEvent } from "../apps/control-center/src/lib.ts";
import {
  eventGenerationCompleted,
  eventGenerationPresentation,
  eventHttpStatus,
  generationOutcomesSummary,
  recordGenerationOutcome,
} from "../apps/control-center/src/generation-outcome.ts";

const en = createTranslator("en");

test("HTTP 200 does not certify generation success or hide canceled and unknown outcomes", () => {
  const labels = { completed: "Completed", failed: "Failed", incomplete: "Incomplete", canceled: "Canceled", indeterminate: "Unknown" };
  const tones = { completed: "success", failed: "danger", incomplete: "warning", canceled: "neutral", indeterminate: "warning" };
  for (const [generationOutcome, label] of Object.entries(labels)) {
    const event = { status: 200, httpStatus: 200, generationOutcome, billedInputTokens: 100, billedOutputTokens: 20,
      inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const presentation = eventGenerationPresentation(event, en);
    assert.equal(presentation.label, label);
    assert.equal(presentation.tone, tones[generationOutcome]);
    assert.equal(presentation.detail, `HTTP 200; generation: ${label}`);
    assert.equal(eventGenerationCompleted(event), generationOutcome === "completed");
    assert.equal(tokenCountFromEvent(event), 120, "failure presentation must retain billed spend");
  }
});
test("historical and future unknown records remain explicit about missing generation evidence", () => {
  for (const status of [200, 302, 502, undefined]) {
    const event = { status };
    const presentation = eventGenerationPresentation(event, en);
    assert.equal(presentation.label, "Not recorded");
    assert.equal(presentation.tone, status === 502 ? "danger" : "neutral");
    assert.equal(eventGenerationCompleted(event), false);
    assert.match(presentation.detail, /generation: Not recorded$/);
  }
  assert.equal(eventGenerationPresentation({ status: 200, generationOutcome: "future-terminal" }, en).label, "Not recorded");
  assert.equal(eventHttpStatus({ status: 200, httpStatus: 502 }), 502);
  assert.equal(eventHttpStatus({ status: 999 }), undefined);
  assert.equal(eventGenerationCompleted({ httpStatus: 502, generationOutcome: "completed" }), false);
});

test("summaries separate recorded generations from historical HTTP compatibility counters", () => {
  const stats = { requests: 7, successfulRequests: 7, outcomeCounts: {}, legacyOutcomeRequests: 0 };
  for (const generationOutcome of ["completed", "failed", "incomplete", "canceled", "indeterminate", undefined, "future-terminal"]) {
    recordGenerationOutcome(stats, { status: 200, generationOutcome });
  }
  assert.deepEqual(stats.outcomeCounts, { completed: 1, failed: 1, incomplete: 1, canceled: 1, indeterminate: 1 });
  assert.equal(stats.legacyOutcomeRequests, 2);
  assert.equal(generationOutcomesSummary(stats, en), "1 Completed · 1 Failed · 1 Incomplete · 1 Canceled · 1 Unknown · 2 Not recorded");
  assert.equal(generationOutcomesSummary({ requests: 3, successfulRequests: 3 }, en), "3 Not recorded");
  assert.equal(generationOutcomesSummary({ requests: 0 }, en), undefined);
});

test("generation outcomes and HTTP provenance use the existing Chinese catalogs", () => {
  for (const [locale, failed, missing, unknown] of [["zh-CN", "失败", "未记录", "结果不明"], ["zh-TW", "失敗", "未記錄", "結果不明"]]) {
    const t = createTranslator(locale);
    assert.equal(eventGenerationPresentation({ status: 200, generationOutcome: "failed" }, t).label, failed);
    assert.equal(eventGenerationPresentation({ status: 200 }, t).label, missing);
    assert.equal(eventGenerationPresentation({ status: 200, generationOutcome: "indeterminate" }, t).label, unknown);
    assert.match(eventGenerationPresentation({ status: 200 }, t).detail, /HTTP 200/);
    assert.doesNotMatch(generationOutcomesSummary({ requests: 1 }, t), /\{\w+\}/);
  }
});
