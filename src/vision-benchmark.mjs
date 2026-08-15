import { readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { describeImage, localVisionEngine } from "./vision-bridge.mjs";
import {
  LOCAL_VISION_CATALOG,
  ollamaInstalledModels,
  probeLocalServer,
} from "./vision-host.mjs";

// The picker labels a model's accuracy, so the label has to be earned rather
// than guessed: every candidate reads one checked-in image whose contents are
// known exactly, and the score is how much of that ground truth comes back
// verbatim. Two of the best-known local vision models fail this badly, which
// is precisely why the claim needs measuring.
export const BENCHMARK_IMAGE_PATH = path.join(
  SOURCE_ROOT,
  "test",
  "fixtures",
  "vision-benchmark.png",
);

// Strings a genuine reader returns and a captioner invents. Grouped so a model
// that nails prose but fabricates numbers is visible as exactly that.
export const BENCHMARK_GROUND_TRUTH = Object.freeze({
  codes: ["INV-7734-QX", "RC-2291-BB77", "Widget A-12", "Cable K-9"],
  numbers: ["3,417.62", "1,155.00", "162.60", "2,100.02", "82.50", "27.10"],
  dates: ["2026-03-14", "2026-04-13"],
  shapes: ["pentagon", "circle"],
  colors: ["purple", "green"],
});

// Currency and thousands separators drift between models ("$1,155.00" vs
// "1155.00"), so compare on a normalized form rather than punishing formatting.
function normalize(text) {
  return String(text).toLowerCase().replace(/[\s$,]/g, "");
}

export function scoreTranscript(transcript) {
  const haystack = normalize(transcript);
  const groups = {};
  let found = 0;
  let total = 0;
  for (const [group, expected] of Object.entries(BENCHMARK_GROUND_TRUTH)) {
    const hits = expected.filter((value) => haystack.includes(normalize(value)));
    groups[group] = { found: hits.length, total: expected.length, missed: expected.filter((v) => !hits.includes(v)) };
    found += hits.length;
    total += expected.length;
  }
  const percent = total ? Math.round((found / total) * 100) : 0;
  // Text is the number that decides whether a model is safe to trust, so it is
  // reported alongside the overall score rather than recomputed by callers.
  const textFound =
    (groups.codes?.found || 0) + (groups.numbers?.found || 0) + (groups.dates?.found || 0);
  const textTotal =
    (groups.codes?.total || 0) + (groups.numbers?.total || 0) + (groups.dates?.total || 0);
  const textPercent = textTotal ? Math.round((textFound / textTotal) * 100) : 0;
  return { percent, textPercent, found, total, groups };
}

// Text accuracy is what the bridge actually needs: a model that describes the
// shapes but invents the invoice number is worse than useless, because the
// downstream model repeats the invention as fact.
export function accuracyTier({ textPercent = 0 }) {
  if (textPercent >= 80) return "accurate";
  if (textPercent >= 40) return "partial";
  return "captions-only";
}

// Results are persisted so a model the operator downloaded and tested keeps its
// earned label across restarts, and so the picker can show a measured score for
// models that were never in the curated list at all.
export const BENCHMARK_RESULTS_PATH =
  process.env.MODEL_ROUTER_VISION_BENCHMARKS ||
  path.join(STATE_DIR, "vision-benchmarks.json");

export function readBenchmarkResults() {
  try {
    const parsed = JSON.parse(readFileSync(BENCHMARK_RESULTS_PATH, "utf8"));
    return parsed?.version === 1 && parsed.results ? parsed.results : {};
  } catch {
    return {};
  }
}

export function saveBenchmarkResult(tag, result) {
  const results = { ...readBenchmarkResults(), [tag]: result };
  writePrivateJson(BENCHMARK_RESULTS_PATH, { version: 1, results });
  return results;
}

export async function benchmarkModel(tag, { baseUrl, timeoutMs = 300_000 } = {}) {
  const engine = localVisionEngine({ local: { model: tag, baseUrl } });
  const dataUri = `data:image/png;base64,${readFileSync(BENCHMARK_IMAGE_PATH).toString("base64")}`;
  const startedAt = Date.now();
  try {
    const transcript = await describeImage({
      engine,
      imageUrl: dataUri,
      gatewayBase: "http://unused/v1",
      headers: {},
      timeoutMs,
    });
    const score = scoreTranscript(transcript);
    return {
      tag,
      ok: true,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      ...score,
      tier: accuracyTier(score),
      transcript,
    };
  } catch (error) {
    return {
      tag,
      ok: false,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const only = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const asJson = process.argv.includes("--json");
  const server = await probeLocalServer();
  if (!server.reachable) {
    throw new Error(`No local runtime at ${server.baseUrl} (${server.error}).`);
  }
  const installed = ollamaInstalledModels();
  const catalogTags = LOCAL_VISION_CATALOG.map((model) => model.tag);
  // Only benchmark what is already on disk: this must never trigger a
  // multi-gigabyte download as a side effect of measuring.
  const candidates = (only.length ? only : catalogTags).filter((tag) =>
    installed.some((name) => name === tag || name === `${tag}:latest`),
  );
  if (!candidates.length) {
    throw new Error(
      `None of the catalog models are installed. Pull one first, e.g. \`ollama pull qwen2.5vl:3b\`.`,
    );
  }
  const results = [];
  for (const tag of candidates) {
    if (!asJson) process.stderr.write(`benchmarking ${tag}…\n`);
    results.push(await benchmarkModel(tag, { baseUrl: server.baseUrl }));
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`\n${"model".padEnd(24)}${"score".padEnd(8)}${"tier".padEnd(16)}time\n`);
  for (const result of results) {
    if (!result.ok) {
      process.stdout.write(`${result.tag.padEnd(24)}${"error".padEnd(24)}${result.error}\n`);
      continue;
    }
    process.stdout.write(
      `${result.tag.padEnd(24)}${`${result.percent}%`.padEnd(8)}${result.tier.padEnd(16)}${result.seconds}s\n`,
    );
    for (const [group, detail] of Object.entries(result.groups)) {
      if (detail.found === detail.total) continue;
      process.stdout.write(
        `  ${group}: ${detail.found}/${detail.total} — missed ${detail.missed.join(", ")}\n`,
      );
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
