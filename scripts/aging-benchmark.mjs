#!/usr/bin/env node
// Harvest tool-result aging benchmark series from usage-events.jsonl.
//
//   node scripts/aging-benchmark.mjs [--since-line N] [--model SLUG] [--json out.json]
//
// --model filters every series to one slug (e.g. gpt-5.6-sol), which is the
// primary benchmark target: native GPT reports cachedInputTokens, so its
// cache-rate series is measured rather than inferred.
//
// Emits three series for the benchmark report:
//   1. saved   — measured bytes removed per turn (est. tokens = bytes/4)
//   2. cache   — cachedInputTokens/inputTokens per turn where both reported
//   3. spend   — per-turn cost from PRICE_TABLE, plus a no-compaction
//                counterfactual band (saved tokens at cached vs full price)
//
// Prices are USD per million tokens and editable: plan-billed providers
// (ChatGPT plan, Grok OAuth) have no per-token invoice, so their rows are
// list-price proxies for comparability, and the report must say so.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EVENTS_PATH =
  process.env.MODEL_ROUTER_USAGE_EVENTS ||
  path.join(os.homedir(), ".codex", "codex-router", "usage-events.jsonl");
const BYTES_PER_TOKEN = 4;
const CACHED_DISCOUNT = 0.1;

// { input, output } USD per 1M tokens. Cached input = input * CACHED_DISCOUNT.
const PRICE_TABLE = {
  "gpt-5.6-sol": { input: 1.25, output: 10 },
  "gpt-5.6-luna": { input: 1.25, output: 10 },
  "gpt-5.6-terra": { input: 1.25, output: 10 },
  "grok-oauth/grok-4.5": { input: 3, output: 15 },
  "grok-oauth/grok-4.6": { input: 3, output: 15 },
  default: { input: 1, output: 5 },
};

function parseArgs(argv) {
  const args = { sinceLine: 0, model: undefined, json: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--since-line") args.sinceLine = Number(argv[++index]) || 0;
    if (argv[index] === "--model") args.model = argv[++index];
    if (argv[index] === "--json") args.json = argv[++index];
  }
  return args;
}

function price(model) {
  return PRICE_TABLE[model] ?? PRICE_TABLE.default;
}

function turnCost(event) {
  const rate = price(event.model);
  const input = event.inputTokens ?? 0;
  const cached = Math.min(event.cachedInputTokens ?? 0, input);
  const uncached = input - cached;
  const output = event.outputTokens ?? 0;
  return (
    (uncached * rate.input + cached * rate.input * CACHED_DISCOUNT + output * rate.output) /
    1_000_000
  );
}

const args = parseArgs(process.argv.slice(2));
const lines = readFileSync(EVENTS_PATH, "utf8").split("\n").filter(Boolean);
const events = lines
  .slice(args.sinceLine)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((event) => event && event.status === 200 && typeof event.at === "string")
  .filter((event) => !args.model || event.model === args.model);

const saved = [];
const cache = [];
const spend = [];
let cumulativeSavedTokens = 0;
let cumulativeCost = 0;
let counterfactualLow = 0;
let counterfactualHigh = 0;
const receiptSeen = new Map();

for (const event of events) {
  const isNative = event.provider === "openai";
  const savedTokens = Math.round((event.toolResultBytesSaved ?? 0) / BYTES_PER_TOKEN);
  cumulativeSavedTokens += savedTokens;
  if (savedTokens) {
    saved.push({
      at: event.at,
      model: event.model,
      native: isNative,
      savedTokens,
      cumulativeSavedTokens,
      resultsAged: event.toolResultsAged ?? 0,
    });
  }

  if ((event.inputTokens ?? 0) > 0 && event.cachedInputTokens !== undefined) {
    // Fresh vs stable classification: a turn whose (count, bytes) aging
    // signature repeats the previous turn for that model resends receipts
    // byte-identically; a new signature means a fresh compaction this turn.
    const signature = `${event.toolResultsAged ?? 0}:${event.toolResultBytesSaved ?? 0}`;
    const previous = receiptSeen.get(event.model);
    receiptSeen.set(event.model, signature);
    const kind = !event.toolResultsAged
      ? "unaged"
      : previous === signature
        ? "stable"
        : "fresh";
    cache.push({
      at: event.at,
      model: event.model,
      native: isNative,
      kind,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      rate: event.cachedInputTokens / event.inputTokens,
    });
  }

  const cost = turnCost(event);
  cumulativeCost += cost;
  const rate = price(event.model);
  counterfactualLow += cost + (savedTokens * rate.input * CACHED_DISCOUNT) / 1_000_000;
  counterfactualHigh += cost + (savedTokens * rate.input) / 1_000_000;
  spend.push({
    at: event.at,
    model: event.model,
    native: isNative,
    cost,
    cumulativeCost,
    counterfactualLow,
    counterfactualHigh,
  });
}

const agedCache = cache.filter((turn) => turn.kind !== "unaged");
const summary = {
  eventsAnalyzed: events.length,
  window: events.length ? { from: events[0].at, to: events.at(-1).at } : undefined,
  savedTokensTotal: cumulativeSavedTokens,
  turnsWithAging: saved.length,
  cacheRate: {
    overall: rateOf(cache),
    unaged: rateOf(cache.filter((turn) => turn.kind === "unaged")),
    agedStable: rateOf(cache.filter((turn) => turn.kind === "stable")),
    agedFresh: rateOf(cache.filter((turn) => turn.kind === "fresh")),
    agedTurnsMeasured: agedCache.length,
  },
  spendUsd: {
    actual: round(cumulativeCost),
    withoutCompactionLow: round(counterfactualLow),
    withoutCompactionHigh: round(counterfactualHigh),
  },
};

function rateOf(turns) {
  const input = turns.reduce((total, turn) => total + turn.inputTokens, 0);
  const cached = turns.reduce((total, turn) => total + turn.cachedInputTokens, 0);
  return input ? round(cached / input) : null;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

const report = { generatedFromLine: args.sinceLine, summary, saved, cache, spend };
if (args.json) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${args.json}\n`);
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
