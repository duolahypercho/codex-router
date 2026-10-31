import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ageToolResults as applyAging,
} from "../src/tool-result-aging.mjs";

function ageToolResults(input, options) {
  return applyAging(input, { retain: () => "Read the exact archived result using the local shell.", ...options });
}

function call(id, name = "exec_command") {
  return { type: "function_call", call_id: id, name, arguments: "{}" };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

test("Cua runtime documentation survives aging while ordinary results still age", () => {
  for (const identity of [
    { namespace: "mcp__cua_repl", name: "js" },
    { name: "mcp__cua_repl__js" },
    { name: "mcp__cua_repl.js" },
  ]) {
    for (const heading of ["## Computer Use\n## API\n", "# Other Browser APIs\n# API Reference\n"]) {
      for (const structured of [false, true]) {
        const doc = heading + "API contract\n".repeat(5000);
        const value = structured ? [{ type: "input_text", text: doc }, { type: "input_text", text: "initial page" }] : doc;
        const input = [
          { ...call("docs"), ...identity }, output("docs", value),
          { ...call("page"), ...identity }, output("page", "page snapshot\n".repeat(5000)),
          call("other"), output("other", doc),
          { type: "message", role: "assistant", content: "Continue." },
        ];
        const retained = [];
        const result = ageToolResults(input, {
          frontier: 0, minBytes: 16384,
          retain: (_text, info) => { retained.push(info.callId); return "Read archived output."; },
        });
        assert.equal(result.input[1], input[1]);
        assert.deepEqual(retained, ["page", "other"]);
        assert.equal(result.stats.toolResultsAged, 2);
      }
    }
  }
});

test("instruction readers are protected across tools and wrappers, ordinary data is not", () => {
  const examples = [
    ["exec_command", {cmd:'Get-Content C:/repo/AGENTS.md'}, true],
    ["exec_command", {cmd:'cat /skills/demo/SKILL.md'}, true],
    ["read_file", {path:'/repo/CLAUDE.md'}, true],
    ["read_file", {path:'/repo/GEMINI.md'}, true],
    ["functions.exec", 'text(await tools.exec_command({cmd:"Get-Content C:/skills/demo/SKILL.md"}));', true],
    ["skills.read", {resource:'skill://demo/reference'}, true],
    ["functions.exec", 'await tools.skills.read({resource:"reference"})', true],
    ["mcp__other__read_documentation", {}, true],
    ["mcp__cua_repl__js", {code:'await cua.rewriteDocumentation()'}, true],
    ["read_file", {path:'/repo/data.json'}, false],
    ["exec_command", {cmd:'rg --files -g SKILL.md'}, false],
    ["exec_command", {cmd:'cat /repo/SKILL.md.backup'}, false],
    ["exec_command", {cmd:'echo AGENTS.md'}, false],
  ];
  for (const [name, args, protectedRead] of examples) {
    const input = [
      {...call('instruction', name), arguments: typeof args === 'string' ? args : JSON.stringify(args)},
      output('instruction', 'Documentation and ordinary text\n'.repeat(3000)),
      {type:'message', role:'assistant', content:'Continue'},
    ];
    const result = ageToolResults(input, {frontier:0, minBytes:16384});
    assert.equal(result.input[1] === input[1], protectedRead, JSON.stringify([name,args]));
  }
});

for (const [label, name, args, protectedRead] of [
  ["instruction search", "exec_command", { cmd: 'rg -n "permission" C:/repo/AGENTS.md' }, true],
  ["quoted instruction target", "exec_command", { cmd: 'rg -n "permission" "C:/repo space/AGENTS.md"' }, true],
  ["explicit search pattern", "exec_command", { cmd: 'rg -e permission C:/repo/AGENTS.md' }, true],
  ["instruction glob content", "exec_command", { cmd: 'rg -g AGENTS.md permission C:/repo' }, true],
  ["instruction name in pattern", "exec_command", { cmd: 'rg -n AGENTS.md C:/repo/data.txt' }, false],
  ["pattern with context options", "exec_command", { cmd: 'rg -n -A 5 AGENTS.md data.txt' }, false],
  ["inline pattern option", "exec_command", { cmd: 'rg --regexp=AGENTS.md data.txt' }, false],
  ["inline instruction glob", "exec_command", { cmd: 'rg --glob=AGENTS.md permission .' }, true],
  ["read words in pattern", "exec_command", { cmd: 'rg "Get-Content AGENTS.md" C:/repo/data.txt' }, false],
  ["file listing", "exec_command", { cmd: 'rg --files -g SKILL.md' }, false],
  ["listing flag after targets", "exec_command", { cmd: 'rg permission AGENTS.md --files' }, false],
  ["flag-shaped positional pattern", "exec_command", { cmd: 'rg -- --files AGENTS.md' }, true],
  ["flag-shaped explicit pattern", "exec_command", { cmd: 'rg -e --files AGENTS.md' }, true],
  ["matching file names only", "exec_command", { cmd: 'rg -l permission AGENTS.md' }, false],
  ["echo and README", "exec_command", { cmd: 'echo AGENTS.md README.md' }, false],
  ["quoted commands are data", "exec_command", { cmd: 'echo "cat AGENTS.md; Get-Content SKILL.md"' }, false],
  ["mixed real read", "exec_command", { cmd: 'Get-Content data.json; Get-Content AGENTS.md' }, true],
  ["mixed data and echo", "exec_command", { cmd: 'Get-Content data.json; echo AGENTS.md README.md' }, false],
  ["backup is ordinary data", "exec_command", { cmd: 'cat SKILL.md.backup' }, false],
  ["uncertain script", "exec_command", { cmd: 'python -c "load_document(\'AGENTS.md\')"' }, true],
  ["real path only", "read_file", { path: '/repo/data.json', description: 'AGENTS.md' }, false],
  ["multiple instruction paths", "mcp__filesystem__read_multiple_files", { paths: ['/repo/data.json', '/repo/SKILL.md'] }, true],
  ["search query is not a file read", "search", { query: 'Get-Content AGENTS.md README.md' }, false],
  ["literal wrapped command", "functions.exec", 'text(await tools.exec_command({cmd:"Get-Content C:/repo/AGENTS.md"}));', true],
  ["wrapped instruction search", "functions.exec", { code: 'text(await tools.exec_command({cmd:"rg -n permission AGENTS.md"}));' }, true],
  ["wrapped echo", "functions.exec", 'text(await tools.exec_command({cmd:"echo AGENTS.md README.md"}));', false],
  ["printed wrapped command", "functions.exec", 'text("tools.exec_command({cmd:\"cat AGENTS.md\"})");', false],
  ["commented wrapped command", "functions.exec", '// tools.exec_command({cmd:"cat AGENTS.md"})\ntext("ordinary data");', false],
  ["dynamic wrapped command", "functions.exec", 'const p="AGENTS.md"; await tools.exec_command({cmd:p});', true],
  ["computed wrapper call", "functions.exec", 'await tools["exec_command"]({cmd:"cat AGENTS.md"});', true],
  ["read inside template expression", "functions.exec", 'text(`${await tools.read_file({path:"AGENTS.md"})}`);', true],
  ["wrapped file read", "functions.exec", 'text(await tools.read_file({path:"/repo/SKILL.md"}));', true],
  ["wrapped skills read", "functions.exec", 'text(await tools.skills.read({resource:"reference"}));', true],
  ["printed skills read", "functions.exec", 'text("tools.skills.read({resource:\"reference\"})");', false],
  ["runtime documentation method", "mcp__cua_repl__js", { code: 'await cua.rewriteDocumentation()' }, true],
  ["printed runtime method", "mcp__cua_repl__js", { code: 'nodeRepl.write("cua.rewriteDocumentation()")' }, false],
  ["malformed command field", "exec_command", { cmd: 42 }, false],
  ["malformed runtime code field", "mcp__cua_repl__js", { code: 42 }, false],
]) {
  test(`instruction classification: ${label}`, () => {
    for (const structured of [false, true]) {
      const text = 'Instruction and ordinary data\n'.repeat(3000);
      const value = structured ? [{ type: 'input_text', text }] : text;
      const input = [
        { ...call('read', name), arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        output('read', value),
        { type: 'message', role: 'assistant', content: 'Continue.' },
      ];
      let retained = 0;
      const result = ageToolResults(input, {
        frontier: 0, minBytes: 16384,
        retain: () => { retained += 1; return 'Read archived output.'; },
      });
      assert.equal(result.input[1] === input[1], protectedRead);
      assert.equal(retained, protectedRead ? 0 : 1);
      assert.equal(result.input[0], input[0]);
      assert.equal(result.input[1].call_id, 'read');
      assert.equal(result.input[2], input[2]);
    }
  });
}

test("instruction protection accepts normalized function and custom-call payloads", () => {
  const calls = [
    { type: 'function_call', namespace: 'functions', name: 'exec', arguments: { code: 'await tools.read_file({path:"AGENTS.md"})' } },
    { type: 'custom_tool_call', name: 'functions.exec', input: 'await tools.exec_command({cmd:"rg -n permission AGENTS.md"})' },
    { type: 'custom_tool_call', name: 'exec_command', input: { cmd: 'Get-Content AGENTS.md' } },
  ];
  for (const invocation of calls) {
    const input = [
      { ...invocation, call_id: 'instruction' },
      { type: invocation.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output',
        call_id: 'instruction', output: [{ type: 'input_text', text: 'Important instructions\n'.repeat(3000) }] },
      { type: 'message', role: 'assistant', content: 'Continue.' },
    ];
    let retained = 0;
    const result = ageToolResults(input, { frontier: 0, retain: () => { retained += 1; return 'Read archive.'; } });
    assert.equal(result.input, input);
    assert.equal(retained, 0);
  }
});

test("ages a large consumed result while preserving its call pairing and recovery evidence", () => {
  const value = `HEAD\n${"middle\n".repeat(8_000)}TAIL`;
  const input = [
    call("old", "exec_command"),
    output("old", value),
    { type: "message", role: "assistant", content: "I used that result." },
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "small"),
    ]).flat(),
  ];

  const result = ageToolResults(input);
  assert.notEqual(result.input, input);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.ok(result.stats.toolResultBytesSaved > 40_000);
  assert.equal(result.input[1].call_id, "old");
  assert.match(result.input[1].output, /Read the exact archived result/);
  assert.match(result.input[1].output, /HEAD/);
  assert.match(result.input[1].output, /TAIL/);
  assert.match(
    result.input[1].output,
    new RegExp(createHash("sha256").update(value).digest("hex")),
  );
});

test("ordinary aging keeps exact head and tail bytes unchanged", () => {
  const value = [
    "progress 10%\rprogress 20%",
    ...Array.from({ length: 5_000 }, (_, index) => `distinct line ${index}`),
    "tail old\rtail final",
  ].join("\n");
  const input = [
    call("old", "exec_command"),
    output("old", value),
    { type: "message", role: "assistant", content: "I used that result." },
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "small"),
    ]).flat(),
  ];

  const result = ageToolResults(input);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.match(result.input[1].output, /progress 10%\rprogress 20%/u);
  assert.match(result.input[1].output, /tail old\rtail final/u);
});

test("keeps the newest four result items byte-for-byte intact", () => {
  const value = "x".repeat(40_000);
  const input = Array.from({ length: 4 }, (_, index) => [
    call(`call-${index}`),
    output(`call-${index}`, value),
    { type: "message", role: "assistant", content: "acted" },
  ]).flat();

  const result = ageToolResults(input);
  assert.equal(result.input, input);
  assert.equal(result.stats.toolResultsAged, 0);
});

test("keeps an unconsumed result even when it is outside a zero-sized frontier", () => {
  const input = [call("pending"), output("pending", "x".repeat(40_000))];
  const result = ageToolResults(input, { frontier: 0 });
  assert.equal(result.input, input);
});

test("does not rewrite image-bearing or mixed output parts", () => {
  const input = [
    call("image", "view_image"),
    {
      type: "function_call_output",
      call_id: "image",
      output: [
        { type: "input_text", text: "x".repeat(40_000) },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0 });
  assert.equal(result.input, input);
});

test("can be disabled without copying or changing the input", () => {
  const input = [
    call("old"),
    output("old", "x".repeat(40_000)),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { enabled: false, frontier: 0 });
  assert.equal(result.input, input);
  assert.deepEqual(result.stats, {
    toolResultsAged: 0,
    toolResultBytesBefore: 0,
    toolResultBytesAfter: 0,
    toolResultBytesSaved: 0,
  });
});

test("does not split surrogate pairs at either preview boundary", () => {
  const value = `${"a".repeat(1_023)}😀${"z".repeat(40_000)}😀${"b".repeat(1_023)}`;
  const input = [
    call("old"),
    output("old", value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0 });
  assert.doesNotMatch(result.input[1].output, /�/);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.equal((result.input[1].output.match(/😀/gu) || []).length, 0,
    "a pair straddling a preview boundary is omitted whole");
});

// The failure this instrumentation exists for: a session that spends its whole
// context on results which each sit under the floor reported the same empty
// stats as a pass that never ran, so an operator could not tell an ineffective
// feature from an unloaded one.
test("a pass that ages nothing still reports what it evaluated and the largest result it saw", () => {
  const input = [
    ...Array.from({ length: 12 }, (_, index) => [
      call(`mid-${index}`),
      output(`mid-${index}`, "x".repeat(12_000)),
      { type: "message", role: "assistant", content: `read ${index}` },
    ]).flat(),
  ];
  const { stats, input: unchanged } = ageToolResults(input);
  assert.equal(stats.toolResultsAged, 0);
  assert.equal(stats.toolResultsEvaluated, 8, "the four newest results stay protected");
  assert.equal(stats.toolResultBytesLargest, 12_000);
  assert.equal(unchanged, input, "nothing qualified, so the input is passed through by reference");
});

test("a disabled pass stays distinguishable from one that ran and found nothing", () => {
  const input = [call("a"), output("a", "x".repeat(12_000))];
  const off = ageToolResults(input, { enabled: false });
  assert.equal(off.stats.toolResultsEvaluated, undefined);
  assert.equal(off.stats.toolResultBytesLargest, undefined);
  const on = ageToolResults(input);
  assert.equal(on.stats.toolResultsEvaluated, 0, "every result here sits inside the frontier");
});

// Reported alongside #256: the 400 was seen with "Compact old tool results"
// switched on, so the pass had to be cleared of rewriting the reasoning that
// a thinking provider demands back. It only ever replaces the `output` of a
// tool result; reasoning items and assistant messages come out by reference.
test("a pass that ages a result leaves the reasoning and assistant turns around it untouched", () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "The user wants the log tail." }],
    content: null,
  };
  const answer = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Here is what the log says." }],
  };
  const input = [
    reasoning,
    call("old", "exec_command"),
    output("old", `HEAD\n${"middle\n".repeat(8_000)}TAIL`),
    answer,
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "small"),
    ]).flat(),
  ];

  const result = ageToolResults(input);
  assert.equal(result.stats.toolResultsAged, 1, "the old result did qualify");
  assert.equal(result.input[0], reasoning, "the reasoning item is passed through by reference");
  assert.equal(result.input[3], answer, "the assistant turn is passed through by reference");
  assert.deepEqual(
    result.input.filter((item) => item.type === "reasoning"),
    [reasoning],
  );
});

test("missing or failed retention never drops original output", () => {
  const input = [call("a"), output("a", "x".repeat(40000)), { type: "reasoning" }];
  assert.equal(applyAging(input, {frontier: 0}).input, input);
  assert.equal(applyAging(input, {frontier: 0, retain() { throw new Error("disk full"); }}).input, input);
});
