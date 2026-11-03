// The free/auto pool at runtime: which member to try next, which ones are
// drained, how a failure is read, and the local status the Control Center
// shows. See src/free-pool-catalog.mjs for where the members come from.
//
// Drains are pool-local. A member that answered 429 is skipped by free/auto
// for a while, but that record never touches `provider-cooldowns.json`: an
// operator who picked a Kilo or OpenCode model by name keeps getting exactly
// that model, whatever the pool has learned. That is why the pool may drain on
// a failure that names no window -- the window only shortens free/auto's own
// search, and it expires by itself.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import {
  FREE_POOL_CATALOG_PATH,
  FREE_POOL_OPENCODE_PROVIDER,
  FREE_POOL_PROVIDER,
  FREE_POOL_SELF_UPSTREAM,
  FREE_POOL_SLUG,
  KILO_FREE_MODELS_URL,
  OPENCODE_FREE_MODELS_URL,
  parseKiloFreeModels,
  parseOpenCodeFreeModels,
  readFreePoolCatalog,
} from "./free-pool-catalog.mjs";
import { MODEL_BY_SLUG, MODELS } from "./model-registry.mjs";
import { PROVIDER_SELECTION_PATH, STATE_DIR } from "./paths.mjs";

export { FREE_POOL_SLUG } from "./free-pool-catalog.mjs";

export const FREE_POOL_DRAINS_PATH = path.join(STATE_DIR, "free-pool-drains.json");
// Walking the whole pool is the point of free/auto, so it gets more time than
// the general failover budget; each hop is still bounded by the request's own
// deadline and stops the moment the client goes away.
export const FREE_POOL_BUDGET_MS = 120_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_DRAIN_MS = 12 * HOUR;

export function isFreePoolModel(model) {
  return Boolean(model) && model.freePool === true && model.slug === FREE_POOL_SLUG;
}

export function isFreePoolMember(model) {
  return Boolean(model) && (
    isFreePoolModel(model) ||
    (model.freePoolMember === true &&
      [FREE_POOL_PROVIDER, FREE_POOL_OPENCODE_PROVIDER].includes(model.provider))
  );
}

function preferredIds(env) {
  return String(env.MODEL_ROUTER_FREE_POOL_PREFER || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

// The pool's own entry (Kilo's rotating free router), then every member, with
// `MODEL_ROUTER_FREE_POOL_PREFER` (comma-separated upstream ids or slugs)
// moved to the front in the order given. The override exists so an operator
// can pin a favourite -- or, in testing, put a known-dead member first to watch
// the pool move past it.
export function freePoolRouteOrder({ env = process.env, models = MODELS, bySlug = MODEL_BY_SLUG } = {}) {
  const pool = bySlug.get(FREE_POOL_SLUG);
  if (!isFreePoolModel(pool)) return [];
  const members = models.filter((model) => model.freePoolMember === true && isFreePoolMember(model));
  const order = [pool, ...members];
  const preferred = preferredIds(env);
  if (!preferred.length) return order;
  const front = [];
  for (const id of preferred) {
    const match = order.find((model) =>
      !front.includes(model) && (model.slug === id || model.upstreamModel === id));
    if (match) front.push(match);
  }
  return [...front, ...order.filter((model) => !front.includes(model))];
}

function nowMs(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function readDrainDocument() {
  if (!existsSync(FREE_POOL_DRAINS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(FREE_POOL_DRAINS_PATH, "utf8"));
    const drains = parsed?.version === 1 && parsed.drains && typeof parsed.drains === "object"
      ? parsed.drains
      : {};
    return Object.fromEntries(
      Object.entries(drains).filter(([, value]) => value && typeof value.until === "string"),
    );
  } catch {
    return {};
  }
}

function writeDrainDocument(drains) {
  writePrivateJson(FREE_POOL_DRAINS_PATH, { version: 1, drains });
}

// Live drains only. An expired one is simply not returned; it is pruned the
// next time anything is written.
export function freePoolDrains({ now } = {}) {
  const at = nowMs(now);
  return Object.fromEntries(
    Object.entries(readDrainDocument()).filter(([, value]) => Date.parse(value.until) > at),
  );
}

export function drainFreePoolMember(slug, { ms, reason, status, now } = {}) {
  if (typeof slug !== "string" || !slug || !Number.isFinite(ms) || ms <= 0) return undefined;
  const at = nowMs(now);
  const drains = freePoolDrains({ now: at });
  const previous = drains[slug];
  drains[slug] = {
    until: new Date(at + Math.min(ms, MAX_DRAIN_MS)).toISOString(),
    ...(reason ? { reason } : {}),
    ...(Number.isInteger(status) ? { status } : {}),
    observedAt: new Date(at).toISOString(),
    count: (Number.isInteger(previous?.count) ? previous.count : 0) + 1,
  };
  writeDrainDocument(drains);
  return drains[slug];
}

export function clearFreePoolDrain(slug) {
  const document = readDrainDocument();
  if (!(slug in document)) return false;
  delete document[slug];
  writeDrainDocument(document);
  return true;
}

export function clearAllFreePoolDrains() {
  writeDrainDocument({});
}

// The members free/auto may still try right now, in order.
export function availableFreePoolRoutes({ now, env, providerEnabled = () => true } = {}) {
  const drains = freePoolDrains({ now });
  return freePoolRouteOrder({ env }).filter((model) =>
    !drains[model.slug] && providerEnabled(model.provider));
}

// When the first drained member comes back, for the exhausted error.
export function soonestFreePoolRetry({ now } = {}) {
  const times = Object.values(freePoolDrains({ now }))
    .map((value) => Date.parse(value.until))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

function retryAfterMs(headers, now) {
  const raw = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : headers?.["retry-after"];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - nowMs(now)) : undefined;
}

const QUOTA_TEXT = /quota|freeusagelimit|free usage|usage limit|daily limit|limit exceeded|exceeded your|insufficient|credits?/i;
const UNAVAILABLE_TEXT = /no upstreams?|no (?:available )?(?:endpoints?|providers?)|model[^.]{0,60}(?:not found|does not exist|not available|unavailable|not supported|deprecated|disabled)|unknown model|overloaded|temporarily unavailable/i;

// Whether a failed member should hand the turn to the next one, and for how
// long free/auto should leave it alone. Rate limits, quota, outages and
// timeouts move; an ordinary bad request does not, because the next member
// would most likely reject the same body.
export function classifyFreePoolFailure({ status, bodyText = "", headers, now } = {}) {
  const text = String(bodyText || "");
  const code = Number.isInteger(status) ? status : 0;
  if (code === 429) {
    if (QUOTA_TEXT.test(text)) return { swap: true, reason: "free_quota", drainMs: HOUR };
    const named = retryAfterMs(headers, now);
    return {
      swap: true,
      reason: "rate_limited",
      drainMs: named === undefined ? 10 * MINUTE : Math.min(Math.max(named, 30_000), HOUR),
    };
  }
  if (code === 402) return { swap: true, reason: "payment_required", drainMs: 6 * HOUR };
  if (code === 401 || code === 403) return { swap: true, reason: "refused_anonymous", drainMs: HOUR };
  if (code === 404 || code === 410) return { swap: true, reason: "model_unavailable", drainMs: 6 * HOUR };
  if (code === 408 || code === 0) return { swap: true, reason: "timeout_or_transport", drainMs: 2 * MINUTE };
  if (code >= 500 && code <= 599) {
    return {
      swap: true,
      reason: UNAVAILABLE_TEXT.test(text) ? "model_unavailable" : "upstream_error",
      drainMs: UNAVAILABLE_TEXT.test(text) ? 10 * MINUTE : 2 * MINUTE,
    };
  }
  if ((code === 400 || code === 422) && UNAVAILABLE_TEXT.test(text)) {
    return { swap: true, reason: "model_unavailable", drainMs: 30 * MINUTE };
  }
  return { swap: false, reason: "request_rejected" };
}

export function freePoolExhaustedError({ now } = {}) {
  const retryAt = soonestFreePoolRetry({ now });
  return {
    error: {
      type: "free_pool_exhausted",
      code: "free_pool_exhausted",
      message:
        `Every free model behind ${FREE_POOL_SLUG} is rate limited, out of free quota, or unavailable right now` +
        (retryAt ? `; the first one is expected back at ${retryAt}.` : ".") +
        " Try again later, or pick a model with your own key.",
      ...(retryAt ? { retry_at: retryAt } : {}),
    },
  };
}

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "codex-router-free-pool" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

// Reads both anonymous `/models` listings -- no prompt is sent -- and caches
// the members. A lane that cannot be read keeps what the previous refresh
// found, so one outage does not empty half the pool. Routing processes load
// the catalog at startup; a changed member set takes effect on restart.
export async function refreshFreePoolCatalog({
  fetchImpl = fetch,
  timeoutMs = 15_000,
  file = FREE_POOL_CATALOG_PATH,
  now,
} = {}) {
  const previous = readFreePoolCatalog({ file });
  const errors = [];
  const lane = async (url, parse, fallback) => {
    try {
      const members = parse(await fetchJson(url, { fetchImpl, timeoutMs }));
      if (members.length) return members;
      errors.push(`${url} listed no usable free models`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return fallback;
  };
  const [kilo, opencode] = await Promise.all([
    lane(KILO_FREE_MODELS_URL, parseKiloFreeModels, previous.kilo),
    lane(OPENCODE_FREE_MODELS_URL, parseOpenCodeFreeModels, previous.opencode),
  ]);
  const document = {
    version: 1,
    fetchedAt: new Date(nowMs(now)).toISOString(),
    kilo,
    opencode,
  };
  if (errors.length < 2) writePrivateJson(file, document);
  return { ...document, errors, written: errors.length < 2 };
}

const REFRESH_AFTER_MS = 24 * HOUR;

// Whether the router should refresh the catalog in the background at startup:
// only when the operator explicitly enabled `free` (so an install that never
// opted in makes no request to either lane), only when the cache is missing or
// a day old, and never with MODEL_ROUTER_FREE_POOL_REFRESH=0.
export function freePoolRefreshDue({ env = process.env, now, file = FREE_POOL_CATALOG_PATH } = {}) {
  if (env.MODEL_ROUTER_FREE_POOL_REFRESH === "0") return false;
  try {
    const selection = JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8"));
    if (!Array.isArray(selection?.providers) || !selection.providers.includes(FREE_POOL_PROVIDER)) {
      return false;
    }
  } catch {
    return false;
  }
  const catalog = readFreePoolCatalog({ file });
  if (catalog.source !== "live" || !catalog.fetchedAt) return true;
  return nowMs(now) - Date.parse(catalog.fetchedAt) >= REFRESH_AFTER_MS;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// Everything the Control Center shows about free/auto, from local files only:
// the member list and its drains, the cached catalog, and the usage ledger rows
// the router tagged with the pool.
export function freePoolStatus({ events = [], now, env = process.env, providerEnabled } = {}) {
  const at = nowMs(now);
  const drains = freePoolDrains({ now: at });
  const catalog = readFreePoolCatalog();
  const order = freePoolRouteOrder({ env });
  const rows = events
    .filter((event) => event?.freePool === FREE_POOL_SLUG)
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  const byMember = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let served = 0;
  let errors = 0;
  let fallbacks = 0;
  let exhausted = 0;
  const requests = new Set();
  for (const row of rows) {
    if (row.requestId) requests.add(row.requestId);
    const ok = Number.isInteger(row.status) && row.status >= 200 && row.status < 300;
    const member = byMember.get(row.model) || {
      model: row.model,
      requests: 0,
      served: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    member.requests += 1;
    if (ok) {
      member.served += 1;
      served += 1;
    } else {
      member.failed += 1;
      errors += 1;
    }
    if (row.freePoolReason === "exhausted") exhausted += 1;
    if (ok && row.failoverFrom) fallbacks += 1;
    member.inputTokens += count(row.inputTokens);
    member.outputTokens += count(row.outputTokens);
    inputTokens += count(row.inputTokens);
    outputTokens += count(row.outputTokens);
    byMember.set(row.model, member);
  }
  return {
    pool: FREE_POOL_SLUG,
    available: order.length > 0,
    catalog: {
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      kilo: catalog.kilo.length,
      opencode: catalog.opencode.length,
    },
    members: order.map((model, index) => {
      const drain = drains[model.slug];
      return {
        position: index + 1,
        slug: model.slug,
        upstreamModel: model.upstreamModel,
        lane: model.provider === FREE_POOL_OPENCODE_PROVIDER ? "opencode" : "kilo",
        self: model.upstreamModel === FREE_POOL_SELF_UPSTREAM && model.slug === FREE_POOL_SLUG,
        enabled: typeof providerEnabled === "function" ? providerEnabled(model.provider) : true,
        contextWindow: model.contextWindow,
        ...(drain
          ? {
              drained: true,
              drainedUntil: drain.until,
              drainReason: drain.reason,
              ...(Number.isInteger(drain.status) ? { drainStatus: drain.status } : {}),
              remainingMs: Math.max(0, Date.parse(drain.until) - at),
            }
          : { drained: false }),
      };
    }),
    usage: {
      requests: requests.size || served + exhausted,
      attempts: rows.length,
      served,
      errors,
      fallbacks,
      exhausted,
      inputTokens,
      outputTokens,
      byMember: [...byMember.values()].sort((left, right) => right.requests - left.requests),
      recent: rows.slice(-25).reverse().map((row) => ({
        at: row.at,
        model: row.model,
        status: row.status,
        ...(row.failoverFrom ? { failoverFrom: row.failoverFrom } : {}),
        inputTokens: count(row.inputTokens),
        outputTokens: count(row.outputTokens),
        ...(row.requestId ? { requestId: row.requestId } : {}),
        ...(row.freePoolReason ? { reason: row.freePoolReason } : {}),
      })),
    },
  };
}
