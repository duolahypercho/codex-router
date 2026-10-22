import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts", "verify-grok-app-tools.mjs");

test("app-tool full-hop verifier refuses to discover or reuse operator Python implicitly", () => {
  const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: node scripts\/verify-grok-app-tools\.mjs <venv-python>/);
});

const python = process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON;
const codex = process.env.MODEL_ROUTER_TEST_CODEX_BINARY;
test("app discovery and retained MCP calls cross locked LiteLLM and the real Grok forwarder", {
  skip: !python && "set MODEL_ROUTER_TEST_LITELLM_PYTHON to run the offline full-hop proof",
  timeout: 420_000,
}, () => {
  const result = spawnSync(process.execPath, [verifier, python, ...(codex ? [`--codex=${codex}`] : [])], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 400_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /search → app call → repeated app call → final/);
  assert.match(result.stdout, /4 requests; no provider quota/);
});


test("the locked protocol workflow executes app discovery and watches its boundaries", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "grok-apply-patch-guidance.yml"), "utf8");
  assert.ok(workflow.includes('node scripts/verify-grok-app-tools.mjs "$venv_python"'));
  for (const input of ["scripts/verify-grok-app-tools.mjs", "src/chat-tool-surface.mjs", "src/codex-app-tools.mjs", "src/namespace-relay.mjs", "src/empty-completion-guard.mjs", "test/grok-app-tools-ci.test.mjs"]) {
    assert.equal(workflow.split(`- "${input}"`).length - 1, 2, `${input} must trigger both push and pull_request checks`);
  }
});
