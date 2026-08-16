import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { upstreamFailureKind } from "./error-translation.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

// Keeping a turn alive when the provider it was routed to has no usage left.
//
// An install with thirty providers configured runs out of one of them most
// days: a coding-plan window closes, a weekly quota lands, a balance empties.
// Today that ends the conversation -- the router names the failure clearly and
// Codex has nothing to do with a billing error, so a session mid-task simply
// stops, subagents included. Every other model the operator can reach is
// already known to this process; nothing ever tried one.
//
// The rules that make that safe are in AGENTS.md ("Failing a turn over to
// another model is legal only before the first relayed byte"). This module owns
// three of them: which failures qualify, which candidates are eligible, and how
// long a provider that said it was empty is believed.

export const PROVIDER_COOLDOWNS_PATH =
  process.env.MODEL_ROUTER_PROVIDER_COOLDOWNS ||
  path.join(STATE_DIR, "provider-cooldowns.json");

export const FAILOVER_STATE_PATH =
  process.env.MODEL_ROUTER_FAILOVER_STATE || path.join(STATE_DIR, "failover.json");

// A rate limit short enough to wait out is not worth a model swap: the wait
// costs seconds, and the swap costs a cold prompt cache for the rest of the
// session. Sixty seconds is the line because it is roughly where Codex's own
// retrying stops being invisible to the user.
export const MIN_RATE_LIMIT_COOLDOWN_SECONDS = 60;

// A provider's own reset time is believed, but not indefinitely. A malformed or
// absurd `Retry-After` (some gateways send epoch seconds where seconds-from-now
// belong) would otherwise strand the operator's chosen model for years.
export const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

// Two hops, so a turn costs at most two extra round trips before it either
// succeeds or returns the failure it was always going to return.
export const MAX_FAILOVER_HOPS = 2;

// The whole failover sequence, not each hop. A turn that has already spent this
// long recovering is better off reporting the original failure than spending
// more of the user's time on a third guess.
export const FAILOVER_BUDGET_MS = 30_000;

const MAX_COOLDOWN_ENTRIES = 64;

// Free before paid, and the operator's signed-in ChatGPT plan between them.
// A free model is a real downgrade in capability, so it is not the first choice
// on merit -- it is first because it is the only tier that cannot surprise
// someone with a bill they did not choose to incur. The native tier sits second
// because a ChatGPT subscription is already paid for and flat-rate. Metered
// providers rank last, and only ones the operator explicitly enabled.
export const FAILOVER_TIER = Object.freeze({ free: 0, native: 1, subscription: 2 });

function nowMs(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function isoOrUndefined(value) {
  const ms = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// -- which failures qualify --------------------------------------------------

// `{ swap: false }`, or `{ swap: true, reason, until }` where `until` is present
// only when the provider itself said when it would be back.
//
// Deliberately narrow. A rejected credential, an unknown model, and a malformed
// request all produce the same answer from every other provider too, so a swap
// would spend two more round trips to reprint the same failure with a different
// model's name on it -- and for a credential in particular it would hide the one
// fact the operator needs. A 5xx is excluded because upstream-retry.mjs already
// absorbs the transient shapes and because masking a provider outage costs the
// operator an incident they would want to see.
export function classifyRoutedFailure({ status, bodyText, retryAfterSeconds, now } = {}) {
  const code = Number(status);
  if (!Number.isFinite(code) || code < 400 || code >= 500) return { swap: false };
  const at = nowMs(now);
  const retryAfter = Number(retryAfterSeconds);
  const kind = upstreamFailureKind({ status: code, bodyText });

  // A plan that never included this API is not an exhausted balance, and no
  // other model on another provider makes it true. Checked first because the
  // two vocabularies overlap.
  if (kind === "entitlement") return { swap: false };

  if (kind === "out_of_usage" || code === 402) {
    // Most providers say they are empty without saying when they refill. That
    // is not a reason to invent a window: the turn still fails over, and the
    // next turn tries the operator's chosen model again, which is the honest
    // behaviour when nothing is known.
    return {
      swap: true,
      reason: "out_of_usage",
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { until: cappedUntil(at, retryAfter * 1_000) }
        : {}),
    };
  }

  if (code === 429 && Number.isFinite(retryAfter) && retryAfter > MIN_RATE_LIMIT_COOLDOWN_SECONDS) {
    return { swap: true, reason: "rate_limited", until: cappedUntil(at, retryAfter * 1_000) };
  }

  return { swap: false };
}

function cappedUntil(at, durationMs) {
  return new Date(at + Math.min(durationMs, MAX_COOLDOWN_MS)).toISOString();
}

// -- how long an empty provider is believed ----------------------------------

function readCooldownDocument() {
  if (!existsSync(PROVIDER_COOLDOWNS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_COOLDOWNS_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt file must never take routing down. An unreadable cooldown
    // document means "nothing is cooled down", which costs one wasted round
    // trip at worst -- the failure mode a stale cooldown does not have.
    return {};
  }
}

function writeCooldownDocument(document) {
  try {
    const entries = Object.entries(document)
      .sort((left, right) => String(right[1]?.until).localeCompare(String(left[1]?.until)))
      .slice(0, MAX_COOLDOWN_ENTRIES);
    writePrivateJson(PROVIDER_COOLDOWNS_PATH, Object.fromEntries(entries), {
      directoryMode: 0o700,
    });
  } catch {
    // Cooldown bookkeeping must never interrupt or fail a model request.
  }
}

export function readProviderCooldowns({ now } = {}) {
  const at = nowMs(now);
  const live = {};
  for (const [id, entry] of Object.entries(readCooldownDocument())) {
    const until = isoOrUndefined(entry?.until);
    if (until && Date.parse(until) > at) live[id] = { ...entry, until };
  }
  return live;
}

// `undefined` once the window the provider named has passed, so expiry needs no
// sweeper and a provider comes back by itself.
export function providerCooldown(providerId, { now } = {}) {
  const id = canonicalProviderId(String(providerId || "").trim());
  return id ? readProviderCooldowns({ now })[id] : undefined;
}

// Only ever records a window the provider itself reported. A verdict with no
// `until` records nothing: the turn fails over, and the next one asks the
// operator's chosen provider again rather than guessing on its behalf.
//
// The one exception is naming, not timing. Two hops see the same failure and
// know different amounts about it: `api-forwarder` sees the provider's real
// headers -- including the `Retry-After` LiteLLM does not relay, which is the
// only reason a window is ever known at all -- but it has already piped the
// body away and can classify by status alone. The router sees the body and can
// tell an exhausted plan from a burst rate limit. So a later caller with no
// window of its own may sharpen the reason on a window that already exists.
// It may never create one.
export function recordProviderCooldown(providerId, { until, reason, now } = {}) {
  const id = canonicalProviderId(String(providerId || "").trim());
  if (!id) return undefined;
  const at = nowMs(now);
  const document = readCooldownDocument();
  const existing = document[id];
  const live = existing && Date.parse(existing.until) > at ? existing : undefined;
  const expiry = isoOrUndefined(until);
  if (!expiry) {
    if (!live || !reason || live.reason === reason) return undefined;
    document[id] = { ...live, reason };
    writeCooldownDocument(document);
    return document[id];
  }
  const capped = new Date(Math.min(Date.parse(expiry), at + MAX_COOLDOWN_MS)).toISOString();
  if (Date.parse(capped) <= at) return undefined;
  document[id] = {
    until: capped,
    ...(reason ? { reason } : {}),
    observedAt: new Date(at).toISOString(),
  };
  writeCooldownDocument(document);
  return document[id];
}

// Called on the first success from a provider. A quota that refilled early, a
// limit the operator raised, a reset time the provider got wrong -- all three
// end the same way, with a real answer, and that answer is better evidence than
// anything this file recorded.
export function clearProviderCooldown(providerId) {
  const id = canonicalProviderId(String(providerId || "").trim());
  if (!id) return false;
  const document = readCooldownDocument();
  if (!(id in document)) return false;
  delete document[id];
  writeCooldownDocument(document);
  return true;
}

export function clearAllProviderCooldowns() {
  writeCooldownDocument({});
  return true;
}

// -- the operator's answer ---------------------------------------------------

function defaultSettings() {
  return { version: 1, enabled: true, chain: [], defaulted: true };
}

// A file exists, so somebody was here, but this build cannot tell what they
// chose. Off is what every install had before failover shipped, and
// `bin/control failover on` is one command away. Same reasoning as the vision
// bridge's `disabledSettings()`.
function unreadableSettings() {
  return { version: 1, enabled: false, chain: [] };
}

export function readFailoverSettings() {
  if (!existsSync(FAILOVER_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(FAILOVER_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        chain: Array.isArray(parsed.chain)
          ? parsed.chain.map((slug) => String(slug).trim()).filter(Boolean)
          : [],
      };
    }
  } catch {
    // Falls through to the conservative reading below.
  }
  return unreadableSettings();
}

export function setFailoverEnabled(enabled) {
  const current = readFailoverSettings();
  const next = { version: 1, enabled: enabled === true, chain: current.chain };
  writePrivateJson(FAILOVER_STATE_PATH, next, { directoryMode: 0o700 });
  return next;
}

// An empty chain hands the choice back to the ranking. A named chain is the
// operator's order and is used verbatim, minus any entry this build cannot
// route to -- a pinned model that was removed must not disable failover.
export function setFailoverChain(slugs) {
  const current = readFailoverSettings();
  const chain = (Array.isArray(slugs) ? slugs : [])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const next = { version: 1, enabled: current.enabled, chain };
  writePrivateJson(FAILOVER_STATE_PATH, next, { directoryMode: 0o700 });
  return next;
}

// -- which candidates are eligible -------------------------------------------

export function failoverTier(model, providers = PROVIDERS) {
  const provider = providers.get(model?.provider);
  return provider?.keyless || provider?.authMode === "anonymous"
    ? FAILOVER_TIER.free
    : FAILOVER_TIER.subscription;
}

// What the ranking will actually be able to do, counted rather than promised.
//
// The tier order is free-then-paid, but `opencode-free` and `kilo-free` are
// catalog-only by design: their free subsets are picked out by a naming rule
// their vendors change without notice, so nothing is checked in and the free
// tier is empty until the operator curates a model locally. Reporting
// "free models first" on an install that has curated none describes an order
// that cannot happen. Every surface that talks about failover asks this
// instead, and says only what is true here.
//
// A model served from this machine is counted apart: it is free, and it is
// still never chosen automatically, so promising it would be the same mistake
// in a different place.
export function failoverTierCounts(models, providers = PROVIDERS) {
  const counts = { free: 0, local: 0, subscription: 0 };
  for (const model of Array.isArray(models) ? models : []) {
    const provider = providers.get(model?.provider);
    if (provider?.keyless) counts.local += 1;
    else if (provider?.authMode === "anonymous") counts.free += 1;
    else counts.subscription += 1;
  }
  return counts;
}

function supportsImageInput(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes("image");
}

// The candidate has to be able to hold the conversation that is already in
// flight. `estimatedTokens` comes from the bytes the router was about to send
// (estimateInputTokens), which errs high by design -- the safe direction here,
// because trading a quota failure for a context-window rejection is a strictly
// worse turn than the one it replaced.
function eligible(model, { fromProvider, estimatedTokens, needsImage, needsMultiAgentV2, cooled }) {
  if (!model?.slug) return false;
  if (canonicalProviderId(model.provider) === fromProvider) return false;
  if (cooled.has(canonicalProviderId(model.provider))) return false;
  if (Number.isFinite(estimatedTokens) && Number(model.contextWindow) < estimatedTokens) {
    return false;
  }
  // A text-only candidate can still serve an image turn -- the vision bridge
  // stands in -- but only when the bridge is on for it. `visionBridge: false`
  // is the registry saying this model must never be handed transcribed images.
  if (needsImage && !supportsImageInput(model) && model.visionBridge === false) return false;
  if (needsMultiAgentV2 && (model.multiAgentVersion || "v1") !== "v2") return false;
  return true;
}

// Ordered candidates for a turn whose route just reported it had no usage left.
// `models` is what the operator can actually reach right now -- the caller
// passes `selectedConfiguredListedModels()` minus hidden slugs, which is the
// same set the vision bridge picks its engine from.
//
// Shaped like `rankVisionEngines`: filter on declared capability, then order by
// cost, then by the registry's own preference. The native ChatGPT candidate is
// not a registry model and is spliced in at `FAILOVER_TIER.native` by the
// caller, which is the only place that knows whether a session exists.
export function rankFailoverCandidates(
  models,
  { from, estimatedTokens, needsImage = false, needsMultiAgentV2 = false, chain = [], now } = {},
) {
  const fromProvider = canonicalProviderId(from?.provider || "");
  const cooled = new Set(Object.keys(readProviderCooldowns({ now })));
  const available = (Array.isArray(models) ? models : []).filter(
    (model) =>
      model.slug !== from?.slug &&
      eligible(model, { fromProvider, estimatedTokens, needsImage, needsMultiAgentV2, cooled }),
  );

  if (chain.length) {
    const bySlug = new Map(available.map((model) => [model.slug, model]));
    return chain
      .map((slug) => bySlug.get(slug))
      .filter(Boolean)
      .map((model) => ({ tier: failoverTier(model), model }));
  }

  return available
    // A model served from this machine is free and private, and it is still
    // never chosen automatically: the runtime might not be running, and a
    // failover that lands on a dead localhost has turned an honest quota error
    // into a connection error. Same rule the vision bridge applies to its own
    // local engine -- name one in the chain and it is used.
    .filter((model) => !PROVIDERS.get(model.provider)?.keyless)
    .map((model) => ({ tier: failoverTier(model), model }))
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        Number(left.model.priority ?? 999) - Number(right.model.priority ?? 999) ||
        String(left.model.slug).localeCompare(String(right.model.slug)),
    );
}
