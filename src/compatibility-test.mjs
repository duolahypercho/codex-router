import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import {
  checkpointFromRenderedText,
  decodeCompaction,
} from "./compaction-checkpoint.mjs";
import { EXACT_ROUTE_PROBE_HEADER } from "./exact-route-probe.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { installedRouterBaseUrl } from "./smoke-test.mjs";

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text)
    .filter((value) => typeof value === "string")
    .join("\n");
}

async function request(suffix, body, timeoutMs = 180_000) {
  const response = await fetch(`${installedRouterBaseUrl()}${suffix}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-compatibility-test",
      "Content-Type": "application/json",
      [EXACT_ROUTE_PROBE_HEADER]: "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function reasoningFields(reasoningEffort) {
  return reasoningEffort
    ? {
        reasoning: { effort: reasoningEffort },
        reasoning_effort: reasoningEffort,
      }
    : {};
}

async function basicResponse(model, reasoningEffort) {
  const marker = "CODEX_ROUTER_SMOKE_OK";
  const { response, payload } = await request("/responses", {
    model,
    stream: false,
    input: `Reply with exactly ${marker} and nothing else.`,
    ...reasoningFields(reasoningEffort),
  });
  const text = responseText(payload);
  return {
    ok: response.ok && text.includes(marker),
    status: response.status,
    detail: response.ok && text.includes(marker)
      ? "live response marker verified"
      : payload?.error?.message || `HTTP ${response.status}`,
  };
}

async function toolCall(model, reasoningEffort) {
  const { response, payload } = await request("/responses", {
    model,
    stream: false,
    input: "Call codex_router_probe exactly once with value set to ok. Do not answer normally.",
    tools: [
      {
        type: "function",
        name: "codex_router_probe",
        description: "Compatibility probe",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: "required",
    ...reasoningFields(reasoningEffort),
  });
  const call = (payload?.output || []).find(
    (item) => item?.type === "function_call" && item?.name === "codex_router_probe",
  );
  let argumentsValid = false;
  try {
    argumentsValid = JSON.parse(call?.arguments || "{}").value === "ok";
  } catch {
    // Invalid tool arguments are a compatibility failure.
  }
  return {
    ok: response.ok && Boolean(call) && argumentsValid,
    status: response.status,
    detail: call && argumentsValid ? "function call and JSON arguments verified" : responseText(payload) || payload?.error?.message || "function call missing",
  };
}

async function streaming(model, reasoningEffort) {
  const marker = "CODEX_ROUTER_STREAM_OK";
  const response = await fetch(`${installedRouterBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-compatibility-test",
      "Content-Type": "application/json",
      [EXACT_ROUTE_PROBE_HEADER]: "1",
    },
    body: JSON.stringify({
      model,
      stream: true,
      input: `Reply with exactly ${marker} and nothing else.`,
      ...reasoningFields(reasoningEffort),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  const streamedText = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => {
      try {
        const event = JSON.parse(line);
        return event.delta || event.text || event.output_text || "";
      } catch {
        return "";
      }
    })
    .join("");
  const completed = /response\.(?:completed|done)|\[DONE\]/.test(body);
  return {
    ok: response.ok && (body.includes(marker) || streamedText.includes(marker)) && completed,
    status: response.status,
    detail: response.ok ? "stream text and completion event verified" : `HTTP ${response.status}`,
  };
}

async function statelessToolResult(model, reasoningEffort) {
  // The marker exists only in the tool result. If a translation layer drops
  // the call/result pair, a plausible ordinary answer must not pass this
  // check merely because the user prompt disclosed the expected value.
  const marker = `CODEX_ROUTER_TOOL_RESULT_${randomUUID().replaceAll("-", "")}`;
  const { response, payload } = await request("/responses", {
    model,
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Read the completed codex_router_probe result below and reply with exactly its output value.",
        }],
      },
      {
        type: "function_call",
        id: "fc_codex_router_probe",
        call_id: "call_codex_router_probe",
        name: "codex_router_probe",
        arguments: "{\"value\":\"pending\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_codex_router_probe",
        output: marker,
      },
    ],
    tools: [
      {
        type: "function",
        name: "codex_router_probe",
        description: "Compatibility probe",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    ...reasoningFields(reasoningEffort),
  });
  const text = responseText(payload);
  const markerReceived = text.includes(marker);
  return {
    ok: response.ok && markerReceived,
    status: response.status,
    detail: response.ok && markerReceived
      ? "stateless tool-result-backed response verified"
      : payload?.error?.message || (response.ok
          ? "stateless tool-result marker missing"
          : `HTTP ${response.status}`),
  };
}

function itemText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part) =>
      ["input_text", "output_text", "text"].includes(part?.type) &&
      typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function compactionCheckpoint(payload) {
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type === "compaction") {
      const decoded = decodeCompaction(item.encrypted_content);
      if (decoded?.kind === "checkpoint") return decoded.checkpoint;
      continue;
    }
    const checkpoint = checkpointFromRenderedText(itemText(item));
    if (checkpoint) return checkpoint;
  }
  return undefined;
}

async function compaction(model, reasoningEffort) {
  const marker = `CODEX_ROUTER_COMPACT_${randomUUID().replaceAll("-", "")}`;
  const { response, payload } = await request("/responses/compact", {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `Preserve the exact opaque token ${marker} verbatim in the checkpoint objective.`,
        }],
      },
    ],
    ...reasoningFields(reasoningEffort),
  });
  const checkpoint = compactionCheckpoint(payload);
  const markerReceived = checkpoint?.orientation?.objective?.includes(marker) === true;
  return {
    ok: response.ok && markerReceived,
    status: response.status,
    detail: response.ok && markerReceived
      ? "compaction checkpoint objective verified"
      : payload?.error?.message || (response.ok
          ? "compaction checkpoint objective marker missing"
          : `HTTP ${response.status}`),
  };
}

// The two capabilities a Codex spawn actually exercises, and nothing else:
// a child turn is a streamed conversation driven by tool calls, so a model
// that streams and answers a forced tool call can hold the child role. Basic
// text and compaction stay out — this probe runs automatically when a model
// is switched on as a subagent, and two requests is its whole quota budget.
export async function subagentCapabilityProbe(model) {
  if (!MODEL_BY_SLUG.has(model)) throw new Error(`Unknown registry model: ${model}`);
  const checks = [
    { name: "tool calling", ...(await toolCall(model)) },
    { name: "streaming", ...(await streaming(model)) },
  ];
  return {
    model,
    ok: checks.every((check) => check.ok),
    checks,
    detail: checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; "),
  };
}

export async function compatibilityTest(model, options = {}) {
  if (!MODEL_BY_SLUG.has(model)) throw new Error(`Unknown registry model: ${model}`);
  const reasoningEffort = options.reasoningEffort;
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unknown reasoning effort: ${reasoningEffort}`);
  }
  const results = [];
  results.push({ name: "basic response", ...(await basicResponse(model, reasoningEffort)) });
  if (!options.quick) {
    results.push({ name: "streaming", ...(await streaming(model, reasoningEffort)) });
    results.push({ name: "tool calling", ...(await toolCall(model, reasoningEffort)) });
    results.push({
      name: "stateless tool result",
      ...(await statelessToolResult(model, reasoningEffort)),
    });
    results.push({ name: "compaction", ...(await compaction(model, reasoningEffort)) });
  }
  return { model, ok: results.every((result) => result.ok), results };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: test-model MODEL --live --yes [--quick] [--json] [--effort=RUNG]

Runs billed live checks for text, streaming, tool calling, stateless tool-result
replay, and compaction through the installed router. Both --live and --yes are
required to prevent accidental provider charges. --quick runs only the basic
response check. --effort sends both Codex effort spellings so a model-scoped
request profile is exercised on the live route.
`);
    return;
  }
  const model = process.argv.slice(2).find((value) => !value.startsWith("--"));
  if (!model) throw new Error("Pass a namespaced registry model id.");
  if (!process.argv.includes("--live") || !process.argv.includes("--yes")) {
    throw new Error("Live compatibility checks may use provider quota; pass --live --yes to confirm.");
  }
  const effortArgument = process.argv.find((value) => value.startsWith("--effort="));
  const result = await compatibilityTest(model, {
    quick: process.argv.includes("--quick"),
    reasoningEffort: effortArgument?.slice("--effort=".length),
  });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.results) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail || check.error}\n`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      redactCallerUrl(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  });
}
