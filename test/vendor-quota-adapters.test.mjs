import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "vendor-quota-state-"));
const registryPath = path.join(stateDir, "registry.json");
writeFileSync(registryPath, JSON.stringify({
  version: 1,
  providers: [
    {
      id: "zai-coding",
      displayName: "Z.ai GLM Coding Plan",
      kind: "openai-compatible",
      ownedBy: "zai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      baseUrlEnv: "ZAI_CODING_BASE_URL",
      credential: {
        environment: ["ZAI_API_KEY"],
        file: "zai-coding-api-key.secret",
        prompt: "Z.ai GLM Coding Plan API key",
      },
    },
    {
      id: "qwen-plan",
      displayName: "Qwen (Alibaba Plan)",
      kind: "openai-compatible",
      ownedBy: "alibaba",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      baseUrlEnv: "QWEN_PLAN_BASE_URL",
      credential: {
        environment: ["QWEN_PLAN_API_KEY"],
        file: "qwen-plan-api-key.secret",
        prompt: "Alibaba Model Studio plan API key",
      },
    },
    {
      id: "ollama-cloud",
      displayName: "Ollama Cloud",
      kind: "openai-compatible",
      ownedBy: "ollama",
      baseUrl: "https://ollama.com/v1",
      baseUrlEnv: "OLLAMA_CLOUD_BASE_URL",
      credential: {
        environment: ["OLLAMA_API_KEY"],
        file: "ollama-cloud-api-key.secret",
        prompt: "Ollama Cloud API key",
      },
    },
  ],
  models: [],
}));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_REGISTRY = registryPath;

const {
  providerAccountUsageSnapshot,
  zaiQuotaMetrics,
} = await import("../src/provider-account-usage.mjs");

test("normalizes z.ai time and token quota windows", () => {
  assert.deepEqual(zaiQuotaMetrics({
    planName: "GLM Coding Pro",
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 3,
        number: 5,
        usage: 100,
        currentValue: 37,
        remaining: 63,
        percentage: 37,
        nextResetTime: 1785258177000,
      },
      { type: "TIME_LIMIT", unit: 6, number: 1, percentage: 52 },
      {
        type: "TOKENS_LIMIT",
        unit: 1,
        number: 1,
        usage: 4000000,
        currentValue: 1000000,
        remaining: 3000000,
        percentage: 0,
      },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 88 },
    ],
  }), [
    {
      kind: "quota",
      label: "5-hour limit",
      usedPercent: 37,
      remainingPercent: 63,
      used: 37,
      limit: 100,
      remaining: 63,
      unit: "percent",
      resetAt: 1785258177,
    },
    {
      kind: "quota",
      label: "Weekly limit",
      usedPercent: 52,
      remainingPercent: 48,
      used: 52,
      limit: 100,
      remaining: 48,
      unit: "percent",
    },
    {
      kind: "quota",
      label: "Token quota",
      usedPercent: 25,
      remainingPercent: 75,
      used: 25,
      limit: 100,
      remaining: 75,
      unit: "percent",
    },
  ]);
});

test("z.ai account fetch uses the stored plan key and quota endpoint", async () => {
  writeFileSync(path.join(stateDir, "zai-coding-api-key.secret"), "TEST_ZAI_QUOTA_KEY\n", {
    mode: 0o600,
  });
  const requests = [];
  const snapshot = await providerAccountUsageSnapshot({
    providerIds: ["zai-coding"],
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), auth: options?.headers?.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          success: true,
          data: {
            planName: "GLM Coding Pro",
            limits: [
              { type: "TIME_LIMIT", unit: 3, number: 5, percentage: 41, nextResetTime: 1785258177000 },
            ],
          },
        }),
      };
    },
  });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes("api.z.ai/api/monitor/usage/quota/limit"));
  assert.equal(requests[0].auth, "Bearer TEST_ZAI_QUOTA_KEY");
  const account = snapshot["zai-coding"];
  assert.equal(account.status, "available");
  assert.equal(account.plan, "GLM Coding Pro");
  assert.equal(account.metrics[0].label, "5-hour limit");
  assert.equal(account.metrics[0].usedPercent, 41);
  assert.ok(account.dashboardUrl.startsWith("https://z.ai/"));
});

test("qwen and ollama stay local-only but carry a dashboard link", async () => {
  writeFileSync(path.join(stateDir, "qwen-plan-api-key.secret"), "TEST_QWEN_QUOTA_KEY\n", {
    mode: 0o600,
  });
  const snapshot = await providerAccountUsageSnapshot({
    providerIds: ["qwen-plan", "ollama-cloud"],
    fetchImpl: async () => {
      throw new Error("local-only providers must not reach the network");
    },
  });
  assert.equal(snapshot["qwen-plan"].status, "local-only");
  assert.ok(snapshot["qwen-plan"].dashboardUrl.includes("modelstudio.console.alibabacloud.com"));
  assert.equal(snapshot["ollama-cloud"].status, "not-configured");
  assert.equal(snapshot["ollama-cloud"].dashboardUrl, undefined);
});
