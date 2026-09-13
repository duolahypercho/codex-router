import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import {
  bridgeCustomTools,
  buildNamespaceLookups,
  flattenNamespaceTools,
  NamespaceToolCallTransform,
} from "../src/namespace-relay.mjs";
import {
  GROK_STRUCTURED_PATCH_CODEC,
  serializeStructuredPatch,
} from "../src/grok-structured-patch.mjs";
import {
  applyGrokEditFacade,
  classifyShellCommand,
  compileGrepCommand,
  compileListDirCommand,
  compileReadFileCommand,
  compileRunTerminalCommand,
  encodeGrokFacadeHistory,
  nativeExecRelayTarget,
  rewriteGrokFacadeToolChoice,
  SHELL_NOT_EDITOR_COMMAND,
  grokEditFacadeEnabled,
  GREP_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  RUN_TERMINAL_COMMAND_TOOL_NAME,
  SEARCH_REPLACE_PARAMETERS,
  SEARCH_REPLACE_TOOL_NAME,
  WRITE_PARAMETERS,
  WRITE_TOOL_NAME,
} from "../src/grok-tool-facade.mjs";

const native = {
  type: "custom",
  name: "apply_patch",
  description: "Keep project permissions.",
  format: { type: "grammar", syntax: "lark", definition: "native grammar unchanged" },
};
const codecs = new Map([["apply_patch", GROK_STRUCTURED_PATCH_CODEC]]);
const execParams = {
  type: "object",
  properties: { cmd: { type: "string" }, workdir: { type: "string" } },
};
const execTool = { type: "function", name: "exec_command", parameters: execParams };
const replaceArgs = JSON.stringify({
  path: "notes.txt",
  old_string: "hello",
  new_string: "hello world",
});
const replacePatch = serializeStructuredPatch({
  operations: [{
    op: "update",
    path: "notes.txt",
    hunks: [{ lines: [{ kind: "remove", text: "hello" }, { kind: "add", text: "hello world" }] }],
  }],
});

function setup(route = { slug: "grok-oauth/grok-4.6" }, structuredPatch = true, extraTools = [], facadeOptions = { patchHook: true }) {
  const flattened = flattenNamespaceTools([native, execTool, ...extraTools]);
  const bridged = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    undefined,
    undefined,
    { codecs },
  );
  const tools = applyGrokEditFacade(bridged.tools, flattened.namespaces, route, structuredPatch, facadeOptions);
  return {
    ...bridged,
    tools,
    namespaces: flattened.namespaces,
    lookups: buildNamespaceLookups(flattened.namespaces),
  };
}

function frame(type, extra = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
}

async function relay(bridge, name, value) {
  const call = { type: "function_call", id: "fc_edit", call_id: "call_edit", name, arguments: value };
  const parts = [
    frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } }),
    frame("response.function_call_arguments.done", { item_id: call.id, output_index: 0, arguments: value }),
    frame("response.output_item.done", { output_index: 0, item: call }),
    frame("response.completed", { response: { output: [call] } }),
  ];
  const chunks = [];
  await pipeline(
    Readable.from(parts),
    new NamespaceToolCallTransform(bridge.namespaces, "text/event-stream", "grok-oauth/grok-4.6"),
    new Writable({
      write(chunk, _encoding, next) {
        chunks.push(Buffer.from(chunk));
        next();
      },
    }),
  );
  return Buffer.concat(chunks).toString("utf8")
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
}

test("native exec lookup ignores missing tool lists", () => {
  assert.equal(nativeExecRelayTarget(undefined), undefined);
  assert.equal(nativeExecRelayTarget(null), undefined);
  assert.equal(nativeExecRelayTarget({ name: "exec_command" }), undefined);
});

test("facade binds only to ordinary function exec_command", () => {
  const custom = { type: "custom", name: "exec_command", format: { type: "grammar", syntax: "lark", definition: "cmd" } };
  assert.equal(nativeExecRelayTarget([custom]), undefined);
  assert.deepEqual(
    nativeExecRelayTarget([{ type: "function", name: "exec_command", parameters: execParams }]),
    { nativeName: "exec_command" },
  );
  assert.equal(
    nativeExecRelayTarget([{ type: "function", name: "exec_command", parameters: { type: "object" } }]),
    undefined,
  );
  assert.equal(
    nativeExecRelayTarget([{
      type: "function",
      name: "exec_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    }]),
    undefined,
  );
  const namespaces = new Map([["functions", new Set(["exec_command"])]]);
  assert.equal(
    nativeExecRelayTarget([{ type: "custom", name: "functions__exec_command" }], namespaces),
    undefined,
  );
  const flattened = flattenNamespaceTools([native, custom]);
  const bridged = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    undefined,
    undefined,
    { codecs },
  );
  const tools = applyGrokEditFacade(
    bridged.tools,
    flattened.namespaces,
    { slug: "grok-oauth/grok-4.6" },
    true,
    { patchHook: true },
  );
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("exec_command"));
  assert.ok(!names.includes(READ_FILE_TOOL_NAME));
  assert.ok(!names.includes(RUN_TERMINAL_COMMAND_TOOL_NAME));
});

test("facade is only offered on Grok 4.6 structured-patch turns", () => {
  assert.equal(grokEditFacadeEnabled({ slug: "grok-oauth/grok-4.6" }, true), true);
  assert.equal(grokEditFacadeEnabled({ slug: "grok-oauth/grok-4.6" }, false), false);
  assert.equal(grokEditFacadeEnabled({ slug: "grok-oauth/grok-4.5" }, true), false);
});

test("search_replace and write are added beside apply_patch without colliding", () => {
  const bridge = setup();
  const names = bridge.tools.map((tool) => tool.name);
  assert.ok(names.includes(SEARCH_REPLACE_TOOL_NAME));
  assert.ok(names.includes(WRITE_TOOL_NAME));
  assert.ok(names.includes(READ_FILE_TOOL_NAME));
  assert.ok(names.includes(LIST_DIR_TOOL_NAME));
  assert.ok(names.includes(RUN_TERMINAL_COMMAND_TOOL_NAME));
  assert.ok(!names.includes("exec_command"));
  assert.deepEqual(
    bridge.tools.find((tool) => tool.name === SEARCH_REPLACE_TOOL_NAME).parameters,
    SEARCH_REPLACE_PARAMETERS,
  );
  assert.deepEqual(
    bridge.tools.find((tool) => tool.name === WRITE_TOOL_NAME).parameters,
    WRITE_PARAMETERS,
  );
  const skipped = setup({ slug: "grok-oauth/grok-4.6" }, true, [
    { type: "function", name: SEARCH_REPLACE_TOOL_NAME, parameters: { type: "object" } },
  ]);
  assert.equal(skipped.tools.filter((tool) => tool.name === SEARCH_REPLACE_TOOL_NAME).length, 1);
});

test("read_file and grep compile to bounded exec_command payloads", () => {
  assert.equal(
    compileReadFileCommand(JSON.stringify({ target_file: "/tmp/notes.txt" }), undefined, "linux"),
    JSON.stringify({ cmd: "sed -n '1,400p' '/tmp/notes.txt'" }),
  );
  assert.equal(
    compileReadFileCommand(JSON.stringify({ target_file: "/tmp/a.txt", offset: 10, limit: 5 }), undefined, "linux"),
    JSON.stringify({ cmd: "sed -n '10,14p' '/tmp/a.txt'" }),
  );
  assert.equal(
    compileGrepCommand(JSON.stringify({ pattern: "SelectCompat", path: "smid", glob: "*.js" }), undefined, "linux"),
    JSON.stringify({ cmd: "set -o pipefail; rg --line-number --color never --max-count 50 -e 'SelectCompat' --glob '*.js' -- 'smid' | head -n 50" }),
  );
  assert.match(
    compileReadFileCommand(JSON.stringify({ target_file: "notes.txt" }), undefined, "win32"),
    /EncodedCommand/,
  );
  const quotedWin = compileReadFileCommand(
    JSON.stringify({ target_file: 'a"; Remove-Item victim; #' }),
    undefined,
    "win32",
  );
  assert.match(quotedWin, /EncodedCommand/);
  assert.doesNotMatch(quotedWin, /Remove-Item victim/);
  const windowsGrep = encodeGrokFacadeHistory([
    {
      type: "function_call",
      call_id: "g",
      name: "exec_command",
      arguments: compileGrepCommand(JSON.stringify({ pattern: "don't", path: "O'Brien" }), undefined, "win32"),
    },
  ]);
  assert.equal(windowsGrep[0].name, GREP_TOOL_NAME);
  assert.deepEqual(JSON.parse(windowsGrep[0].arguments), { pattern: "don't", path: "O'Brien" });
  assert.equal(compileReadFileCommand(JSON.stringify({ target_file: "a\nb" })), undefined);
  assert.equal(
    compileListDirCommand(JSON.stringify({ target_directory: "smid/app" }), undefined, "linux"),
    JSON.stringify({ cmd: "ls -la 'smid/app'" }),
  );
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "yarn test:frontend", working_directory: "smid" })),
    JSON.stringify({ cmd: "yarn test:frontend", workdir: "smid" }),
  );
});

test("history restores Codex exec/apply_patch calls back to Grok tool names", () => {
  const encoded = encodeGrokFacadeHistory([
    { type: "function_call", call_id: "1", name: "exec_command", arguments: compileReadFileCommand(JSON.stringify({ target_file: "/tmp/a.js", offset: 1, limit: 40 }), undefined, "linux") },
    { type: "function_call", call_id: "2", name: "exec_command", arguments: compileGrepCommand(JSON.stringify({ pattern: "foo", path: "smid" }), undefined, "linux") },
    { type: "function_call", call_id: "3", name: "exec_command", arguments: JSON.stringify({ cmd: "yarn test" }) },
    { type: "function_call", call_id: "4", name: "apply_patch", arguments: JSON.stringify({ path: "a.js", old_string: "a", new_string: "b" }) },
  ]);
  assert.equal(encoded[0].name, READ_FILE_TOOL_NAME);
  assert.equal(encoded[1].name, GREP_TOOL_NAME);
  assert.equal(encoded[2].name, RUN_TERMINAL_COMMAND_TOOL_NAME);
  assert.equal(JSON.parse(encoded[2].arguments).command, "yarn test");
  assert.equal(encoded[3].name, SEARCH_REPLACE_TOOL_NAME);
  const fromCat = encodeGrokFacadeHistory([
    { type: "function_call", call_id: "5", name: "exec_command", arguments: JSON.stringify({ cmd: "cat '/tmp/a.js'" }) },
    { type: "function_call", call_id: "6", name: "exec_command", arguments: JSON.stringify({ cmd: "from pathlib import Path\np=Path('/tmp/a.js')\nprint(p.read_text())" }) },
    { type: "function_call", call_id: "7", name: "exec_command", arguments: JSON.stringify({ cmd: "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'ok'\"" }) },
  ]);
  assert.equal(fromCat[0].name, READ_FILE_TOOL_NAME);
  assert.equal(JSON.parse(fromCat[0].arguments).target_file, "/tmp/a.js");
  assert.equal(fromCat[1].name, READ_FILE_TOOL_NAME);
  assert.equal(fromCat[2].name, RUN_TERMINAL_COMMAND_TOOL_NAME);
  const withWorkdir = encodeGrokFacadeHistory([
    {
      type: "function_call",
      call_id: "8",
      name: "exec_command",
      arguments: compileReadFileCommand(JSON.stringify({ target_file: "a.txt" }), "sub", "linux"),
    },
  ]);
  assert.equal(withWorkdir[0].name, RUN_TERMINAL_COMMAND_TOOL_NAME);
  assert.deepEqual(JSON.parse(withWorkdir[0].arguments), {
    command: "sed -n '1,400p' 'a.txt'",
    working_directory: "sub",
  });
});

test("run_terminal_command canonicalizes file reads and refuses file writes", () => {
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "cat '/tmp/a.js'" })),
    compileReadFileCommand(JSON.stringify({ target_file: "/tmp/a.js" })),
  );
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "Path('/tmp/a.js').write_text('x')" })),
    JSON.stringify({ cmd: SHELL_NOT_EDITOR_COMMAND }),
  );
  assert.equal(classifyShellCommand("yarn test:frontend").kind, "process");
  assert.equal(classifyShellCommand("echo hi > notes.txt").kind, "write");
  assert.equal(classifyShellCommand("printf x>main.py").kind, "write");
  assert.equal(classifyShellCommand("echo err 2>Dockerfile").kind, "write");
  assert.equal(classifyShellCommand("git status 2>&1").kind, "process");
  assert.equal(classifyShellCommand("printf owned >&main.js").kind, "write");
  assert.equal(classifyShellCommand("git log --pretty='format:%h > %s'").kind, "process");
  assert.equal(classifyShellCommand("git log --pretty='format:%h >> %s'").kind, "process");
  assert.equal(classifyShellCommand("sed -i 's/old/new/' file").kind, "write");
  assert.equal(classifyShellCommand("sed -Ei 's/old/new/' file").kind, "write");
  assert.equal(classifyShellCommand("perl -pi -e 's/old/new/' file").kind, "write");
  assert.equal(classifyShellCommand("node --test --test-name-pattern='Set-Content' test/foo.test.mjs").kind, "process");
  assert.equal(classifyShellCommand("printf '%s\\n' 'a>b'").kind, "process");
  assert.equal(classifyShellCommand("cat --help").kind, "process");
  assert.equal(classifyShellCommand("head --help").kind, "process");
  assert.equal(classifyShellCommand("ls --help").kind, "process");
  assert.equal(classifyShellCommand("cat -- --help").kind, "read_file");
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "cat --help" })),
    JSON.stringify({ cmd: "cat --help" }),
  );
  assert.equal(
    classifyShellCommand("node -e \"require('fs').writeFileSync('main.js','...')\"").kind,
    "write",
  );
  assert.equal(
    classifyShellCommand("node -e \"require('fs').promises.writeFile('main.js','...')\"").kind,
    "write",
  );
  assert.equal(
    classifyShellCommand("node -e \"require('fs').readFileSync('main.js')\"").kind,
    "process",
  );
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "cat 'a.txt'", working_directory: "sub" })),
    compileReadFileCommand(JSON.stringify({ target_file: "a.txt" }), "sub"),
  );
  assert.equal(compileListDirCommand(JSON.stringify({ unexpected: true })), undefined);
  assert.equal(
    compileReadFileCommand(JSON.stringify({ target_file: "--expression=w victim", offset: 1, limit: 10 }), undefined, "linux"),
    JSON.stringify({ cmd: "sed -n '1,10p' './--expression=w victim'" }),
  );
  assert.equal(compileRunTerminalCommand(JSON.stringify({ command: "rm marker", workingDirectory: "sub" })), undefined);
  assert.equal(compileRunTerminalCommand(JSON.stringify({ command: "true", working_directory: "" })), undefined);
  assert.equal(classifyShellCommand("Set-Content -LiteralPath main.js -Value 'oops'").kind, "write");
  assert.equal(classifyShellCommand("'x' | Out-File main.js").kind, "write");
  assert.equal(classifyShellCommand("cat 'a' 'b'").kind, "process");
  assert.equal(classifyShellCommand("head 'README.md'").args.limit, 10);
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "cat 'a' 'b'" })),
    JSON.stringify({ cmd: "cat 'a' 'b'" }),
  );
});

test("write is omitted without the existence-checking hook", () => {
  const names = setup(undefined, true, [], {}).tools.map((tool) => tool.name);
  assert.ok(!names.includes(SEARCH_REPLACE_TOOL_NAME));
  assert.ok(!names.includes(WRITE_TOOL_NAME));
});

test("exec_command stays visible when run_terminal_command already exists", () => {
  const names = setup(undefined, true, [
    { type: "function", name: RUN_TERMINAL_COMMAND_TOOL_NAME, parameters: { type: "object" } },
  ]).tools.map((tool) => tool.name);
  assert.ok(names.includes(RUN_TERMINAL_COMMAND_TOOL_NAME));
  assert.ok(names.includes("exec_command"));
});

test("legacy apply_patch history and forced native choices keep façade identities", () => {
  const fromPatch = encodeGrokFacadeHistory([
    {
      type: "function_call",
      call_id: "8",
      name: "apply_patch",
      arguments: JSON.stringify({
        input: "*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** End Patch",
      }),
    },
    {
      type: "function_call",
      call_id: "9",
      name: "apply_patch",
      arguments: JSON.stringify({
        input: "*** Begin Patch\n*** Add File: new.js\n+ok\n*** End Patch",
      }),
    },
  ]);
  assert.equal(fromPatch[0].name, "apply_patch");
  assert.equal(fromPatch[1].name, "apply_patch");
  assert.deepEqual(
    rewriteGrokFacadeToolChoice({ type: "function", name: "exec_command" }),
    { type: "function", name: RUN_TERMINAL_COMMAND_TOOL_NAME },
  );
  assert.deepEqual(
    rewriteGrokFacadeToolChoice({ type: "function", name: "apply_patch" }),
    { type: "function", name: SEARCH_REPLACE_TOOL_NAME },
  );
  assert.deepEqual(
    rewriteGrokFacadeToolChoice({ type: "function", namespace: "mcp", name: "apply_patch" }),
    { type: "function", namespace: "mcp", name: "apply_patch" },
  );
  const unrelated = encodeGrokFacadeHistory([
    { type: "function_call", call_id: "mcp", name: "mcp__x__exec_command", arguments: JSON.stringify({ cmd: "true" }) },
    { type: "function_call", call_id: "mcp-patch", name: "mcp__x__apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** End Patch" }) },
    { type: "function_call", call_id: "ns-patch", namespace: "mcp", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** End Patch" }) },
  ], { nativeName: "exec_command" });
  assert.equal(unrelated[0].name, "mcp__x__exec_command");
  assert.equal(unrelated[1].name, "mcp__x__apply_patch");
  assert.equal(unrelated[2].name, "apply_patch");
  assert.equal(unrelated[2].namespace, "mcp");
  const namespacedExec = encodeGrokFacadeHistory([
    {
      type: "function_call",
      call_id: "ns-exec",
      namespace: "functions",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "yarn test" }),
    },
  ], { nativeName: "exec_command", nativeNamespace: "functions" });
  assert.equal(namespacedExec[0].name, RUN_TERMINAL_COMMAND_TOOL_NAME);
  assert.equal(namespacedExec[0].namespace, undefined);
  const colliding = encodeGrokFacadeHistory([
    {
      type: "function_call",
      call_id: "10",
      name: "apply_patch",
      arguments: JSON.stringify({
        input: "*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** End Patch",
      }),
    },
  ], { nativeName: "exec_command" }, new Set());
  assert.equal(colliding[0].name, "apply_patch");
  assert.deepEqual(
    rewriteGrokFacadeToolChoice({ type: "function", name: "apply_patch" }, new Set()),
    { type: "function", name: "apply_patch" },
  );
  const windowsRead = compileReadFileCommand(JSON.stringify({ target_file: "a.txt", offset: 1, limit: 10 }), undefined, "win32");
  const fromWindows = encodeGrokFacadeHistory([
    { type: "function_call", call_id: "w", name: "exec_command", arguments: windowsRead },
  ]);
  assert.equal(fromWindows[0].name, READ_FILE_TOOL_NAME);
  assert.deepEqual(JSON.parse(fromWindows[0].arguments), { target_file: "a.txt", offset: 1, limit: 10 });
});

test("search_replace restores to native apply_patch with a compiled V4A payload", async () => {
  const bridge = setup();
  const events = await relay(bridge, SEARCH_REPLACE_TOOL_NAME, replaceArgs);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "custom_tool_call");
  assert.equal(done.item.name, "apply_patch");
  assert.equal(done.item.input, replacePatch);
  assert.equal(done.item.call_id, "call_edit");
});

test("read_file restores to native exec_command with a bounded sed command", async () => {
  const bridge = setup();
  const args = JSON.stringify({ target_file: "/tmp/SelectCompat/index.js", offset: 1, limit: 40 });
  const events = await relay(bridge, READ_FILE_TOOL_NAME, args);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.name, "exec_command");
  assert.equal(done.item.arguments, compileReadFileCommand(args));
  assert.equal(done.item.call_id, "call_edit");
});

test("namespaced exec_command restores to namespace/name not the flattened spelling", async () => {
  const namespaced = {
    type: "namespace",
    name: "functions",
    tools: [{ type: "function", name: "exec_command", parameters: execParams }],
  };
  const flattened = flattenNamespaceTools([native, namespaced]);
  const bridged = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    undefined,
    undefined,
    { codecs },
  );
  const tools = applyGrokEditFacade(
    bridged.tools,
    flattened.namespaces,
    { slug: "grok-oauth/grok-4.6" },
    true,
    { patchHook: true },
  );
  const bridge = { ...bridged, tools, namespaces: flattened.namespaces };
  const args = JSON.stringify({ target_file: "/tmp/a.js", offset: 1, limit: 10 });
  const events = await relay(bridge, READ_FILE_TOOL_NAME, args);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.name, "exec_command");
  assert.equal(done.item.namespace, "functions");
});

test("unrelated namespaced exec_command declarations are not hidden by suffix", () => {
  const names = setup(undefined, true, [
    { type: "function", name: "mcp__x__exec_command", parameters: { type: "object" } },
  ]).tools.map((tool) => tool.name);
  assert.ok(names.includes("mcp__x__exec_command"));
  assert.ok(!names.includes("exec_command"));
});

test("shell_command is not used as the native exec identity", () => {
  const flattened = flattenNamespaceTools([
    native,
    { type: "function", name: "shell_command", parameters: { type: "object" } },
  ]);
  const bridged = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    undefined,
    undefined,
    { codecs },
  );
  const tools = applyGrokEditFacade(
    bridged.tools,
    flattened.namespaces,
    { slug: "grok-oauth/grok-4.6" },
    true,
    { patchHook: true },
  );
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes(SEARCH_REPLACE_TOOL_NAME));
  assert.ok(!names.includes(READ_FILE_TOOL_NAME));
  assert.ok(!names.includes("shell_command"));
});

test("function relay terminal summary must match the closed arguments", async () => {
  const bridge = setup();
  const args = JSON.stringify({ target_file: "/tmp/a.js", offset: 1, limit: 10 });
  const call = { type: "function_call", id: "fc_edit", call_id: "call_edit", name: READ_FILE_TOOL_NAME, arguments: args };
  const parts = [
    frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } }),
    frame("response.function_call_arguments.done", { item_id: call.id, output_index: 0, arguments: args }),
    frame("response.output_item.done", { output_index: 0, item: call }),
    frame("response.completed", {
      response: {
        output: [{
          ...call,
          arguments: JSON.stringify({ target_file: "/tmp/other.js", offset: 1, limit: 10 }),
        }],
      },
    }),
  ];
  await assert.rejects(
    pipeline(
      Readable.from(parts),
      new NamespaceToolCallTransform(bridge.namespaces, "text/event-stream", "grok-oauth/grok-4.6"),
      new Writable({
        write(_chunk, _encoding, next) {
          next();
        },
      }),
    ),
    /function relay arguments changed after close|structured arguments changed after completion/,
  );
});

test("run_terminal_command restores to native exec_command", async () => {
  const bridge = setup();
  const args = JSON.stringify({ command: "git status", working_directory: "/tmp/repo" });
  const events = await relay(bridge, RUN_TERMINAL_COMMAND_TOOL_NAME, args);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.name, "exec_command");
  assert.equal(done.item.arguments, compileRunTerminalCommand(args));
});
