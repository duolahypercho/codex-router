import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// Codex runs "Approve for me" through its own hidden native model. With
// `Use Router with ChatGPT` on, the main agent turn can be answered by an
// external provider while every approval still costs ChatGPT quota -- so an
// exhausted plan leaves a session that reasons and proposes commands but
// cannot execute the ones that need review (#787).
//
// This is the narrow counterpart to `native-redirect.mjs`. That redirect is
// deliberately all-or-nothing because "native turns carry no reliable marker
// separating background work from a deliberately picked GPT model". The
// reviewer is the exception: it arrives under its own slug, so it *can* be
// singled out, and a fallback scoped to it never touches a GPT model the
// operator chose on purpose.
export const AUTO_REVIEW_MODEL = "codex-auto-review";

export const AUTO_REVIEW_FALLBACK_PATH =
  process.env.MODEL_ROUTER_AUTO_REVIEW_FALLBACK_STATE ||
  path.join(STATE_DIR, "auto-review-fallback.json");

// The same bound `model-failover.mjs` puts on a provider cooldown. A window
// this router believed for longer than six hours would withhold a reviewer the
// operator is paying for on nothing but a stale number.
const MAX_EXHAUSTION_MS = 6 * 60 * 60 * 1_000;

function nowMs(now) {
  const value = Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function readDocument() {
  if (!existsSync(AUTO_REVIEW_FALLBACK_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(AUTO_REVIEW_FALLBACK_PATH, "utf8"));
    return parsed?.version === 1 && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // An unreadable document must not be read as consent to spend a provider's
    // quota on reviews. Absent and damaged both mean "no fallback configured".
    return undefined;
  }
}

function writeDocument(document) {
  writePrivateJson(AUTO_REVIEW_FALLBACK_PATH, { version: 1, ...document }, { directoryMode: 0o700 });
}

export function isAutoReviewModel(slug) {
  return String(slug || "").trim() === AUTO_REVIEW_MODEL;
}

export function readAutoReviewFallback({ now } = {}) {
  const document = readDocument();
  const model = typeof document?.model === "string" ? document.model.trim() : "";
  const until = document?.exhaustedUntil ? Date.parse(document.exhaustedUntil) : Number.NaN;
  const exhausted = Number.isFinite(until) && until > nowMs(now);
  return Object.freeze({
    model: model || undefined,
    // A window that has already passed is not a window. It is reported as
    // absent rather than deleted, so a read stays a read.
    exhaustedUntil: exhausted ? new Date(until).toISOString() : undefined,
    reason: exhausted && typeof document?.reason === "string" ? document.reason : undefined,
    observedAt: typeof document?.observedAt === "string" ? document.observedAt : undefined,
  });
}

// The whole point of recording the window: an approval that arrives while the
// native reviewer is known to be empty must not spend a full round trip
// learning that again. Codex asks for a review per command, so on a busy
// session that is one guaranteed rejection each time.
export function autoReviewFallbackEngaged({ now } = {}) {
  const state = readAutoReviewFallback({ now });
  return Boolean(state.model && state.exhaustedUntil);
}

export function setAutoReviewFallback(slug) {
  const value = String(slug || "").trim();
  if (!value) throw new Error("A routed model slug is required.");
  if (!value.includes("/")) {
    // Every routed slug is `provider/model`; a bare name is a native slug and
    // would put the reviewer straight back on the quota that just ran out.
    throw new Error(`"${value}" is not a routed model slug. Use the provider/model form.`);
  }
  const existing = readDocument() ?? {};
  writeDocument({ ...existing, model: value });
  return autoReviewFallbackSnapshot();
}

export function clearAutoReviewFallback() {
  if (existsSync(AUTO_REVIEW_FALLBACK_PATH)) unlinkSync(AUTO_REVIEW_FALLBACK_PATH);
  return autoReviewFallbackSnapshot();
}

// Only a refusal the native reviewer itself could not run is recorded, and
// only with a window the upstream named. `verdict` is `classifyRoutedFailure`'s
// answer, so an entitlement refusal, a policy rejection, a 5xx, and anything
// ambiguous have already been filtered out by the one classifier the routed
// path uses -- there is no second opinion here to drift from it.
export function recordAutoReviewExhaustion({ until, reason, now } = {}) {
  const document = readDocument();
  // Nothing to fall back to means nothing to remember. Recording a window for
  // an unconfigured install would make `status` claim a fallback it cannot do.
  if (!document?.model) return undefined;
  const at = nowMs(now);
  // A provider that says nothing about when it refills gets a short window
  // rather than an invented one: long enough that a burst of approvals in the
  // same minute does not each pay for the same rejection, short enough that a
  // quota which comes back is noticed almost at once.
  const named = until ? Date.parse(until) : Number.NaN;
  const expiry = Number.isFinite(named)
    ? Math.min(named, at + MAX_EXHAUSTION_MS)
    : at + 60_000;
  if (expiry <= at) return undefined;
  writeDocument({
    ...document,
    exhaustedUntil: new Date(expiry).toISOString(),
    ...(reason ? { reason } : {}),
    observedAt: new Date(at).toISOString(),
  });
  return autoReviewFallbackSnapshot({ now: at });
}

// Called on any native reviewer answer. A plan that refilled early, a limit the
// operator raised, or a reset time ChatGPT got wrong all end the same way, and
// a real answer outranks anything recorded here -- the same rule
// `clearProviderCooldown` follows.
export function clearAutoReviewExhaustion() {
  const document = readDocument();
  if (!document || document.exhaustedUntil === undefined) return false;
  const { exhaustedUntil, reason, observedAt, ...rest } = document;
  writeDocument(rest);
  return true;
}

export function autoReviewFallbackSnapshot({ now } = {}) {
  const state = readAutoReviewFallback({ now });
  return {
    model: state.model ?? null,
    nativeExhaustedUntil: state.exhaustedUntil ?? null,
    reason: state.reason ?? null,
    observedAt: state.observedAt ?? null,
    // What the next approval will actually do, rather than leaving three
    // fields for a reader to combine. Criterion 6 of #787 is that the active
    // reviewer is observable, and this is the field that answers it.
    reviewer: state.model && state.exhaustedUntil ? state.model : AUTO_REVIEW_MODEL,
    path: AUTO_REVIEW_FALLBACK_PATH,
  };
}
