import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  installedRouterBaseUrl,
  smokeTestModel,
} from "./smoke-test.mjs";

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
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function toolCall(model) {
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

async function streaming(model) {
  const marker = "CODEX_ROUTER_STREAM_OK";
  const response = await fetch(`${installedRouterBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-compatibility-test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      input: `Reply with exactly ${marker} and nothing else.`,
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

async function compaction(model) {
  const { response, payload } = await request("/responses/compact", {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Remember that the probe value is 42." }],
      },
    ],
  });
  const text = responseText(payload);
  return {
    ok: response.ok && Boolean(text),
    status: response.status,
    detail: response.ok && text ? "compaction response verified" : payload?.error?.message || `HTTP ${response.status}`,
  };
}

export async function compatibilityTest(model, options = {}) {
  if (!MODEL_BY_SLUG.has(model)) throw new Error(`Unknown registry model: ${model}`);
  const results = [];
  const basic = await smokeTestModel(model);
  results.push({ name: "basic response", ...basic });
  if (!options.quick) {
    results.push({ name: "streaming", ...(await streaming(model)) });
    results.push({ name: "tool calling", ...(await toolCall(model)) });
    results.push({ name: "compaction", ...(await compaction(model)) });
  }
  return { model, ok: results.every((result) => result.ok), results };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: test-model MODEL --live --yes [--quick] [--json]

Runs billed live checks for text, streaming, tool calling, and compaction through
the installed router. Both --live and --yes are required to prevent accidental
provider charges. --quick runs only the basic response check.
`);
    return;
  }
  const model = process.argv.slice(2).find((value) => !value.startsWith("--"));
  if (!model) throw new Error("Pass a namespaced registry model id.");
  if (!process.argv.includes("--live") || !process.argv.includes("--yes")) {
    throw new Error("Live compatibility checks may use provider quota; pass --live --yes to confirm.");
  }
  const result = await compatibilityTest(model, { quick: process.argv.includes("--quick") });
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
