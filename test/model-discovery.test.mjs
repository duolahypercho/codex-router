import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { modelIds } = await import("../src/model-discovery.mjs");

test("model discovery compares fixtures without needing or exposing a key", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v5-preview" }] }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, DEEPSEEK_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["deepseek-v5-preview"]);
    assert.ok(result.unavailable.includes("deepseek-v4-flash"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Command Code discovery parses the Provider API model list", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-commandcode-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      object: "list",
      data: [{ id: "deepseek/deepseek-v4-flash" }, { id: "claude-sonnet-4-6" }],
    }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "commandcode", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, COMMAND_CODE_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["claude-sonnet-4-6"]);
    assert.ok(result.unavailable.includes("deepseek/deepseek-v4-pro"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Copilot discovery exposes only selectable Responses models with tools", () => {
  const payload = {
    data: [
      {
        id: "gpt-responses",
        model_picker_enabled: true,
        supported_endpoints: ["/responses", "/chat/completions"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "chat-only",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "no-tools",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: false, streaming: true } },
      },
      {
        id: "policy-disabled",
        model_picker_enabled: true,
        policy: { state: "disabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "utility",
        model_picker_enabled: false,
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "accounts/router/internal",
        object: "model",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: { type: "chat", supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "embedding-record",
        object: "embedding",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "non-chat",
        object: "model",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: { type: "embedding", supports: { tool_calls: true, streaming: true } },
      },
    ],
  };
  assert.deepEqual(modelIds(payload, PROVIDERS.get("github-copilot")), ["gpt-responses"]);
});
