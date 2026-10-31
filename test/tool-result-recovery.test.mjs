import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { privateFileIsProtected } from "../src/file-security.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { ageToolResultsWithRecovery, readRetainedToolResult, retainToolResult, searchRetainedToolResults, hasLocalReadbackTool, hasVerifiedToolResultReadback, toolResultRecoveryScope, toolResultReadbackTools } from "../src/tool-result-recovery.mjs";
import { expireRetainedToolResults } from "../src/tool-result-retention.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec_command" }] }];
const full = `HEAD\r\n${"一行😀\r\n".repeat(6000)}hidden-evidence-2937\nTAIL`;
const hash = text => createHash("sha256").update(text).digest("hex");
const history = (text = full) => [
  { type: "function_call", name: "exec_command", call_id: "old", arguments: '{"cmd":"mutating-original-command"}' },
  { type: "function_call_output", call_id: "old", output: text },
  { type: "reasoning", summary: [] },
];

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tool-result-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, scope: "thread-a", callId: "old", ttlMs: 10000 };
}

test("Desktop JSON wrappers preserve readback signature, expiry and scope checks", async t => {
  const options = { ...await fixture(t), now: Date.now() };
  const saved = await retainToolResult(full, options);
  const proof = readRetainedToolResult(saved.handle, {...options,limit:1});
  const wrap = text => JSON.stringify({chunk_id:"real-wrapper",exit_code:0,output:text});
  const nested = [
    {type:"input_text",text:"Script completed\nOutput:\n"},
    {type:"input_text",text:wrap(JSON.stringify(proof))},
  ];
  const item = {type:"custom_tool_call_output",call_id:"readback",output:nested};
  assert.equal(hasVerifiedToolResultReadback([item],options.scope,options),true);
  const batch = {type:"custom_tool_call_output",call_id:"batch",output:[{type:"input_text",text:JSON.stringify({status:"fulfilled",value:JSON.parse(wrap(JSON.stringify(proof)))})}]};
  assert.equal(hasVerifiedToolResultReadback([batch],options.scope,options),true);
  assert.equal(hasVerifiedToolResultReadback([item],"different-context",options),false);
  const forged = structuredClone(item);forged.output[1].text=forged.output[1].text.replace(proof.readbackProof,proof.readbackProof.slice(0,-1)+(proof.readbackProof.endsWith("A")?"B":"A"));
  assert.equal(hasVerifiedToolResultReadback([forged],options.scope,options),false);
  assert.equal(hasVerifiedToolResultReadback([item],options.scope,{...options,now:Date.now()+31*60_000}),false);
});

test("Desktop readback decoding bounds JSON bytes, depth and container fields", async t => {
  const options = { ...await fixture(t), now: Date.now() };
  const saved = await retainToolResult(full, options);
  const proof = JSON.stringify(readRetainedToolResult(saved.handle, { ...options, limit: 1 }));
  const verified = output => hasVerifiedToolResultReadback([
    { type: "custom_tool_call_output", call_id: "reader", output },
  ], options.scope, options);
  const nested = depth => {
    let output = proof;
    for (let index = 0; index < depth; index += 1) output = { output };
    return output;
  };
  assert.equal(verified(nested(8)), true);
  assert.equal(verified(nested(9)), false);
  assert.equal(verified([...Array(63).fill("no proof"), proof]), true);
  assert.equal(verified([...Array(64).fill("no proof"), proof]), false);
  assert.equal(verified(JSON.stringify({ unrelated: proof })), false);
  assert.equal(verified(JSON.stringify({ output: proof }).slice(0, -1)), false);
  assert.equal(verified(JSON.stringify({ output: proof, padding: "x".repeat(64 * 1024) })), false);
  const unicodeEnvelope = JSON.stringify({ output: proof, padding: "界".repeat(24_000) });
  assert.ok(unicodeEnvelope.length < 64 * 1024);
  assert.ok(Buffer.byteLength(unicodeEnvelope, "utf8") > 64 * 1024);
  assert.equal(verified(unicodeEnvelope), false, "the documented limit is UTF-8 bytes");
});

test("aging accepts a Desktop-wrapped receipt only after verified local readback", async t => {
  const options = { ...await fixture(t), now: Date.now() };
  const input = history();
  const retain = (text, info) => retainToolResult(text, { ...options, ...info });
  const pending = await ageToolResultsWithRecovery(input, { tools, frontier: 0, retain });
  assert.equal(pending.stats.toolResultsAged, 0);
  assert.ok(pending.input[1].output.startsWith(full));
  const savedFile = readdirSync(options.directory).find(name => name.endsWith(".result"));
  const proof = readRetainedToolResult(savedFile.slice(0, -7), { ...options, limit: 1 });
  input.push({ type: "custom_tool_call_output", call_id: "reader", output: [
    { type: "input_text", text: JSON.stringify({ exit_code: 0, output: JSON.stringify(proof) }) },
  ] });
  const result = await ageToolResultsWithRecovery(input, { tools, frontier: 0, retain });
  assert.equal(result.stats.toolResultsAged, 1);
  assert.equal(input[1].output, full, "the original history remains intact");
  assert.equal(result.input[0], input[0], "call arguments are unchanged");
  assert.match(result.input[1].output, /tool-result-read.mjs/u);
  assert.ok(result.input[1].output.length < full.length, "the middle is omitted after proof verification");
  assert.match(result.input[1].output, /hidden-evidence-2937/u, "the end excerpt is retained");
});

test("scope search returns exact evidence only from the reference permission scope", async t => {
  const options={...await fixture(t),now:Date.now()};
  const reference=await retainToolResult("reference without the requested value",options);
  const exact="prefix\r\n😀needle-7439\r\nactual original evidence\r\ntail";
  const saved=await retainToolResult(exact,{...options,callId:"matching"});
  const foreign=await retainToolResult("needle-7439 FOREIGN PRIVATE RESULT",{...options,scope:"other-thread",callId:"foreign"});
  const result=searchRetainedToolResults(reference.handle,{...options,find:"needle-7439",limit:2000});
  assert.equal(result.complete,true);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].handle,saved.handle);
  assert.equal(result.matches[0].text,exact);
  assert.equal(JSON.stringify(result).includes(foreign.handle),false);
  assert.equal(JSON.stringify(result).includes("FOREIGN PRIVATE RESULT"),false);
  assert.equal(hasVerifiedToolResultReadback([{type:"function_call_output",output:JSON.stringify(result)}],options.scope,options),true);
  const absent=searchRetainedToolResults(reference.handle,{...options,find:"FOREIGN PRIVATE RESULT"});
  assert.deepEqual(absent.matches,[]);
  assert.equal(absent.complete,true);
  const cli=spawnSync(process.execPath,[path.join(root,"src/tool-result-read.mjs"),reference.handle,"--store",options.directory,"--scope-search","--find","needle-7439"],{encoding:"utf8",timeout:20000,windowsHide:true});
  assert.equal(cli.status,0,cli.stderr);
  assert.equal(JSON.parse(cli.stdout).matches[0].text,exact);
  for(const args of [
    ["--scope-search"],
    ["--cursor","1"],
    ["--scope-search","--find","x","--offset","1"],
    ["--scope-search","--scope-search","--find","x"],
  ]){
    const bad=spawnSync(process.execPath,[path.join(root,"src/tool-result-read.mjs"),reference.handle,"--store",options.directory,...args],{encoding:"utf8",timeout:20000,windowsHide:true});
    assert.notEqual(bad.status,0);
  }
});

test("scope search bounds excerpts, detects index changes, and cannot treat corrupt evidence as absent", async t => {
  const options={...await fixture(t),now:Date.now()};const saved=[];
  for(let i=0;i<4;i++)saved.push(await retainToolResult(`😀needle-${i}\r\n${"evidence\n".repeat(50)}`,{...options,callId:String(i)}));
  const first=searchRetainedToolResults(saved[0].handle,{...options,find:"needle",limit:20});
  assert.equal(first.matches.length,1);
  assert.equal(first.complete,false);
  assert.ok(first.matches[0].text.length<=21);
  const next=searchRetainedToolResults(saved[0].handle,{...options,find:"needle",limit:20,cursor:first.nextCursor,index:first.index});
  assert.notEqual(next.matches[0].handle,first.matches[0].handle);
  assert.throws(()=>searchRetainedToolResults(saved[0].handle,{...options,find:"needle",cursor:first.nextCursor,index:"bad-index"}),{code:"search_changed"});
  await retainToolResult("new entry",{...options,callId:"new-entry"});
  assert.throws(()=>searchRetainedToolResults(saved[0].handle,{...options,find:"needle",cursor:first.nextCursor,index:first.index}),{code:"search_changed"});
  writeFileSync(path.join(options.directory,`${saved[1].handle}.result`),"corrupt");
  const unavailable=searchRetainedToolResults(saved[0].handle,{...options,find:"absent"});
  assert.equal(unavailable.complete,false);
  assert.ok(unavailable.unavailable>0);
  assert.equal(JSON.stringify(unavailable).includes(saved[1].handle),false);
  assert.throws(()=>searchRetainedToolResults(saved[1].handle,{...options,find:"needle"}),{code:"corrupt"});
  assert.throws(()=>searchRetainedToolResults(saved[0].handle,{...options,find:"needle",now:Date.now()+20000}),{code:"expired"});
});

test("scope search authenticates its reference and rejects invalid ranges", async t => {
  const options = { ...await fixture(t), now: Date.now() };
  const saved = await retainToolResult("😀needle", options);
  const search = extra => searchRetainedToolResults(saved.handle, { ...options, find: "needle", ...extra });
  for (const find of [undefined, "", "x".repeat(2001)]) {
    assert.throws(() => search({ find }), { code: "invalid_search" });
  }
  for (const extra of [{ limit: 0 }, { limit: 16001 }, { limit: NaN }, { cursor: -1 }, { cursor: 0.5 }]) {
    assert.throws(() => search(extra), { code: "invalid_range" });
  }
  assert.throws(() => search({ cursor: 1 }), { code: "search_changed" });
  assert.throws(() => searchRetainedToolResults("../invalid", { ...options, find: "needle" }), { code: "invalid_handle" });
  assert.throws(() => searchRetainedToolResults("a".repeat(43), { ...options, find: "needle" }), { code: "missing_or_expired" });
  const narrow = search({ limit: 1 });
  assert.equal(narrow.matches[0].text, "😀", "reuse the reader's surrogate-pair boundary");
  const file = path.join(options.directory, `${saved.handle}.result`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.scope = hash("forged-scope");
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => search({}), { code: "corrupt" }, "a changed scope invalidates the handle signature");
});

test("scope search paginates the 32-match cap without losing or duplicating evidence", async t => {
  const options = { ...await fixture(t), now: Date.now(),
    writeEmpty: async (file, text) => writeFileSync(file, text, { flag: "wx", mode: 0o600 }) };
  const saved = [];
  for (let i = 0; i < 33; i++) saved.push(await retainToolResult(`needle-${i}`, { ...options, callId: String(i) }));
  const first = searchRetainedToolResults(saved[0].handle, { ...options, find: "needle", limit: 16000 });
  assert.equal(first.matches.length, 32);
  assert.equal(first.complete, false);
  const last = searchRetainedToolResults(saved[0].handle, { ...options, find: "needle", limit: 16000,
    cursor: first.nextCursor, index: first.index });
  assert.equal(last.complete, true);
  assert.equal(last.nextCursor, null);
  assert.equal(last.matches.length, 1);
  assert.deepEqual(new Set([...first.matches, ...last.matches].map(item => item.handle)), new Set(saved.map(item => item.handle)));
});

test("scope search enforces byte and elapsed budgets between archives", async t => {
  const options = { ...await fixture(t), now: Date.now(),
    writeEmpty: async (file, text) => writeFileSync(file, text, { flag: "wx", mode: 0o600 }) };
  const saved = [];
  for (let i = 0; i < 3; i++) saved.push(await retainToolResult("x".repeat(8 * 1024 * 1024), { ...options, callId: String(i) }));
  t.mock.method(Date, "now", () => options.now);
  const bytes = searchRetainedToolResults(saved[0].handle, { ...options, find: "absent" });
  assert.equal(bytes.searched, 2, "two serialized 8MiB records exhaust the byte budget");
  assert.equal(bytes.complete, false);
  assert.equal(bytes.nextCursor, 2);
  let ticks = 0;
  t.mock.method(Date, "now", () => options.now + ticks++ * 1001);
  const timed = searchRetainedToolResults(saved[0].handle, { ...options, find: "absent" });
  assert.equal(timed.searched, 1, "the elapsed budget stops before the second file");
  assert.equal(timed.complete, false);
  assert.equal(timed.nextCursor, 1);
});

test("opt-in notice enables exact 16KiB recovery without bypassing proof or changing calls", async t => {
  const options = await fixture(t);
  const value = `head\n${"distinct audit row\r\n".repeat(1100)}middle-only-evidence-7439\ntail`;
  assert.ok(Buffer.byteLength(value) > 16384 && Buffer.byteLength(value) < 32768);
  const input = history(value);
  const original = JSON.stringify(input);
  const retain = (text, info) => retainToolResult(text, {...options, ...info});
  const ordinary = await ageToolResultsWithRecovery(input, {tools, frontier: 0, retain, readbackHint: true});
  assert.equal(ordinary.input, input, "default 32KiB policy does not qualify this result");
  const pending = await ageToolResultsWithRecovery(input, {tools, frontier: 0, retain, minBytes: 16384, readbackHint: true});
  assert.equal(pending.stats.toolResultsAged, 0);
  assert.ok(pending.input[1].output.startsWith(value));
  const notice = pending.input.at(-1);
  assert.equal(notice.role, "developer");
  assert.match(notice.content[0].text, /--limit 1/u);
  assert.match(notice.content[0].text, /tool-result-read.mjs/u);
  assert.equal(JSON.stringify(input), original, "neither history nor call arguments were changed");
  const filename = readdirSync(options.directory).find(n => n.endsWith(".result"));
  const proof = readRetainedToolResult(filename.slice(0,-7), {...options,limit: 1});
  const verified = [...input, {type: "function_call_output",call_id:"reader",output:JSON.stringify(proof)}];
  const result = await ageToolResultsWithRecovery(verified, {tools, frontier:0, retain, minBytes:16384, readbackHint:true});
  assert.equal(result.stats.toolResultsAged, 1);
  assert.equal(result.input.length, verified.length, "a valid proof removes the wire-only notice");
  assert.equal(result.input[0], input[0]);
  assert.match(readRetainedToolResult(filename.slice(0,-7), {...options,find:"middle-only-evidence-7439"}).text, /middle-only-evidence-7439/u);
  for (const inventory of [[], [{type:"function",name:"web_search"}]]) {
    let writes = 0;
    const denied = await ageToolResultsWithRecovery(input, {tools:inventory,frontier:0,minBytes:16384,readbackHint:true,retain(){writes++;}});
    assert.equal(denied.input,input);
    assert.equal(writes, 0, "no local tool must not archive");
  }
  let failures = 0;
  const failed = await ageToolResultsWithRecovery(input, {tools,frontier:0,minBytes:16384,readbackHint:true,retain(){failures++;throw Error("disk unavailable");}});
  assert.equal(failed.input,input,"failed storage cannot inject a readback command or omit text");
  assert.equal(failures, 1, "the injected storage failure was actually reached");
});

test("failed archive probes suppress optional hints and preserve full results", async t => {
  const options = await fixture(t);
  const saved = await retainToolResult(full, options);
  const input = [...history(),
    {type:"function_call",name:"exec_command",call_id:"failed-reader",arguments:JSON.stringify({cmd:`node tool-result-read.mjs ${saved.handle} --store denied`})},
    {type:"function_call_output",call_id:"failed-reader",output:JSON.stringify({error:"EACCES"})},
  ];
  const result = await ageToolResultsWithRecovery(input,{tools,scope:options.scope,frontier:0,readbackHint:true,retain:(text,info)=>retainToolResult(text,{...options,...info})});
  assert.equal(result.stats.toolResultsAged,0);
  assert.equal(result.input.some(x=>x.role==="developer"),false,"permission failure must not force repeated model/tool probes");
  assert.ok(result.input[1].output.startsWith(full),"failed readback preserves all original bytes");
});

test("small savings keep the default policy without extra archives or hints", async () => {
  const input=history("x".repeat(20000));
  let writes = 0;
  const result=await ageToolResultsWithRecovery(input,{tools,frontier:0,minBytes:16384,readbackHint:true,minSavingsBytes:131072,retain(){writes++;}});
  assert.equal(result.input,input);
  assert.equal(result.stats.toolResultsAged,0);
  assert.equal(writes, 0, "small opt-in cannot create an unnecessary archive");
});

test("the savings guard falls back to 32KiB while retaining proven large-result recovery", async t => {
  const options = { ...await fixture(t), now: Date.now() };
  const saved = await retainToolResult(full, options);
  const proof = readRetainedToolResult(saved.handle, { ...options, limit: 1 });
  const medium = "m".repeat(20000);
  const input = [...history(),
    { type: "function_call", name: "exec_command", call_id: "medium", arguments: "{}" },
    { type: "function_call_output", call_id: "medium", output: medium },
    { type: "reasoning", summary: [] },
    { type: "function_call_output", call_id: "reader", output: JSON.stringify(proof) },
  ];
  const writes = [];
  const result = await ageToolResultsWithRecovery(input, {
    tools, scope: options.scope, frontier: 0, minBytes: 16384, readbackHint: true, minSavingsBytes: 1024 * 1024,
    retain(text, info) { writes.push(info.callId); return retainToolResult(text, { ...options, ...info }); },
  });
  assert.deepEqual(writes, ["old"]);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.match(result.input[1].output, /Older tool result compacted/u);
  assert.equal(result.input[4].output, medium);
  assert.equal(result.input.some(item => item.role === "developer"), false);
});

test("unverified reader receipts suppress optional probes instead of requesting them repeatedly", async t => {
  const options = { ...await fixture(t), now: Date.now() };
  const saved = await retainToolResult(full, options);
  const proof = readRetainedToolResult(saved.handle, { ...options, limit: 1 });
  const other = await retainToolResult(full, { ...options, scope: "another-context" });
  const foreign = readRetainedToolResult(other.handle, { ...options, limit: 1 });
  const forged = proof.readbackProof.slice(0, -1) + (proof.readbackProof.endsWith("A") ? "B" : "A");
  const denied = output => [...history(),
    { type: "function_call", name: "exec_command", call_id: "reader",
      arguments: JSON.stringify({ cmd: `node tool-result-read.mjs ${saved.handle} --limit 1` }) },
    { type: "function_call_output", call_id: "reader", output },
  ];
  const assertSuppressed = async output => {
    const result = await ageToolResultsWithRecovery(denied(output), {
      tools, scope: options.scope, frontier: 0, readbackHint: true,
      retain: (text, info) => retainToolResult(text, { ...options, ...info }),
    });
    assert.equal(result.stats.toolResultsAged, 0);
    assert.ok(result.input[1].output.startsWith(full));
    assert.equal(result.input.some(item => item.role === "developer"), false,
      "an unsuccessful reader result must not request another optional probe");
  };
  for (const output of [
    'reader failed before returning "readbackProof"',
    JSON.stringify({ readbackProof: "invalid" }),
    JSON.stringify({ output: JSON.stringify({ ...proof, readbackProof: forged }) }),
    JSON.stringify({ exit_code: 0, output: JSON.stringify(foreign) }),
  ]) await assertSuppressed(output);
  t.mock.method(Date, "now", () => options.now + 31 * 60_000);
  await assertSuppressed(JSON.stringify(proof));
});

test("a real committed snapshot survives restart and reads exact Unicode/CRLF bytes in pages", async t => {
  const options = await fixture(t);
  const saved = await retainToolResult(full, options);
  assert.ok(privateFileIsProtected(path.join(options.directory, `${saved.handle}.result`)));
  assert.equal(saved.sha256, hash(full));
  let restored = "", offset = 0;
  while (true) {
    const page = readRetainedToolResult(saved.handle, { ...options, offset, limit: 997 });
    restored += page.text;
    offset = page.nextOffset;
    if (page.eof) break;
  }
  assert.equal(restored, full);
  const child = spawnSync(process.execPath, [path.join(root, "src/tool-result-read.mjs"), saved.handle,
    "--store", options.directory, "--find", "hidden-evidence-2937"], {
    encoding: "utf8", timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr);
  const answer = JSON.parse(child.stdout);
  assert.match(answer.text, /hidden-evidence-2937/u);
  assert.equal(answer.sha256, saved.sha256);
  assert.equal(readRetainedToolResult(saved.handle, { ...options, find: "absent" }).found, false);
  for (const range of [{offset: -1}, {limit: 0}, {limit: 16001}, {offset: Infinity}]) {
    assert.throws(() => readRetainedToolResult(saved.handle, {...options, ...range}), {code: "invalid_range"});
  }
  const cli = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "tool-result-aging", "read",
    saved.handle, "--store", options.directory, "--limit", "5"], {encoding: "utf8", timeout: 20000});
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).text, full.slice(0, 5));
});

test("aging and dense shaping publish only durable readback receipts, never rerun instructions", async t => {
  const options = await fixture(t);
  const input = history();
  const retain = (text, info) => retainToolResult(text, { ...options, ...info });
  const before = await ageToolResultsWithRecovery(input, {tools, frontier: 0, retain});
  assert.ok(before.input[1].output.startsWith(full), "an unproven client retains every original byte");
  assert.match(before.input[1].output, /readback pending/u);
  assert.equal(before.stats.toolResultsAged, 0);
  const [savedFile] = readdirSync(options.directory).filter(n => n.endsWith(".result"));
  const proof = readRetainedToolResult(savedFile.slice(0, -7), options);
  input.push({type: "function_call_output", call_id: "reader", output: JSON.stringify(proof)});
  const result = await ageToolResultsWithRecovery(input, {tools, frontier: 0, retain});
  assert.equal(result.stats.toolResultsAged, 1);
  assert.equal(input[1].output, full, "pristine input is not mutated");
  assert.equal(result.input[0], input[0]);
  assert.equal(result.input[2], input[2]);
  const receipt = result.input[1].output;
  assert.match(receipt, /tool-result-read.mjs/u);
  assert.doesNotMatch(receipt, /Repeat the preceding|mutating-original-command/u);
  const [name] = readdirSync(options.directory).filter(n => n.endsWith(".result"));
  assert.equal(readRetainedToolResult(name.slice(0, -7), options).text, full.slice(0, 2000));
  const shapeInput = history("repeated long line\n".repeat(1200));
  shapeInput.push({type: "function_call_output", call_id: "reader", output: JSON.stringify(proof)});
  const shaped = await ageToolResultsWithRecovery(shapeInput, {
    tools, denseShaping: true, retain: (text, info) => retainToolResult(text, { ...options, ...info }),
  });
  assert.equal(shaped.stats.toolResultsShaped, 1);
  assert.match(shaped.input[1].output, /Exact archived result/u);
});

test("without a local execution tool no output is rewritten or written to disk", async () => {
  for (const inventory of [undefined, [], [{ type: "function", name: "web_search" }]]) {
    const input = history();
    const result = await ageToolResultsWithRecovery(input, { tools: inventory, frontier: 0,
      retain() { assert.fail("unusable recovery must never persist"); } });
    assert.equal(result.input, input);
  }
  assert.equal(hasLocalReadbackTool(tools), true);
  assert.equal(toolResultReadbackTools({tools}), tools);
  assert.deepEqual(toolResultReadbackTools({tools, tool_choice: "none"}), []);
  assert.deepEqual(toolResultReadbackTools({tools, tool_choice: {type: "function", name: "other"}}), []);
  assert.equal(hasLocalReadbackTool([{type: "function", name: "functions__exec_command"}]), true);
  assert.equal(hasLocalReadbackTool([{type: "function", name: "exec", description: "await tools.exec_command(...)"}]), true);
  assert.equal(hasLocalReadbackTool([{type: "function", name: "exec", description: "Remote database query"}]), false);
});

test("Responses Lite additional_tools declarations reach durable, proof-gated archival", async t => {
  const options = await fixture(t);
  const liteTools = [{ type: "namespace", name: "functions", tools: [
    { type: "custom", name: "exec", description: "Use tools.exec_command(...)" },
  ] }];
  const declaration = { type: "additional_tools", role: "developer", tools: liteTools };
  const lite = extra => ({ model: "gpt-6-luna", tool_choice: "auto", input: [declaration, ...history()], ...extra });
  assert.deepEqual(toolResultReadbackTools(lite()), liteTools);
  assert.deepEqual(toolResultReadbackTools(lite({ tool_choice: undefined })), liteTools);
  assert.deepEqual(toolResultReadbackTools(lite({ input: [declaration, { ...declaration, tools: tools }] })), [...liteTools, ...tools]);
  // Explicit restrictions and top-level inventories keep their current meaning.
  assert.deepEqual(toolResultReadbackTools(lite({ tools: [] })), []);
  assert.equal(toolResultReadbackTools(lite({ tools })), tools);
  assert.deepEqual(toolResultReadbackTools(lite({ tool_choice: "none" })), []);
  assert.deepEqual(toolResultReadbackTools(lite({ tool_choice: { type: "function", name: "other" } })), []);
  assert.equal(toolResultReadbackTools(lite({ input: history() })), undefined);
  assert.equal(toolResultReadbackTools(lite({ input: [{ ...declaration, role: "user" }, ...history()] })), undefined);
  assert.equal(toolResultReadbackTools({ tools: undefined }), undefined);

  const payload = lite();
  const recover = (input, retain) => ageToolResultsWithRecovery(input, {
    tools: toolResultReadbackTools(payload), scope: options.scope, frontier: 0, retain,
  });
  let attempts = 0;
  const failed = await recover(payload.input, () => { attempts += 1; return undefined; });
  assert.equal(attempts, 1, "the declared reader makes the result a retention candidate");
  assert.equal(failed.input, payload.input);
  assert.equal(failed.stats.toolResultsAged, 0);
  const thrown = await recover(payload.input, () => { throw new Error("disk full"); });
  assert.equal(thrown.input[2].output, full);
  assert.equal(thrown.stats.toolResultsAged, 0);

  const retain = (text, info) => retainToolResult(text, { ...options, ...info });
  const pending = await recover(payload.input, retain);
  assert.ok(pending.input[2].output.startsWith(full), "an unproven client retains every original byte");
  assert.equal(pending.stats.toolResultsAged, 0);
  const [savedFile] = readdirSync(options.directory).filter(n => n.endsWith(".result"));
  const proof = readRetainedToolResult(savedFile.slice(0, -7), options);
  const forged = { ...proof, readbackProof: proof.readbackProof.slice(0, -1) + (proof.readbackProof.endsWith("A") ? "B" : "A") };
  const reader = value => ({ type: "custom_tool_call_output", call_id: "reader", output: JSON.stringify(value) });
  const invalid = await recover([...payload.input, reader(forged)], retain);
  assert.ok(invalid.input[2].output.startsWith(full));
  assert.equal(invalid.stats.toolResultsAged, 0);
  const foreign = await ageToolResultsWithRecovery([...payload.input, reader(proof)], {
    tools: toolResultReadbackTools(payload), scope: "other-thread", frontier: 0, retain,
  });
  assert.ok(foreign.input[2].output.startsWith(full));
  const aged = await recover([...payload.input, reader(proof)], retain);
  assert.equal(aged.stats.toolResultsAged, 1);
  assert.match(aged.input[2].output, /tool-result-read.mjs/u);
  assert.equal(payload.input[2].output, full, "pristine input is not mutated");
});

test("a snapshot is reused without changing content and leased across history replay", async t => {
  const options = await fixture(t);
  const start = Date.now();
  const first = await retainToolResult(full, { ...options, now: start });
  const file = path.join(options.directory, `${first.handle}.result`);
  const bytes = readFileSync(file);
  const second = await retainToolResult(full, { ...options, now: start + 20000 });
  assert.equal(second.handle, first.handle);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(readdirSync(options.directory).filter(n => n.endsWith(".result")).length, 1);
  assert.ok(readRetainedToolResult(first.handle, { ...options, now: start + 21000 }));
  const other = await retainToolResult(full, { ...options, scope: "thread-b" });
  assert.notEqual(other.handle, first.handle);
});

test("expired, swept and corrupt snapshots report unavailable evidence without executing anything", async t => {
  const options = await fixture(t);
  const start = Date.now();
  const saved = await retainToolResult(full, { ...options, now: start });
  assert.throws(() => readRetainedToolResult(saved.handle, { ...options, now: start + 11000 }), { code: "expired" });
  assert.ok(readRetainedToolResult(saved.handle, { ...options, ttlMs: 0, now: start + 11000 }));
  expireRetainedToolResults({ ...options, now: start + 11000 });
  assert.throws(() => readRetainedToolResult(saved.handle, options), { code: "missing_or_expired" });
  await retainToolResult(full, options);
  const file = path.join(options.directory, `${saved.handle}.result`);
  const record = JSON.parse(readFileSync(file)); record.text = "changed";
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => readRetainedToolResult(saved.handle, options), { code: "corrupt" });
  await assert.rejects(retainToolResult(full, options), { code: "corrupt" });
});

test("full capacity, failed disk writes and ACL failures preserve the full result and clean stages", async t => {
  const options = await fixture(t);
  const input = history();
  for (const fault of [
    { maxFiles: 0 }, { maxBytes: 1 },
    { writeEmpty() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } },
    { writeEmpty() { throw Object.assign(new Error("ACL denied"), { code: "EACCES" }); } },
  ]) {
    const result = await ageToolResultsWithRecovery(input, { tools, frontier: 0,
      retain: text => retainToolResult(text, { ...options, ...fault }),
    });
    assert.equal(result.input, input);
    assert.equal(readdirSync(options.directory).some(n => n.includes(".stage.")), false);
  }
  const tooLarge = "x".repeat(8 * 1024 * 1024 + 1);
  assert.equal(await retainToolResult(tooLarge, options), undefined);
});

test("concurrent store contention fails open, then succeeds after release", async t => {
  // This checks lock ownership, not elapsed retention time. Real Windows ACL
  // helpers can outlast the short fixture TTL under load; expiry is exercised
  // separately with an explicitly advanced clock.
  const options = { ...await fixture(t), now: Date.now() };
  const saved = await retainToolResult(full, options);
  const release = await acquireFileLock(options.directory, { realpath: false, lockfilePath: `${options.directory}.lock` });
  try {
    const input = history();
    const result = await ageToolResultsWithRecovery(input, { tools, frontier: 0,
      retain: text => retainToolResult(text, options) });
    assert.equal(result.input, input);
    const purge = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "tool-result-aging", "purge", "--yes"], {
      encoding: "utf8", timeout: 20000,
      env: {...process.env, MODEL_ROUTER_STATE_DIR: options.directory, MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR: options.directory},
    });
    assert.notEqual(purge.status, 0, "purge cannot invalidate a writer's key mid-commit");
    assert.ok(readRetainedToolResult(saved.handle, options));
  } finally { await release(); }
  assert.equal((await retainToolResult(full, options)).handle, saved.handle);
});

test("path traversal and symlinked stores/results are refused", async t => {
  const options = await fixture(t);
  for (const handle of ["../outside", "", "a".repeat(43) + "/extra"]) {
    assert.throws(() => readRetainedToolResult(handle, options), { code: "invalid_handle" });
  }
  const link = `${options.directory}-link`;
  symlinkSync(options.directory, link, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rmSync(link, { recursive: true, force: true }));
  await assert.rejects(retainToolResult(full, { ...options, directory: link }), { code: "unsafe_store" });
});

test("unpublished content is never present while the private-file helper is pending", async t => {
  const options = await fixture(t);
  let inspected = false;
  const { writePrivateFileAsync } = await import("../src/file-security.mjs");
  await retainToolResult(full, { ...options, writeEmpty: async (file, contents, settings) => {
    assert.equal(contents, "");
    assert.equal(readdirSync(options.directory).some(n => n.endsWith(".result")), false);
    inspected = true;
    await writePrivateFileAsync(file, contents, settings);
  } });
  assert.equal(inspected, true);
  assert.equal(existsSync(`${options.directory}.lock`), false);
});


test("readback attestations reject forged, expired and cross-context proofs", async t => {
  const options = await fixture(t);
  const saved = await retainToolResult(full, options);
  const page = readRetainedToolResult(saved.handle, options);
  const input = [{type: "function_call_output", output: JSON.stringify(page)}];
  assert.equal(hasVerifiedToolResultReadback(input, options.scope, options), true);
  assert.equal(hasVerifiedToolResultReadback(input, "another thread", options), false);
  assert.equal(hasVerifiedToolResultReadback(input, options.scope, {...options, now: Date.now() + 31*60000}), false);
  page.readbackProof = page.readbackProof.slice(0, -2) + "AA";
  assert.equal(hasVerifiedToolResultReadback([{type: "function_call_output", output: JSON.stringify(page)}], options.scope, options), false);
  const payload = {instructions: "rules", input: [{role: "developer", content: "workspace-write"}]};
  const a = toolResultRecoveryScope("thread", payload);
  assert.notEqual(a, toolResultRecoveryScope("thread", {...payload, input: [{role: "developer", content: "danger-full-access"}]}));
  assert.equal(a, toolResultRecoveryScope("thread", {...payload, input: [...payload.input, {role: "user", content: "next turn"}]}));
});
