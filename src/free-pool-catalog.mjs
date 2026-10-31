// The free/auto pool's member list.
//
// `free/auto` is one picker entry backed by many anonymous free models. The
// router, the LiteLLM gateway and the api-forwarder all resolve a model id from
// the registry they loaded at startup, so a member has to exist as an ordinary
// (unlisted) route in every one of those processes. This module turns the
// cached upstream catalogs into those routes. It deliberately imports nothing
// from the registry: the registry imports it while it is still loading.
//
// Only two upstreams are read, both publicly documented anonymous endpoints
// that need no login and no API key: the Kilo gateway's free pool and the
// OpenCode Zen free lane. OpenCode's free chat path lives on /inference/v1 and
// accepts the public CLI client fingerprint (see src/opencode-free-lane.mjs);
// the /models listing is still served from zen/v1. Their catalogs are fetched
// by `refreshFreePoolCatalog` (src/free-pool.mjs) -- no prompt is ever sent to
// discover them -- and written to `free-pool-catalog.json`. Without that file
// the static list below is used, so a fresh install still has a working pool.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { openCodeFreeIdWithdrawn } from "./opencode-curation.mjs";
import { STATE_DIR } from "./paths.mjs";

export const FREE_POOL_SLUG = "free/auto";
export const FREE_POOL_PROVIDER = "free";
export const FREE_POOL_OPENCODE_PROVIDER = "free-opencode";
// The pool entry itself is Kilo's own rotating free router, so it is always
// the first member and is never repeated as a separate one.
export const FREE_POOL_SELF_UPSTREAM = "kilo-auto/free";
export const FREE_POOL_CATALOG_PATH = path.join(STATE_DIR, "free-pool-catalog.json");
export const KILO_FREE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
export const OPENCODE_FREE_MODELS_URL = "https://opencode.ai/zen/v1/models";

// A member below this window cannot hold a normal Codex turn, so it is tried
// only after every larger one.
const SMALL_CONTEXT = 128_000;

// Used when no catalog has been fetched yet. Every id here answered an
// anonymous tool-capable request when this list was written; the live catalog
// replaces it on the first successful refresh.
export const STATIC_FREE_POOL_CATALOG = Object.freeze({
  source: "static",
  fetchedAt: undefined,
  kilo: Object.freeze([
    { id: "nvidia/nemotron-3.5-super-vl:free", contextLength: 1_000_000, image: true, preferredIndex: 0 },
    { id: "reflection/beam-free", contextLength: 1_000_000, image: false, preferredIndex: 1 },
    { id: "poolside/laguna-s-2.1:free", contextLength: 262_144, image: false, preferredIndex: 2 },
    { id: "nvidia/nemotron-3.5-lightning:free", contextLength: 1_000_000, image: false, preferredIndex: 3 },
    { id: "openrouter/free", contextLength: 200_000, image: true, preferredIndex: 4 },
  ]),
  // Live OpenCode Zen free chat ids as of 2026-11-01. Withdrawn ids stay out
  // (see OPENCODE_FREE_WITHDRAWN). The free lane answers on /inference/v1 with
  // the public CLI fingerprint in src/opencode-free-lane.mjs.
  opencode: Object.freeze([
    { id: "nemotron-3.5-super-vl-free", contextLength: 1_000_000, image: true },
    { id: "beam-free", contextLength: 1_048_576, image: false },
    { id: "nemotron-3.5-lightning-free", contextLength: 262_144, image: false },
    { id: "deepseek-v4.1-flash-free", contextLength: 200_000, image: false },
    { id: "glm-5.3-flash-free", contextLength: 200_000, image: false },
    { id: "flint-40b-free", contextLength: 131_072, image: false },
    { id: "mimo-v2.6-flash-free", contextLength: 200_000, image: false },
    { id: "big-pickle", contextLength: 200_000, image: false },
  ]),
});

// The same rule the registry enforces for the `free` provider. Kept here so a
// catalog entry that would fail registry validation is dropped before it gets
// that far.
export function kiloFreeId(id) {
  return typeof id === "string" &&
    id === id.trim() &&
    /^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(id) &&
    (id.endsWith(":free") || id.endsWith("/free") || id.endsWith("-free"));
}

export function openCodeFreeId(id) {
  return typeof id === "string" &&
    id === id.trim() &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id) &&
    (id === "big-pickle" || id.endsWith("-free")) &&
    // Withdrawn ids stay out. Client-gated free ids are included: the free
    // lane sends OpenCode's public CLI fingerprint (opencode-free-lane.mjs).
    !openCodeFreeIdWithdrawn(id);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function zeroPrice(pricing) {
  if (!pricing || typeof pricing !== "object") return false;
  const values = Object.values(pricing).filter((value) => value !== null && value !== undefined && value !== "");
  return values.length > 0 && values.every((value) => Number(value) === 0);
}

// Kilo's `/models` shape: `{ data: [{ id, isFree, pricing, context_length,
// supported_parameters, architecture: { input_modalities, output_modalities },
// preferredIndex }] }`. A member must be free, accept tools (Codex always sends
// them), and answer in text.
export function parseKiloFreeModels(document) {
  const rows = Array.isArray(document?.data) ? document.data : [];
  const seen = new Set();
  const members = [];
  for (const row of rows) {
    const id = row?.id;
    if (!kiloFreeId(id) || id === FREE_POOL_SELF_UPSTREAM || seen.has(id)) continue;
    if (row.isFree !== true && !zeroPrice(row.pricing)) continue;
    const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
    if (!parameters.includes("tools")) continue;
    const output = row.architecture?.output_modalities;
    if (Array.isArray(output) && output.length && !output.includes("text")) continue;
    const input = Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities : [];
    seen.add(id);
    members.push({
      id,
      contextLength: positiveInteger(row.context_length) ?? positiveInteger(row.top_provider?.context_length),
      image: input.includes("image"),
      ...(Number.isFinite(row.preferredIndex) ? { preferredIndex: row.preferredIndex } : {}),
    });
  }
  return members;
}

// Collect every numeric price leaf under a cost object. Zen's older listings
// used `{ input, output }`; the 2026-11 shape nests them under `text` as
// `{ text: { input: { price }, output: { price } } }`.
function costPrices(node, out = []) {
  if (node == null) return out;
  if (typeof node === "number") {
    out.push(node);
    return out;
  }
  if (typeof node !== "object") return out;
  if (typeof node.price === "number") out.push(node.price);
  for (const value of Object.values(node)) costPrices(value, out);
  return out;
}

function openCodeZeroCost(cost) {
  if (!cost || typeof cost !== "object") return true;
  const prices = costPrices(cost);
  // A missing price object is treated as free (name already matched *-free).
  // A stated non-zero leaf rejects the row.
  return prices.length === 0 || prices.every((value) => value === 0);
}

function openCodeInputModalities(modalities) {
  const input = Array.isArray(modalities?.input) ? modalities.input : [];
  return input.some((value) => value === "image" || String(value).startsWith("image/"));
}

// OpenCode Zen's shape: `{ data: [{ id, type, cost, capabilities, limit,
// modalities }] }`. Older listings carry only ids, so a missing field is not a
// rejection; a stated non-zero price or a stated lack of tools is.
export function parseOpenCodeFreeModels(document) {
  const rows = Array.isArray(document?.data) ? document.data : [];
  const seen = new Set();
  const members = [];
  for (const row of rows) {
    const id = row?.id;
    if (!openCodeFreeId(id) || seen.has(id)) continue;
    if (row.type !== undefined && row.type !== "chat") continue;
    if (!openCodeZeroCost(row.cost)) continue;
    if (row.capabilities?.tools?.supported === false) continue;
    seen.add(id);
    members.push({
      id,
      contextLength: positiveInteger(row.limit?.context),
      image: openCodeInputModalities(row.modalities),
    });
  }
  return members;
}

function validEntries(entries, accept) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && accept(entry.id))
    .map((entry) => ({
      id: entry.id,
      contextLength: positiveInteger(entry.contextLength),
      image: entry.image === true,
      ...(Number.isFinite(entry.preferredIndex) ? { preferredIndex: entry.preferredIndex } : {}),
    }));
}

// The cached catalog, or the static one. A damaged cache is treated as absent:
// the pool degrades to its static members rather than to nothing.
export function readFreePoolCatalog({ file = FREE_POOL_CATALOG_PATH } = {}) {
  if (!existsSync(file)) return STATIC_FREE_POOL_CATALOG;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version !== 1) return STATIC_FREE_POOL_CATALOG;
    const kilo = validEntries(parsed.kilo, (id) => kiloFreeId(id) && id !== FREE_POOL_SELF_UPSTREAM);
    const opencode = validEntries(parsed.opencode, openCodeFreeId);
    if (!kilo.length && !opencode.length) return STATIC_FREE_POOL_CATALOG;
    return {
      source: "live",
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : undefined,
      kilo,
      opencode,
    };
  } catch {
    return STATIC_FREE_POOL_CATALOG;
  }
}

function gatewaySafe(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Kilo's own preference first, then the bigger window. Its catch-all
// `openrouter/free` router goes after every specific model, and a window too
// small for a normal turn goes last.
function kiloOrder(entries) {
  return [...entries].sort((left, right) => {
    const rank = (entry) => (entry.id === "openrouter/free" ? 1 : 0) +
      ((entry.contextLength ?? SMALL_CONTEXT) < SMALL_CONTEXT ? 2 : 0);
    const byRank = rank(left) - rank(right);
    if (byRank) return byRank;
    const leftPreferred = left.preferredIndex ?? Number.POSITIVE_INFINITY;
    const rightPreferred = right.preferredIndex ?? Number.POSITIVE_INFINITY;
    if (leftPreferred !== rightPreferred) return leftPreferred < rightPreferred ? -1 : 1;
    const byWindow = (right.contextLength ?? 0) - (left.contextLength ?? 0);
    if (byWindow) return byWindow;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

const MEMBER_REASONING = Object.freeze([
  Object.freeze({ effort: "low", description: "Fast reasoning for simple edits" }),
  Object.freeze({ effort: "medium", description: "Balanced reasoning for everyday coding" }),
  Object.freeze({ effort: "high", description: "Deep reasoning for harder problems" }),
]);

function memberModel({ provider, slug, gatewayModel, entry, lane }) {
  const contextWindow = entry.contextLength ?? SMALL_CONTEXT;
  return {
    slug,
    gatewayModel,
    upstreamModel: entry.id,
    provider,
    listed: false,
    isFree: true,
    failoverCandidate: false,
    freePoolMember: true,
    displayName: `${entry.id} (free/auto ${lane})`,
    description: `A member of the free/auto pool, served anonymously by ${lane}.`,
    defaultEffort: "medium",
    reasoningLevels: MEMBER_REASONING.map((level) => ({ ...level })),
    contextWindow,
    autoCompact: Math.floor(contextWindow * 0.9),
    inputModalities: entry.image ? ["text", "image"] : ["text"],
  };
}

// Every member, in the order the pool tries them after its own entry.
export function freePoolMemberModels(catalog = readFreePoolCatalog()) {
  const kilo = kiloOrder(catalog.kilo || []).map((entry) => memberModel({
    provider: FREE_POOL_PROVIDER,
    slug: `${FREE_POOL_PROVIDER}/${entry.id}`,
    gatewayModel: `free-kilo-${gatewaySafe(entry.id)}`,
    entry,
    lane: "Kilo",
  }));
  const opencode = (catalog.opencode || []).map((entry) => memberModel({
    provider: FREE_POOL_OPENCODE_PROVIDER,
    slug: `${FREE_POOL_OPENCODE_PROVIDER}/${entry.id}`,
    gatewayModel: `free-opencode-${gatewaySafe(entry.id)}`,
    entry,
    lane: "OpenCode Zen",
  }));
  return [...kilo, ...opencode];
}
