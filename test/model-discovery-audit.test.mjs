import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { providerCatalogKind } = await import("../src/provider-catalogs.mjs");
const {
  auditCatalogSourceIds,
  auditProviderModels,
  redactAuditError,
  renderAuditMarkdown,
} = await import("../src/model-discovery-audit.mjs");

test("the audit folds same-endpoint variants and keeps distinct family catalogs", () => {
  const opencode = auditCatalogSourceIds("opencode-go");
  assert.deepEqual(opencode, ["opencode-go", "opencode-zen"]);
  assert.deepEqual(auditCatalogSourceIds("opencode-go-messages"), ["opencode-go"]);
  assert.deepEqual(auditCatalogSourceIds("opencode-zen"), ["opencode-zen"]);
  assert.equal(new Set(auditCatalogSourceIds("all")).size, auditCatalogSourceIds("all").length);
});

test("the audit preserves successes when another configured provider fails", async () => {
  const secret = "audit-secret-value";
  const audit = await auditProviderModels({
    requested: "deepseek,kimi-api",
    generatedAt: "2026-08-25T00:00:00.000Z",
    readiness: () => ({ ready: true }),
    credentialResolver: () => ({ value: secret }),
    discover: async (providerId) => {
      if (providerId === "kimi-api") {
        throw new Error(`Authorization: Bearer ${secret}`);
      }
      return {
        discovered: ["new-model", "deepseek-v4-pro", "new-model"],
        registered: ["deepseek-v4-pro"],
        unregistered: ["new-model"],
        addable: ["new-model"],
        blocked: {},
        unavailable: [],
        contextLengths: { "new-model": 200_000 },
        metadata: {
          "new-model": {
            contextWindow: 200_000,
            reasoning: { supported: true, configurable: true, supportedEfforts: ["low", "high"] },
            metadataSource: "provider-catalog",
          },
        },
      };
    },
  });
  assert.deepEqual(audit.summary, {
    catalogs: 2,
    succeeded: 1,
    skipped: 0,
    failed: 1,
    models: 2,
    unregistered: 1,
    unavailable: 0,
  });
  assert.deepEqual(audit.results[0].models, ["deepseek-v4-pro", "new-model"]);
  assert.equal(audit.results[0].metadata["new-model"].contextWindow, 200_000);
  assert.equal(audit.results[1].status, "failed");
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(secret));
  assert.match(audit.results[1].error, /\[redacted\]/);
});

test("missing credentials are reported as skips without attempting discovery", async () => {
  let calls = 0;
  const audit = await auditProviderModels({
    requested: "deepseek",
    generatedAt: "2026-08-25T00:00:00.000Z",
    readiness: () => ({ ready: false, reason: "No repository secret is configured." }),
    discover: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(calls, 0);
  assert.equal(audit.summary.skipped, 1);
  assert.equal(audit.results[0].status, "skipped");
});

test("fixture-backed CLI output is deterministic and never edits the registry", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "codex-router-model-audit-"));
  const fixture = path.join(temporary, "deepseek.json");
  const first = path.join(temporary, "first.json");
  const second = path.join(temporary, "second.json");
  const registryBefore = readFileSync(path.join(root, "config/deepseek/deepseek.json"), "utf8");
  writeFileSync(fixture, JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "future-model" }] }));
  const command = [
    "src/model-discovery-audit.mjs",
    "--provider", "deepseek",
    "--fixture-dir", temporary,
    "--generated-at", "2026-08-25T00:00:00Z",
  ];
  try {
    execFileSync(process.execPath, [...command, "--output", first], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ROUTER_STATE_DIR: path.join(temporary, "empty-state"),
        DEEPSEEK_API_KEY: "",
      },
    });
    execFileSync(process.execPath, [...command, "--output", second], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ROUTER_STATE_DIR: path.join(temporary, "empty-state"),
        DEEPSEEK_API_KEY: "",
      },
    });
    assert.equal(readFileSync(first, "utf8"), readFileSync(second, "utf8"));
    const audit = JSON.parse(readFileSync(first, "utf8"));
    assert.deepEqual(audit.results[0].models, ["deepseek-v4-pro", "future-model"]);
    assert.deepEqual(audit.results[0].unregistered, ["future-model"]);
    assert.equal(
      readFileSync(path.join(root, "config/deepseek/deepseek.json"), "utf8"),
      registryBefore,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the audit markdown summarizes drift without exposing multiline output", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `future-${index + 1}`);
  const audit = await auditProviderModels({
    requested: "deepseek",
    generatedAt: "2026-08-25T00:00:00.000Z",
    readiness: () => ({ ready: true }),
    discover: async () => ({
      discovered: ["future|model", ...ids],
      registered: [],
      unregistered: ["future|model", ...ids],
      addable: ["future|model", ...ids],
      blocked: {},
      unavailable: [],
      contextLengths: {},
    }),
  });
  const markdown = renderAuditMarkdown(audit);
  assert.match(markdown, /\| deepseek \| succeeded \| 13 \| 13 \| 0 \|/);
  assert.match(markdown, /\(\+5 more\)/);
  assert.doesNotMatch(markdown, /future-9/);
  assert.match(markdown, /never edits the registry/);
});

test("generic audit error redaction covers bearer and API-key assignments", () => {
  const message = redactAuditError("Bearer abcdef API_KEY=ghijkl");
  assert.equal(message, "Bearer [redacted] API_KEY=[redacted]");
});

test("ADC-backed catalogs are skipped instead of borrowing repository secrets", async () => {
  const audit = await auditProviderModels({
    requested: "vertex",
    discover: async () => {
      throw new Error("Vertex discovery must not run in the repository audit.");
    },
    credentialResolver: () => {
      throw new Error("Vertex must not ask the repository audit for an API key.");
    },
  });
  assert.deepEqual(audit.results, [{
    provider: "vertex",
    displayName: "Google Cloud Vertex AI",
    status: "skipped",
    reason: "This catalog requires local Google Cloud ADC and cannot use a repository API-key secret.",
  }]);
});

test("the discovery workflow keeps live secrets away from pull-request code", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/model-discovery.yml"), "utf8");
  assert.match(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*schedule:/m);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /node --test test\/model-discovery-audit\.test\.mjs test\/model-discovery\.test\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /if: always\(\)/);
  const auditStep = workflow.indexOf("name: Audit official provider model lists");
  assert.ok(auditStep > 0);
  assert.doesNotMatch(
    workflow.slice(0, auditStep),
    /\$\{\{ secrets\./,
    "provider secrets must be scoped to the live audit step",
  );
  for (const provider of PROVIDERS.values()) {
    if (
      provider.variantOf ||
      provider.credential?.resolver ||
      providerCatalogKind(provider) !== "models-endpoint" ||
      provider.authMode === "anonymous" ||
      provider.keyless
    ) continue;
    const names = provider.credential?.environment || [];
    assert.ok(
      names.some((name) => workflow.includes(`secrets.${name}`)),
      `${provider.id} has no repository secret mapping in the live audit step`,
    );
  }
});
