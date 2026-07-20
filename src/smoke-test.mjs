import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCallerSecret,
  callerBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import { selectedListedModels } from "./provider-selection.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const values = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") values.push(part.text);
    }
  }
  return values.join("\n");
}

export function installedRouterBaseUrl(override) {
  const supplied = override || process.env.CODEX_ROUTER_BASE_URL;
  if (supplied) return String(supplied).replace(/\/+$/, "");
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  const callerKey = assertCallerSecret(
    readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
  );
  return callerBaseUrl(PORTS.router, callerKey);
}

export async function smokeTestModel(model, options = {}) {
  const baseUrl = installedRouterBaseUrl(options.baseUrl);
  const marker = options.marker || "CODEX_ROUTER_SMOKE_OK";
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-smoke-test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: `Reply with exactly ${marker} and nothing else.`,
      stream: false,
    }),
    signal: AbortSignal.timeout(Number(options.timeoutMs || 180_000)),
  });
  const payload = await response.json().catch(() => ({}));
  const text = responseText(payload);
  return {
    ok: response.ok && text.includes(marker),
    model,
    status: response.status,
    markerReceived: text.includes(marker),
    error: response.ok ? undefined : payload?.error?.message || `HTTP ${response.status}`,
  };
}

async function main() {
  const requested = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const models = requested.length
    ? requested
    : [...new Map(selectedListedModels().map((model) => [model.provider, model.slug])).values()];
  if (models.length === 0) throw new Error("No enabled provider models are available to test.");
  const results = [];
  for (const model of models) results.push(await smokeTestModel(model));
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(
        `${result.ok ? "PASS" : "FAIL"} ${result.model}: ${
          result.ok ? "live response verified" : result.error || "marker missing"
        }\n`,
      );
    }
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      redactCallerUrl(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  });
}
