import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { normalizeLocalModelTag } from "./local-model-ref.mjs";
import { ollamaRootUrl } from "./ollama-runtime.mjs";

export const LOCAL_BENCHMARKS_PATH =
  process.env.MODEL_ROUTER_LOCAL_BENCHMARKS ||
  path.join(STATE_DIR, "local-model-benchmarks.json");

export function readLocalBenchmarks() {
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_BENCHMARKS_PATH, "utf8"));
    return parsed?.version === 1 && parsed.results ? parsed.results : {};
  } catch {
    return {};
  }
}
export function writeLocalBenchmarks(results) {
  writePrivateJson(LOCAL_BENCHMARKS_PATH, { version: 1, results }, { directoryMode: 0o700 });
  return results;
}

function durationSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number / 1e9 : undefined;
}

function tokensPerSecond(tokens, duration) {
  const count = Number(tokens);
  const seconds = durationSeconds(duration);
  if (!Number.isFinite(count) || count <= 0 || !seconds) return undefined;
  return Math.round((count / seconds) * 10) / 10;
}

async function runProbe(tag, { baseUrl, fetchImpl, timeoutMs, maxTokens }) {
  const root = ollamaRootUrl(baseUrl);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(`${root}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: tag,
        messages: [{ role: "user", content: "Reply with exactly: benchmark ready" }],
        stream: false,
        options: { num_predict: maxTokens, temperature: 0 },
      }),
    });
  } catch {
    throw new Error("Could not reach Ollama while benchmarking the model.");
  }
  if (!response.ok) throw new Error(`Ollama refused the benchmark (HTTP ${response.status}).`);
  const body = await response.json();
  const evalSeconds = durationSeconds(body.eval_duration);
  const evalTokensPerSecond = tokensPerSecond(body.eval_count, body.eval_duration);
  const promptTokensPerSecond = tokensPerSecond(body.prompt_eval_count, body.prompt_eval_duration);
  return {
    startedAt,
    completedAt: Date.now(),
    totalSeconds: durationSeconds(body.total_duration) || (Date.now() - startedAt) / 1000,
    loadSeconds: durationSeconds(body.load_duration) || null,
    evalSeconds: evalSeconds || null,
    promptTokensPerSecond: promptTokensPerSecond || null,
    tokensPerSecond: evalTokensPerSecond || null,
    evalTokens: Number.isFinite(Number(body.eval_count)) ? Number(body.eval_count) : null,
    promptTokens: Number.isFinite(Number(body.prompt_eval_count)) ? Number(body.prompt_eval_count) : null,
  };
}

export async function benchmarkLocalModel(
  input,
  {
    baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || "http://127.0.0.1:11434",
    fetchImpl = fetch,
    timeoutMs = 180_000,
    maxTokens = 64,
    save = true,
  } = {},
) {
  const tag = normalizeLocalModelTag(input);
  const result = await runProbe(tag, { baseUrl, fetchImpl, timeoutMs, maxTokens });
  const stored = {
    ...result,
    tag,
    measuredAt: Date.now(),
    speedStatus: result.tokensPerSecond ? "measured" : "unavailable",
  };
  if (save) writeLocalBenchmarks({ ...readLocalBenchmarks(), [tag]: stored });
  return stored;
}
