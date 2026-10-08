import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { INSTALLER_SCRIPTS, PYTHON_LOCK, pythonInstallCommand } from "../src/install-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/grok-apply-patch-guidance.yml";
const VERIFY = "scripts/verify-grok-apply-patch-guidance.mjs";

function repoFile(relative) {
  return path.join(root, ...relative.split("/"));
}

test("ordinary Node grok tests do not import a home LiteLLM python", () => {
  for (const relative of [
    "test/grok-oauth-forwarder.test.mjs",
    "test/namespace-relay.test.mjs",
    "test/namespace-relay-routing.test.mjs",
  ]) {
    const source = readFileSync(repoFile(relative), "utf8");
    assert.doesNotMatch(source, /\.local\/share\/codex-router/);
    assert.doesNotMatch(source, /homedir\(\)[\s\S]{0,80}codex-router/);
    assert.doesNotMatch(source, /convert_custom_tool_to_function_tool/);
  }
});

test("the Grok protocol workflow installs the lock with the installer command", () => {
  const workflow = readFileSync(repoFile(WORKFLOW), "utf8");
  assert.match(workflow, /install-plan\.mjs python-install-command/);
  const handWritten = workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /(uv\s+pip|-m\s+pip)\s+install\s/.test(line))
    .filter((line) => line.includes(PYTHON_LOCK));
  assert.deepEqual(handWritten, [], "the workflow must not spell the install command itself");
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /python: \["3\.12"\]/);
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.ok(workflow.includes(os), `${WORKFLOW} must run on ${os}`);
  }
});

test("the Grok protocol workflow is gated on the guidance path and never skips LiteLLM", () => {
  const workflow = readFileSync(repoFile(WORKFLOW), "utf8");
  for (const input of [
    "requirements/**",
    ...Object.values(INSTALLER_SCRIPTS),
    "src/install-plan.mjs",
    "src/grok-apply-patch-guidance.mjs",
    "src/grok-structured-patch.mjs",
    "src/grok-patch-hook*.mjs",
    "scripts/grok-patch-hook.mjs",
    "test/grok-patch-hook*.test.mjs",
    "src/namespace-relay.mjs",
    "src/grok-oauth-forwarder.mjs",
    "src/litellm_stream_cleanup_callback.py",
    "test/litellm-stream-cleanup.test.mjs",
    "test/grok-fast-config.test.mjs",
    "src/router.mjs",
    VERIFY,
    WORKFLOW,
  ]) {
    assert.ok(workflow.includes(`"${input}"`), `${WORKFLOW} does not run when ${input} changes`);
  }
  assert.match(
    workflow,
    /node scripts\/verify-grok-apply-patch-guidance\.mjs "\$venv_python"/,
    "the installed LiteLLM path must be exercised after the lock is installed",
  );
  const verifyStep = workflow.split("Verify Grok apply_patch guidance")[1] || "";
  assert.match(verifyStep, /node scripts\/verify-grok-apply-patch-guidance\.mjs "\$venv_python"/);
  assert.ok(verifyStep.includes('node scripts/verify-grok-apply-patch-guidance.mjs "$venv_python" --native-hook'));
  assert.ok(verifyStep.includes('MODEL_ROUTER_TEST_LITELLM_PYTHON="$venv_python" node --test test/litellm-stream-cleanup.test.mjs'));
  assert.ok(verifyStep.includes('node scripts/verify-grok-apply-patch-guidance.mjs "$venv_python" --native-hook --native-hook-endpoint --cancel-before-next-provider-read'));
  assert.doesNotMatch(verifyStep, /continue-on-error:\s*true/);
  assert.doesNotMatch(verifyStep, /skip/i);
});

test("the Grok protocol verifier requires an explicit python and does not skip", () => {
  const source = readFileSync(repoFile(VERIFY), "utf8");
  assert.match(source, /usage: node scripts\/verify-grok-apply-patch-guidance\.mjs <venv-python>/);
  assert.doesNotMatch(source, /\.local\/share\/codex-router/);
  assert.doesNotMatch(source, /process\.exit\(0\).*skip/);
  pythonInstallCommand("uv", { platform: "posix" });
});
