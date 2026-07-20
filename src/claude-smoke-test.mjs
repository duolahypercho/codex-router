import { existsSync, readFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, PORTS, TARGET, loopback } from "./paths.mjs";
import { providerForModel } from "./model-registry.mjs";
import { selectedListedModels } from "./provider-selection.mjs";

if (TARGET !== "claude") {
  throw new Error("claude-smoke-test.mjs requires MODEL_ROUTER_TARGET=claude.");
}
if (!process.argv.includes("--yes")) {
  console.error("This test sends billed provider requests. Re-run with --yes to continue.");
  process.exit(2);
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error("The Claude caller key is missing; run setup first.");
}

const callerKey = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const models = selectedListedModels();
const seenProviders = new Set();
const results = [];

for (const model of models) {
  if (seenProviders.has(model.provider)) continue;
  seenProviders.add(model.provider);
  const response = await fetch(`${loopback(PORTS.router)}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${callerKey}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.slug,
      max_tokens: 8,
      messages: [{ role: "user", content: "." }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({}));
  const ok = response.ok && payload?.type === "message";
  results.push({
    provider: providerForModel(model).id,
    model: model.slug,
    ok,
    status: response.status,
  });
}

process.stdout.write(`${JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2)}\n`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
