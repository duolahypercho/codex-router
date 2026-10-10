// Transport delivery and generation completion are separate facts. This module
// observes only protocol metadata: never retain response text, arguments or errors.
const OUTCOMES = new Set(["completed", "failed", "incomplete", "canceled", "indeterminate"]);
const TERMINALS = new Set(["response.completed", "response.done", "response.failed", "response.incomplete", "response.error", "response.cancelled", "response.canceled", "error"]);

export function knownGenerationOutcome(value) {
  return OUTCOMES.has(value) ? value : undefined;
}

function statusOutcome(status) {
  if (status === "cancelled" || status === "canceled") return "canceled";
  return knownGenerationOutcome(status);
}

export function responseOutcomeFromPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const type = payload.type;
  if (type === "error" || type === "response.error" || type === "response.failed") return "failed";
  if (type === "response.incomplete") return "incomplete";
  if (type === "response.cancelled" || type === "response.canceled") return "canceled";
  if (TERMINALS.has(type)) {
    const status = payload.response?.status;
    // A malformed/unknown embedded status cannot certify completion.
    return status === undefined ? "completed" : statusOutcome(status) ?? "indeterminate";
  }
  if (payload.object === "response" || (!type && Array.isArray(payload.output))) {
    return statusOutcome(payload.status) ?? "indeterminate";
  }
  if (!type && payload.error && !payload.choices) return "failed";
  const finish = payload.choices?.[0]?.finish_reason;
  if (finish === "length" || finish === "content_filter") return "incomplete";
  if (finish === "stop" || finish === "tool_calls" || finish === "function_call") return "completed";
  return undefined;
}

export class ResponseOutcomeObserver {
  #outcome;
  observe(payload) {
    const outcome = responseOutcomeFromPayload(payload);
    if (!outcome) return undefined;
    // One attempt cannot undo a terminal failure by sending a later completion.
    // A deliberate retry gets a new observer (or reset), not erased evidence.
    if (!this.#outcome || this.#outcome === "completed" || this.#outcome === "indeterminate") {
      this.#outcome = outcome;
    }
    return outcome;
  }
  outcome() { return this.#outcome; }
  reset() { this.#outcome = undefined; }
}

export function resolveGenerationOutcome({ observed, status, canceled = false, failed = false, expectsTerminal = false } = {}) {
  if (["failed", "incomplete", "canceled"].includes(observed)) return observed;
  if (failed || status >= 400) return "failed";
  if (canceled || status === 0) return "canceled";
  if (knownGenerationOutcome(observed)) return observed;
  if (expectsTerminal) return "indeterminate";
  return status >= 200 && status < 400 ? "completed" : "indeterminate";
}

// Older ledgers cannot reconstruct missing terminal events. Keep the historical
// HTTP-based interpretation for compatibility, but never override new outcomes
// or an explicit historical truncation/empty/deadline marker.
export function usageEventSucceeded(event = {}) {
  const outcome = knownGenerationOutcome(event.generationOutcome);
  if (outcome) return outcome === "completed";
  return event.status >= 200 && event.status < 400 &&
    !event.streamAborted && !event.emptyCompletion &&
    !event.emptyCompletionUnrepairable && !event.requestDeadlineExceeded;
}
