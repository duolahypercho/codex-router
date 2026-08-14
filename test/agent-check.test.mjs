import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { checkAgentCapability } from "../src/agent-check.mjs";

test("agent capability checks override user config with an ephemeral read-only sandbox", () => {
  let invocation;
  const slug = "local/test-model";
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const marker = readdirSync(options.cwd).find((entry) => entry.startsWith("agentcheck-"));
    return { status: 0, stdout: `${marker}\n`, stderr: "" };
  };

  const result = checkAgentCapability(slug, {
    attempts: 1,
    codex: "/opt/codex",
    spawn,
    catalogSlugs: new Set([slug]),
  });

  assert.equal(result.verdict, "agent");
  assert.deepEqual(invocation.args.slice(0, 5), [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--model",
  ]);
  assert.equal(invocation.args[5], slug);
  assert.ok(invocation.args.includes("--skip-git-repo-check"));
});

// The proof run hands Codex a whole sentence as one argument. Node's
// `shell: true` would join the list on spaces and split that sentence into
// eighteen arguments; spawning the .cmd shim directly fails outright, which
// graded every routed model on Windows as not agent-capable.
test("the proof run reaches Codex through an npm batch shim on Windows", () => {
  let invocation;
  const slug = "local/test-model";
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const marker = readdirSync(options.cwd).find((entry) => entry.startsWith("agentcheck-"));
    return { status: 0, stdout: `${marker}\n`, stderr: "" };
  };

  const result = checkAgentCapability(slug, {
    attempts: 1,
    codex: "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd",
    platform: "win32",
    spawn,
    catalogSlugs: new Set([slug]),
  });

  assert.equal(result.agentCapable, true);
  assert.match(invocation.command, /cmd\.exe$/i);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(invocation.options.windowsHide, true);
  const line = invocation.args[3];
  assert.ok(line.includes("codex.cmd"), line);
  // One argument, not one per word.
  assert.ok(line.includes("list^ the^ files"), line);
});
