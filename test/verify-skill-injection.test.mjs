import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeRollout,
  latestRollout,
  PACK_SKILLS,
  parseCliArgs,
} from "../scripts/verify-skill-injection.mjs";

const SKILLS_ROOT = "/Users/user/.codex/skills";

function skillsBlock(packSkills = PACK_SKILLS) {
  const entries = packSkills.map((skill) => `(file: r0/${skill}/SKILL.md)`);
  return [
    "<skills_instructions>",
    `r0 = ${SKILLS_ROOT}`,
    "r1 = /Users/user/.agents/skills",
    ...entries,
    "</skills_instructions>",
  ].join("\n");
}

function withTurn(payload, turnId = "turn-1") {
  return {
    ...payload,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function meta(model) {
  return { type: "session_meta", payload: { model, originator: "Codex Desktop" } };
}

function developerBlock(text = skillsBlock(), turnId = "turn-1") {
  return {
    type: "response_item",
    payload: withTurn(
      { type: "message", role: "developer", content: [{ type: "input_text", text }] },
      turnId,
    ),
  };
}

function userBlock(text = skillsBlock(), turnId = "turn-1") {
  return {
    type: "response_item",
    payload: withTurn(
      { type: "message", role: "user", content: [{ type: "input_text", text }] },
      turnId,
    ),
  };
}

function customExecRead(skill = "codex-app-threads", turnId = "turn-1", callId = "read-1") {
  return {
    type: "response_item",
    payload: withTurn(
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: callId,
        input: `sed -n '1,200p' ${SKILLS_ROOT}/${skill}/SKILL.md`,
      },
      turnId,
    ),
  };
}

function legacyExecRead(skill = "codex-app-threads", turnId = "turn-1", callId = "read-1") {
  return {
    type: "response_item",
    payload: withTurn(
      {
        type: "function_call",
        name: "exec_command",
        call_id: callId,
        arguments: JSON.stringify({ cmd: `cat ${SKILLS_ROOT}/${skill}/SKILL.md` }),
      },
      turnId,
    ),
  };
}

function toolOutput(callId = "read-1", turnId = "turn-1", legacy = false) {
  return {
    type: "response_item",
    payload: withTurn(
      {
        type: legacy ? "function_call_output" : "custom_tool_call_output",
        call_id: callId,
        output: "skill contents",
      },
      turnId,
    ),
  };
}

function lines(...events) {
  return events.map((event) => JSON.stringify(event));
}

function routedEvents(read = customExecRead(), output = toolOutput()) {
  return [
    meta("opencode-go/deepseek-v4-flash"),
    developerBlock(),
    read,
    output,
  ];
}

test("trusted developer injection plus completed skill reference passes without creating a thread", () => {
  const result = analyzeRollout(lines(...routedEvents()), { expect: "routed" });
  assert.equal(result.ok, true, JSON.stringify(result.assertions));
  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(result.listed, PACK_SKILLS);
  assert.deepEqual(result.reads, ["codex-app-threads"]);
});

test("legacy exec_command read remains compatible when its output is observed", () => {
  const result = analyzeRollout(
    lines(...routedEvents(legacyExecRead(), toolOutput("read-1", "turn-1", true))),
  );
  assert.equal(result.ok, true, JSON.stringify(result.assertions));
});

test("skill-path evidence accepts Windows roots without depending on the verifier host", () => {
  const windowsRoot = "C:\\Users\\user\\.codex\\skills";
  const injection = developerBlock(skillsBlock().replace(SKILLS_ROOT, windowsRoot));
  const call = customExecRead();
  call.payload.input = `Get-Content ${windowsRoot}\\codex-app-threads\\SKILL.md`;
  const result = analyzeRollout(
    lines(
      meta("routed"),
      injection,
      call,
      toolOutput(),
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result.assertions));
});

test("user-pasted and embedded developer blocks cannot become trusted injection", () => {
  for (const event of [
    userBlock(),
    developerBlock(`preface\n${skillsBlock()}\npostscript`),
    {
      type: "response_item",
      payload: withTurn({
        type: "agent_message",
        role: "developer",
        content: [{ type: "input_text", text: skillsBlock() }],
      }),
    },
  ]) {
    const result = analyzeRollout(lines(meta("routed"), event, customExecRead(), toolOutput()));
    assert.equal(result.assertions[0].pass, false);
  }
});

test("malformed wrapper, partial pack, and missing turn id fail injection", () => {
  const missingTurn = developerBlock();
  delete missingTurn.payload.internal_chat_message_metadata_passthrough;
  for (const event of [
    developerBlock(skillsBlock().replace("</skills_instructions>", "")),
    developerBlock(skillsBlock(["codex-router"])),
    missingTurn,
  ]) {
    const result = analyzeRollout(lines(meta("routed"), event));
    assert.equal(result.assertions[0].pass, false);
  }
});

test("read before injection or in another turn is not same-turn evidence", () => {
  for (const events of [
    [customExecRead(), toolOutput(), developerBlock()],
    [developerBlock(), customExecRead("codex-app-threads", "turn-2"), toolOutput("read-1", "turn-2")],
  ]) {
    const result = analyzeRollout(lines(meta("routed"), ...events));
    assert.equal(result.assertions[1].pass, false);
  }
});

test("a read call without correlated output is reported but not claimed complete", () => {
  const result = analyzeRollout(
    lines(meta("routed"), developerBlock(), customExecRead()),
  );
  assert.equal(result.assertions[1].pass, false);
  assert.match(result.assertions[1].detail, /issued, output not observed/);
  assert.equal(result.issuedWithoutOutput.length, 1);
});

test("native mode fails only for a completed post-injection pack-path call", () => {
  const noRead = analyzeRollout(lines(meta("gpt-5.6-luna"), developerBlock()), {
    expect: "native",
  });
  assert.equal(noRead.ok, true, JSON.stringify(noRead.assertions));

  const issuedOnly = analyzeRollout(
    lines(meta("gpt-5.6-luna"), developerBlock(), customExecRead()),
    { expect: "native" },
  );
  assert.equal(issuedOnly.ok, true, JSON.stringify(issuedOnly.assertions));

  const completed = analyzeRollout(
    lines(meta("gpt-5.6-luna"), developerBlock(), customExecRead(), toolOutput()),
    { expect: "native" },
  );
  assert.equal(completed.assertions[2].pass, false);
});

test("a path-only exec is reported as reference evidence, not proof of file bytes read", () => {
  const pathOnly = customExecRead();
  pathOnly.payload.input = `console.log("${SKILLS_ROOT}/codex-app-threads/SKILL.md")`;
  const result = analyzeRollout(
    lines(
      meta("routed"),
      developerBlock(),
      pathOnly,
      toolOutput(),
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result.assertions));
  assert.match(result.assertions[1].name, /referencing/);
  assert.doesNotMatch(result.assertions[1].detail, /\bread\b/);
});

test("invalid analysis expectation is rejected", () => {
  assert.throws(() => analyzeRollout([], { expect: "anything" }), /invalid expectation/);
});

test("the pack list is the four shipped skills", () => {
  assert.deepEqual([...PACK_SKILLS].sort(), [
    "codex-app-threads",
    "codex-computer-use",
    "codex-in-app-browser",
    "codex-router",
  ]);
});

test("CLI parser accepts options in either order and rejects ambiguous input", () => {
  assert.deepEqual(parseCliArgs(["--latest", "--expect", "native"]), {
    expect: "native",
    latest: true,
    source: undefined,
  });
  assert.deepEqual(parseCliArgs(["rollout.jsonl", "--expect", "routed"]), {
    expect: "routed",
    latest: false,
    source: "rollout.jsonl",
  });
  assert.throws(() => parseCliArgs(["--expect"]), /requires/);
  assert.throws(() => parseCliArgs(["--expect", "maybe", "x"]), /invalid/);
  assert.throws(() => parseCliArgs(["--wat"]), /unknown/);
  assert.throws(() => parseCliArgs(["a", "b"]), /only one/);
  assert.throws(() => parseCliArgs(["a", "--latest"]), /either/);
  assert.throws(() => parseCliArgs([]), /required/);
});

test("latestRollout picks the newest jsonl recursively", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sessions-probe-"));
  try {
    const day = path.join(root, "2026", "08", "10");
    mkdirSync(day, { recursive: true });
    const older = path.join(day, "rollout-old.jsonl");
    const newer = path.join(day, "rollout-new.jsonl");
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    const future = new Date(Date.now() + 5_000);
    utimesSync(newer, future, future);
    assert.equal(latestRollout(root), newer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --latest --expect routed resolves the rollout instead of treating routed as a path", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "verify-skills-cli-"));
  try {
    const sessions = path.join(codexHome, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      path.join(sessions, "rollout.jsonl"),
      `${lines(...routedEvents()).join("\n")}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/verify-skill-injection.mjs"), "--latest", "--expect", "routed"],
      {
        cwd: path.resolve("."),
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK: all rollout-checkable assertions passed/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
