import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChatGPTSubscriptionAccount, readChatGPTAccountPoolState, writeChatGPTAccountPoolState } from "../src/chatgpt-account-pool.mjs";
import { createChatGPTAccountRoutingPlan, setChatGPTAccountRouting, readChatGPTAccountRouting, chatGPTAccountRoutingSnapshot, chatGPTAccountBoundHistory, fetchWithChatGPTAccountRouting, chatGPTQuotaCooldown, knownChatGPTAccountRoutingHeaders, chatGPTAccountCollaboration, readChatGPTPrivateJsonBatch, readChatGPTAccountRoutingAsync } from "../src/chatgpt-account-routing.mjs";
import { writePrivateJson } from "../src/file-security.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-routing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { filePath: path.join(root, "routing.json"), poolPath: path.join(root, "pool.json"), homesDir: path.join(root, "accounts") };
  const ids = [];
  for (const name of ["one", "two", "three"]) {
    const account = createChatGPTSubscriptionAccount({ label: name, filePath: options.poolPath, homesDir: options.homesDir });
    const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url")}.${name}`;
    writePrivateJson(path.join(options.homesDir, account.id, "auth.json"), { tokens: { access_token: token, account_id: name } });
    const pool = readChatGPTAccountPoolState(options.poolPath);
    pool.accounts[account.id].identity = { accountId: name };
    pool.accounts[account.id].priority = 3 - ids.length;
    writeChatGPTAccountPoolState(pool, options.poolPath);
    ids.push(account.id);
  }
  const plan = async (session = "chat", input = "hello", extra = {}) => {
    const result = await createChatGPTAccountRoutingPlan({ ...options, headers: { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one", session_id: session }, payload: { input }, ...extra });
    if (result) t.after(() => result.close());
    return result;
  };
  return { options, ids, plan, root };
}
const quota = () => new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } });

test("default off and no-discovery never allocate or read credentials", async (t) => {
  const { options, plan } = fixture(t);
  assert.equal(await plan(), undefined);
  assert.equal(readChatGPTAccountRouting(options.filePath).enabled, false);
  await setChatGPTAccountRouting("round-robin", options);
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY;
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  try {
    assert.equal(await createChatGPTAccountRoutingPlan({ filePath: "/does-not-exist/invalid", headers: {} }), undefined);
    await assert.rejects(setChatGPTAccountRouting("fill-first", options), /requires credential discovery/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY; else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
  }
});

test("new conversations rotate, existing conversations stay on their account, fill-first pins", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); assert.equal(first.profileId, ids[0]); await first.close();
  const second = await plan("second"); assert.equal(second.profileId, ids[1]); await second.close();
  const again = await plan("first"); assert.equal(again.profileId, ids[0]); await again.close();
  await setChatGPTAccountRouting("fill-first", options);
  const third = await plan("third"); assert.equal(third.profileId, ids[0]); await third.close();
  assert.equal(chatGPTAccountRoutingSnapshot(options.filePath).sessions.count, 3);
});

test("quota refusal switches headers, saves cooldown and new affinity without touching auth files", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const authPath = path.join(options.homesDir, ids[0], "auth.json");
  const before = readFileSync(authPath);
  const selected = await plan();
  const seen = [];
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test/responses", { headers: { "content-type": "application/json" }, body: "{}" }, {
    fetchImpl: async (_url, init) => { seen.push(init.headers); return seen.length === 1 ? quota() : new Response("success"); },
  });
  assert.deepEqual(seen.map((headers) => headers["chatgpt-account-id"]), ["one", "two"]);
  assert.notEqual(seen[0].authorization, seen[1].authorization);
  assert.equal(await result.response.text(), "success");
  assert.equal(result.retries, 1);
  assert.equal(selected.profileId, ids[1]);
  assert.ok(chatGPTAccountRoutingSnapshot(options.filePath).cooldowns[ids[0]] > Date.now());
  assert.deepEqual(readFileSync(authPath), before);
  assert.doesNotMatch(readFileSync(options.filePath, "utf8"), /synthetic-caller|Bearer|access_token|\.one/);
  await selected.close();
  const next = await plan(); assert.equal(next.profileId, ids[1]); await next.close();
});

test("ordinary throttling, 401, ambiguous transport errors, and cancellation never switch", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  for (const [status, error] of [[429, { type: "rate_limit_exceeded", message: "quota exhausted" }], [401, { code: "usage_limit_reached" }], [500, { type: "usage_limit_reached" }]]) {
    const selected = await plan(`negative-${status}`);
    let calls = 0;
    const body = JSON.stringify({ error });
    const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; return new Response(body, { status }); } });
    assert.equal(await result.response.text(), body); assert.equal(calls, 1); await selected.close();
  }
  const selected = await plan("network");
  let calls = 0;
  await assert.rejects(fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; throw new Error("connection lost"); } }), /connection lost/);
  assert.equal(calls, 1); await selected.close();
  const abort = new AbortController(); const canceled = await plan("cancel", "hello", { signal: abort.signal });
  await assert.rejects(fetchWithChatGPTAccountRouting(canceled, "https://synthetic.test", { signal: abort.signal }, { fetchImpl: async () => { abort.abort(); return quota(); } }));
  await canceled.close();
});

test("all-quota candidates are tried once and original refusal is returned", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan(); let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; return quota(); } });
  assert.equal(calls, 3); assert.equal(result.response.status, 429);
  assert.equal(JSON.parse(await result.response.text()).error.type, "usage_limit_reached");
  await selected.close(); await assert.rejects(plan("new"), /No eligible/);
});

test("opaque history preserves original owner and never rotates on quota", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  for (const payload of [{ previous_response_id: "resp_old" }, { input: [{ type: "item_reference", id: "rs_old" }] }, { input: [{ type: "reasoning", encrypted_content: "cipher" }] }, { input: [{ type: "compaction" }] }, { input: [{ content: [{ type: "input_file", file_id: "file_old" }] }] }]) assert.equal(chatGPTAccountBoundHistory(payload), true);
  const bound = await plan("history", [{ type: "reasoning", encrypted_content: "cipher" }]);
  assert.equal(bound.profileId, ids[0]); let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(bound, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; return quota(); } });
  assert.equal(calls, 1); assert.equal(result.response.status, 429); await result.response.text(); await bound.close();
  await assert.rejects(plan("history", [{ encrypted_content: "cipher" }]), /account-bound history/);
});

test("disabled mode refuses previously pooled opaque history belonging to another account", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const a = await plan("a"); await a.close(); const b = await plan("b"); await b.close();
  await setChatGPTAccountRouting("off", options);
  await assert.rejects(plan("b", [{ encrypted_content: "cipher" }]), /Re-enable/);
  await assert.rejects(plan("b", "plain history"), /Re-enable/);
  assert.equal(await plan("a", [{ encrypted_content: "cipher" }]), undefined);
});

test("removed, expired, wrong-identity and login-in-progress profiles are excluded", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const pool = readChatGPTAccountPoolState(options.poolPath); pool.accounts[ids[0]].identity.accountId = "mismatch"; writeChatGPTAccountPoolState(pool, options.poolPath);
  writePrivateJson(path.join(options.homesDir, ids[1], "router-login-lease.json"), { active: "unknown" });
  const selected = await plan(); assert.equal(selected.profileId, ids[2]); await selected.close();
  writePrivateJson(path.join(options.homesDir, ids[2], "auth.json"), { tokens: { account_id: "three", access_token: `e30.${Buffer.from('{"exp":1}').toString("base64url")}.expired` } });
  await assert.rejects(plan("expired"), /No eligible/);
});

test("symlink and public credential files never become candidates", { skip: process.platform === "win32" }, async (t) => {
  const { options, ids, plan, root } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const first = path.join(options.homesDir, ids[0], "auth.json");
  const moved = path.join(root, "moved.json"); writeFileSync(moved, readFileSync(first), { mode: 0o600 }); rmSync(first); symlinkSync(moved, first);
  chmodSync(path.join(options.homesDir, ids[1], "auth.json"), 0o644);
  const selected = await plan(); assert.equal(selected.profileId, ids[2]); await selected.close();
});

test("same-conversation concurrent turns serialize until stream lease releases", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const first = await plan(); let acquired = false;
  const pending = plan().then((result) => { acquired = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(acquired, false);
  await first.quota(Date.now() + 60000); await first.next(); await first.close();
  const second = await pending; assert.equal(second.profileId, ids[1]); await second.close();
});

test("HTTP 200 terminal quota after output records cooldown without replay", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan(); let calls = 0;
  const body = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n';
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; return new Response(body, { headers: { "content-type": "text/event-stream" } }); } });
  assert.equal(await result.response.text(), body); assert.equal(calls, 1);
  assert.ok(chatGPTAccountRoutingSnapshot(options.filePath).cooldowns[ids[0]] > Date.now()); await selected.close();
});

test("quota classifier uses structured evidence and bounded recovery time", () => {
  const now = 1_700_000_000_000;
  assert.equal(chatGPTQuotaCooldown(new Response(null, { status: 429 }), '{"error":{"message":"quota exhausted"}}', now), undefined);
  assert.equal(chatGPTQuotaCooldown(new Response(null, { status: 429, headers: { "retry-after": "60" } }), '{"error":{"code":"usage_limit_reached","resets_at":1700000200}}', now), now + 200000);
});


test("unverified native collaboration is refused before any profile access, independent threads still rotate", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); await first.close();
  const parent = await plan("parent"); assert.equal(parent.profileId, ids[1]); await parent.close();
  const childHeaders = { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one", "thread-id": "child", "x-codex-parent-thread-id": "parent" };
  const before = readFileSync(options.filePath);
  // Missing profile files prove that rejection occurs before credential access.
  const savedPool = readFileSync(options.poolPath); rmSync(options.poolPath);
  await assert.rejects(plan("child", "plain", { headers: childHeaders }), /live marker-return verification/);
  await assert.rejects(knownChatGPTAccountRoutingHeaders({ ...options, headers: childHeaders, payload: { input: [{ encrypted_content: "cipher" }] } }), /live marker-return verification/);
  assert.deepEqual(readFileSync(options.filePath), before);
  writePrivateJson(options.poolPath, JSON.parse(savedPool));
  const independent = await plan("other"); assert.equal(independent.profileId, ids[2]); await independent.close();
});


test("resource handles are account-bound and policy reset safely permits new conversations", async (t) => {
  const { options, plan } = fixture(t);
  for (const payload of [{ conversation: "conv_old" }, { tools: [{ type: "file_search", vector_store_ids: ["vs_old"] }] }, { tools: [{ type: "code_interpreter", container: "cntr_old" }] }]) assert.equal(chatGPTAccountBoundHistory(payload), true);
  await setChatGPTAccountRouting("round-robin", options);
  const first = await plan(); await first.close();
  await setChatGPTAccountRouting("reset", options);
  assert.equal(chatGPTAccountRoutingSnapshot(options.filePath).sessions.count, 0);
  await assert.rejects(plan("old", [{ encrypted_content: "cipher" }]), /account-bound/);
  const fresh = await plan("new"); await fresh.close();
});

test("stable authenticated caller scope retains owner across a Codex login change", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const a = await plan("a", "hello", { callerScope: "trusted-owner" }); await a.close();
  const b = await plan("b", "hello", { callerScope: "trusted-owner" }); assert.equal(b.profileId, ids[1]); await b.close();
  const again = await plan("b", [{ encrypted_content: "cipher" }], { callerScope: "trusted-owner", headers: { authorization: "Bearer changed-login", "chatgpt-account-id": "three", session_id: "b" } });
  assert.equal(again.profileId, ids[1]); await again.close();
});


test("public CLI enables, reads, resets and disables the isolated routing policy", async (t) => {
  const { options, root } = fixture(t);
  const args = process.platform === "win32" ? ["src/control.mjs", "chatgpt-account-pool", "routing"] : ["bin/codex-router", "chatgpt-account-pool", "routing"];
  const command = process.platform === "win32" ? process.execPath : "sh";
  const run = (value) => JSON.parse(execFileSync(command, [...args, value], { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_STATE_DIR: root, CODEX_HOME: path.join(root, "codex"), MODEL_ROUTER_CHATGPT_ACCOUNT_ROUTING: options.filePath, CODEX_ROUTER_NO_DISCOVERY: "0" } }));
  assert.equal(run("round-robin").enabled, true);
  assert.equal(run("status").strategy, "round-robin");
  assert.equal(run("reset").sessions.count, 0);
  assert.equal(run("off").enabled, false);
});


test("collaboration declarations, metadata, and typed/enveloped history are gated", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const payloads = [
    { tools: [{ type: "namespace", name: "collaboration", tools: [] }] },
    { tools: [{ type: "namespace", name: "agents" }] },
    { tools: [{ type: "function", namespace: "collaboration", name: "send_message" }] },
    { tools: [{ type: "function", name: "spawn_agent" }] },
    { tools: [{ type: "function", name: "collaboration__wait_agent" }] },
    { tools: [{ type: "function", name: "collaboration__send_message" }] },
    { tools: [{ type: "function", name: "agents.list_agents" }] },
    { client_metadata: { "x-codex-parent-thread-id": "parent" } },
    { client_metadata: { "x-openai-subagent": "child" } },
    { input: [{ type: "agent_message", content: [] }] },
    { input: [{ type: "message", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAA-synthetic=" }] }] },
    { input: [{ type: "message", content: [{ type: "input_text", text: "Message Type: FOLLOWUP_" }, { type: "input_text", text: "TASK\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAA-synthetic=" }] }] },
    { input: [{ content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nSender: /root/child\nRecipient: /root" }] }] },
  ];
  for (const payload of payloads) {
    assert.equal(chatGPTAccountCollaboration(payload), true);
    await assert.rejects(plan("blocked", "plain", { payload }), /live marker-return verification/);
  }
  assert.equal(chatGPTAccountRoutingSnapshot(options.filePath).sessions.count, 0);
  assert.equal(chatGPTAccountCollaboration({ tools: [{ type: "function", name: "read_file" }], input: [{ type: "reasoning", encrypted_content: "ordinary-history" }] }), false);
  const plain = await plan("plain"); await plain.close();
});


test("default-off relay stays native, while reset history and existing pooled owners fail closed", async (t) => {
  const { options, plan } = fixture(t);
  const headers = { "thread-id": "native", "x-codex-parent-thread-id": "parent" };
  assert.equal(await knownChatGPTAccountRoutingHeaders({ ...options, headers, payload: {} }), undefined);
  await setChatGPTAccountRouting("round-robin", options);
  const selected = await plan("native", "plain", { headers: { "thread-id": "native" } }); await selected.close();
  await setChatGPTAccountRouting("off", options);
  await assert.rejects(knownChatGPTAccountRoutingHeaders({ ...options, headers, payload: {} }), /live marker-return verification/);
  await setChatGPTAccountRouting("reset", options);
  await assert.rejects(knownChatGPTAccountRoutingHeaders({ ...options, headers, payload: {} }), /owning this encrypted history is unknown/);
});


test("old pooled tree ownership remains gated after routing is disabled", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const selected = await plan("parent"); await selected.close();
  const state = readChatGPTAccountRouting(options.filePath);
  Object.values(state.sessions)[0].hasChildren = true;
  writePrivateJson(options.filePath, state);
  await assert.rejects(plan("parent"), /live marker-return verification/);
  await setChatGPTAccountRouting("off", options);
  await assert.rejects(plan("parent"), /live marker-return verification/);
});


test("reset refuses a live conversation lease and works after cleanup", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const selected = await plan();
  await assert.rejects(setChatGPTAccountRouting("reset", options), /Close active/);
  await selected.close(); assert.equal((await setChatGPTAccountRouting("reset", options)).sessions.count, 0);
});


test("reset safely reclaims a stale lease left by a crashed router", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const selected = await plan(); await selected.close();
  const directory = path.join(path.dirname(options.filePath), "chatgpt-routing-sessions", `${"a".repeat(64)}.lock`);
  mkdirSync(directory, { mode: 0o700 });
  const stale = new Date(Date.now() - 700000); utimesSync(directory, stale, stale);
  assert.equal((await setChatGPTAccountRouting("reset", options)).sessions.count, 0);
});

test("caller credentials can rotate without rebinding independent conversations", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); await first.close();
  const parent = await plan("parent"); assert.equal(parent.profileId, ids[1]); await parent.close();
  const headers = { authorization: "Bearer rotated-caller", "chatgpt-account-id": "one", "thread-id": "parent" };
  const continuation = await plan("parent", [{ encrypted_content: "cipher" }], { headers });
  assert.equal(continuation.profileId, ids[1]); await continuation.close();
  await assert.rejects(plan("child", "plain", { headers: { ...headers, "thread-id": "child", "x-codex-parent-thread-id": "parent" } }), /live marker-return verification/);
  assert.equal(chatGPTAccountRoutingSnapshot(options.filePath).sessions.count, 2);
  await setChatGPTAccountRouting("off", options);
  await assert.rejects(plan("parent", "plain", { headers }), /Re-enable/);
});


test("Code Interpreter plural file_ids remain on their owner and never replay on quota", async (t) => {
  const { options, ids, plan } = fixture(t);
  const tools = [{ type: "code_interpreter", container: { type: "auto", file_ids: ["file_owned"] } }];
  assert.equal(chatGPTAccountBoundHistory({ tools }), true);
  assert.equal(chatGPTAccountBoundHistory({ tools: [{ type: "code_interpreter", container: { type: "auto", file_ids: [] } }] }), false);
  await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); await first.close();
  const owner = await plan("files"); assert.equal(owner.profileId, ids[1]); await owner.close();
  const selected = await plan("files", "hello", { payload: { input: "hello", tools } });
  assert.equal(selected.profileId, ids[1]); assert.equal(selected.portable, false);
  let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; return quota(); } });
  assert.equal(calls, 1); assert.equal(result.response.status, 429); await result.response.text(); await selected.close();
  await assert.rejects(plan("files", "hello", { payload: { input: "hello", tools } }), /account-bound history/);
});

test("pre-release capability-scoped affinities require explicit reset instead of guessing ownership", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const selected = await plan(); await selected.close();
  const legacy = readChatGPTAccountRouting(options.filePath); delete legacy.affinityVersion;
  writePrivateJson(options.filePath, legacy);
  await assert.rejects(plan(), /Legacy ChatGPT routing ownership/);
  await assert.rejects(knownChatGPTAccountRoutingHeaders({ ...options, headers: {}, payload: {} }), /Legacy ChatGPT routing ownership/);
  const reset = await setChatGPTAccountRouting("reset", options); assert.equal(reset.sessions.count, 0);
  assert.equal(readChatGPTAccountRouting(options.filePath).affinityVersion, 2);
  await assert.rejects(plan("old", [{ encrypted_content: "cipher" }]), /account-bound history/);
  const fresh = await plan("new"); await fresh.close();
});

test("a valid streaming lease can queue a second turn beyond thirty seconds", { timeout: 45000 }, async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const first = await plan("long-stream");
  let acquired = false;
  const pending = plan("long-stream", "next", { signal: AbortSignal.timeout(44000) }).then((result) => { acquired = true; return result; });
  // Observe failures immediately while preserving the assertion below.
  pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 32000));
  assert.equal(acquired, false);
  await first.close();
  const second = await pending; assert.equal(second.profileId, ids[0]); await second.close();
});

test("waiting conversation cancellation preserves the Router timeout reason and leaves no lease", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const first = await plan("waiting");
  const controller = new AbortController();
  const reason = Object.assign(new Error("request deadline"), { code: "ERR_ROUTER_REQUEST_TIMEOUT" });
  const pending = assert.rejects(plan("waiting", "next", { signal: controller.signal }), (error) => error === reason);
  await new Promise((resolve) => setTimeout(resolve, 80)); controller.abort(reason); await pending;
  await first.close();
  const next = await plan("waiting"); await next.close();
});

test("batch verification yields to other work and rechecks descriptors after its await", { skip: process.platform === "win32" }, async (t) => {
  const { root } = fixture(t);
  const paths = ["same", "replaced", "mutated", "public"].map((name) => path.join(root, `${name}.json`));
  for (const file of paths) writePrivateJson(file, { synthetic: "original" });
  let resume; let calls = 0;
  const verifyFiles = async (files) => {
    calls++; assert.deepEqual(files, paths);
    return new Promise((resolve) => { resume = () => resolve([true, true, true, false]); });
  };
  const pending = readChatGPTPrivateJsonBatch(paths, { verifyFiles });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
  renameSync(paths[1], `${paths[1]}.old`); writePrivateJson(paths[1], { synthetic: "replacement" });
  writeFileSync(paths[2], '{"synthetic":"mutation"}');
  resume();
  const result = await pending;
  assert.deepEqual(result.get(paths[0]), { synthetic: "original" });
  for (const file of paths.slice(1)) assert.equal(result.get(file), undefined);
  const fresh = await readChatGPTPrivateJsonBatch([paths[0]], { verifyFiles: async () => { calls++; return [false]; } });
  assert.equal(fresh.get(paths[0]), undefined); assert.equal(calls, 2, "ACL results must not be cached");
});

test("batch verification rejects symlink swaps, malformed verdicts and cancellation", { skip: process.platform === "win32" }, async (t) => {
  const { root } = fixture(t);
  const file = path.join(root, "checked.json"); const other = path.join(root, "other.json");
  writePrivateJson(file, { synthetic: "checked" }); writePrivateJson(other, { synthetic: "other" });
  const result = await readChatGPTPrivateJsonBatch([file], { verifyFiles: async () => { rmSync(file); symlinkSync(other, file); return [true]; } });
  assert.equal(result.get(file), undefined);
  rmSync(file); writePrivateJson(file, { synthetic: "checked" });
  await assert.rejects(readChatGPTPrivateJsonBatch([file], { verifyFiles: async () => ["true"] }), /No eligible/);
  const controller = new AbortController(); const reason = new Error("canceled verification");
  await assert.rejects(readChatGPTPrivateJsonBatch([file], { signal: controller.signal, verifyFiles: async () => { controller.abort(reason); return [true]; } }), (error) => error === reason);
});

function restoreDiscovery(previous) {
  if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
  else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
}

test("disabled batch reader touches no paths, files or ACL helper even with an aborted signal", async () => {
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY; process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  let iterations = 0; let checks = 0;
  try {
    const paths = { [Symbol.iterator]() { iterations++; throw new Error("Paths must not be inspected"); } };
    const signal = AbortSignal.abort(new Error("already canceled"));
    const result = await readChatGPTPrivateJsonBatch(paths, { signal, verifyFiles: async () => { checks++; throw new Error("ACL must not run"); } });
    assert.equal(result.size, 0); assert.equal(iterations, 0); assert.equal(checks, 0);
  } finally { restoreDiscovery(previous); }
});

test("disabling discovery during ACL verification reads nothing and closes every descriptor", async (t) => {
  const { root } = fixture(t);
  const paths = ["first", "second"].map((name) => path.join(root, `${name}.json`));
  for (const file of paths) writePrivateJson(file, { synthetic: file });
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY; process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  const opened = []; const closed = []; let reads = 0; let resume;
  const originalOpen = fs.openSync; const originalClose = fs.closeSync; const originalRead = fs.readSync;
  t.mock.method(fs, "openSync", (...args) => { const fd = originalOpen(...args); opened.push(fd); return fd; });
  t.mock.method(fs, "closeSync", (fd) => { closed.push(fd); return originalClose(fd); });
  t.mock.method(fs, "readSync", (...args) => { reads++; return originalRead(...args); });
  syncBuiltinESMExports();
  try {
    const pending = readChatGPTPrivateJsonBatch([...paths, path.join(root, "missing.json")], {
      verifyFiles: async (files) => { assert.deepEqual(files, paths); return new Promise((resolve) => { resume = resolve; }); },
    });
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(opened.length, 2);
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1"; resume([true, true]);
    assert.equal((await pending).size, 0); assert.equal(reads, 0); assert.deepEqual(closed, opened);
    for (const fd of opened) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); restoreDiscovery(previous); }
});

test("async policy reader returns disabled state after the ACL wait but rejects invalid enabled state", async (t) => {
  const { options } = fixture(t); await setChatGPTAccountRouting("round-robin", options);
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY; process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  try {
    const enabled = await readChatGPTAccountRoutingAsync(options.filePath, { verifyFiles: async () => [true] });
    assert.equal(enabled.enabled, true);
    const disabled = await readChatGPTAccountRoutingAsync(options.filePath, { verifyFiles: async () => { process.env.CODEX_ROUTER_NO_DISCOVERY = "1"; return [true]; } });
    assert.equal(disabled.enabled, false); assert.equal(Object.keys(disabled.sessions).length, 0);
    let calls = 0;
    assert.equal((await readChatGPTPrivateJsonBatch([options.filePath], { verifyFiles: async () => { calls++; return [true]; } })).size, 0);
    assert.equal(calls, 0);
    process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
    await assert.rejects(readChatGPTAccountRoutingAsync(options.filePath, { verifyFiles: async () => [false] }), /routing policy is invalid/);
  } finally { restoreDiscovery(previous); }
});

test("discovery disabled during a cooldown read never overwrites routing ownership", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan(); const before = readFileSync(options.filePath);
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY; process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (file === options.filePath) process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    return fd;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(selected.quota(Date.now() + 60000), /requires credential discovery/);
    assert.deepEqual(readFileSync(options.filePath), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); restoreDiscovery(previous); await selected.close(); }
});

const fastRetries = { retries: 2, backoffMs: 0, sleepImpl: async () => {} };

for (const failure of ["edge", "connect-reset"]) {
  test(`pooled ${failure} retries use the same credential and body with accurate telemetry`, async (t) => {
    const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
    const selected = await plan(); const seen = []; const events = []; const body = Buffer.from("synthetic immutable request");
    const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", { body, headers: { "content-encoding": "synthetic" } }, {
      ...fastRetries, onRetry: (event) => events.push(event),
      fetchImpl: async (_url, init) => {
        seen.push(init);
        if (seen.length === 1) {
          if (failure === "connect-reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
          return new Response("edge unavailable", { status: 503 });
        }
        return new Response("success");
      },
    });
    assert.equal(await result.response.text(), "success"); assert.equal(result.retries, 1); assert.equal(events.length, 1);
    assert.deepEqual(seen.map((init) => init.headers["chatgpt-account-id"]), ["one", "one"]);
    assert.equal(seen[0].headers.authorization, seen[1].headers.authorization);
    for (const init of seen) { assert.equal(init.body, body); assert.equal(init.headers["content-encoding"], "synthetic"); }
    assert.deepEqual(chatGPTAccountRoutingSnapshot(options.filePath).cooldowns, {}); await selected.close();
  });
}

test("transport retries and quota hops share one retry allowance and count", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan(); const accounts = []; const statuses = [503, 429, 503, 200]; const events = [];
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, {
    ...fastRetries, onRetry: (event) => events.push(event),
    fetchImpl: async (_url, init) => { accounts.push(init.headers["chatgpt-account-id"]); const status = statuses.shift(); return status === 429 ? quota() : new Response("result", { status }); },
  });
  assert.equal(result.response.status, 200); await result.response.text(); assert.equal(result.retries, 3); assert.equal(events.length, 2);
  assert.deepEqual(accounts, ["one", "one", "two", "two"]); await selected.close();
});

for (const bound of ["allowance", "budget"]) {
  test(`transport ${bound} is not reset by a quota account switch`, async (t) => {
    const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
    const selected = await plan(); const accounts = []; let clock = 0;
    const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, {
      ...fastRetries, retries: bound === "allowance" ? 1 : 2, budgetMs: 10, now: () => clock,
      fetchImpl: async (_url, init) => {
        accounts.push(init.headers["chatgpt-account-id"]);
        if (accounts.length === 1) return new Response("edge", { status: 503 });
        if (accounts.length === 2) { if (bound === "budget") clock = 11; return quota(); }
        return new Response("edge exhausted", { status: 503 });
      },
    });
    assert.equal(result.response.status, 503); await result.response.text(); assert.equal(result.retries, 2);
    assert.deepEqual(accounts, ["one", "one", "two"]); await selected.close();
  });
}

test("zero retries disables transport replay without disabling explicit quota switching", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan(); const accounts = [];
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, {
    ...fastRetries, retries: 0,
    fetchImpl: async (_url, init) => { accounts.push(init.headers["chatgpt-account-id"]); return accounts.length === 1 ? quota() : new Response("edge", { status: 503 }); },
  });
  assert.equal(result.response.status, 503); await result.response.text(); assert.equal(result.retries, 1);
  assert.deepEqual(accounts, ["one", "two"]); await selected.close();
});

test("account-bound history permits same-account edge retries but cannot replay quota on another account", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan("bound-retry", [{ type: "reasoning", encrypted_content: "synthetic-cipher" }]); let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, {
    ...fastRetries, fetchImpl: async (_url, init) => { calls++; assert.equal(init.headers["chatgpt-account-id"], "one"); return calls === 1 ? new Response("edge", { status: 502 }) : quota(); },
  });
  assert.equal(result.response.status, 429); await result.response.text(); assert.equal(calls, 2); assert.equal(result.retries, 1); await selected.close();
});

test("transport exhaustion never switches profiles or creates cooldowns", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const selected = await plan(); let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { ...fastRetries, fetchImpl: async (_url, init) => { calls++; assert.equal(init.headers["chatgpt-account-id"], "one"); return new Response("edge", { status: 504 }); } });
  assert.equal(result.response.status, 504); await result.response.text(); assert.equal(calls, 3); assert.equal(result.retries, 2);
  assert.deepEqual(chatGPTAccountRoutingSnapshot(options.filePath).cooldowns, {}); await selected.close();
});

test("retry guard and cancellation stop pooled transport backoff without switching", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const guarded = await plan("guard"); let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(guarded, "https://synthetic.test", {}, { ...fastRetries, canRetry: () => false, fetchImpl: async () => { calls++; return new Response("edge", { status: 503 }); } });
  assert.equal(result.response.status, 503); await result.response.text(); assert.equal(calls, 1); await guarded.close();
  const controller = new AbortController(); const canceled = await plan("backoff", "hello", { signal: controller.signal });
  const reason = new Error("synthetic canceled backoff"); calls = 0;
  await assert.rejects(fetchWithChatGPTAccountRouting(canceled, "https://synthetic.test", { signal: controller.signal }, {
    ...fastRetries, sleepImpl: async () => { controller.abort(reason); }, fetchImpl: async () => { calls++; return new Response("edge", { status: 503 }); },
  }), (error) => error === reason);
  assert.equal(calls, 1); await canceled.close();
});


for (const entry of ["plan", "relay"]) {
  test(`discovery disabled during the initial ${entry} read refuses forwarding`, async (t) => {
    const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
    const previous = process.env.CODEX_ROUTER_NO_DISCOVERY; process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
    const originalOpen = fs.openSync; const files = [];
    t.mock.method(fs, "openSync", (file, ...args) => {
      const fd = originalOpen(file, ...args); files.push(file);
      if (file === options.filePath) process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
      return fd;
    });
    syncBuiltinESMExports();
    try {
      const request = entry === "plan" ? plan() : knownChatGPTAccountRoutingHeaders({ ...options, headers: {}, payload: {} });
      await assert.rejects(request, /requires credential discovery/);
      assert.deepEqual(files, [options.filePath]);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); restoreDiscovery(previous); }
  });
}

test("disabling discovery while selecting credentials fails closed and releases the conversation lease", async (t) => {
  const { options, plan } = fixture(t); await setChatGPTAccountRouting("fill-first", options);
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY; process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  const before = readFileSync(options.filePath); const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (path.basename(file) === "auth.json") process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    return fd;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(plan("selection-disable"), /No eligible ChatGPT account/);
    assert.deepEqual(readFileSync(options.filePath), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); restoreDiscovery(previous); }
  const next = await plan("selection-disable"); assert.equal(next.headers["chatgpt-account-id"], "one"); await next.close();
});


const interpreterHistory = [{ type: "code_interpreter_call", id: "ci_synthetic", status: "completed", code: "x = 7", container_id: "cntr_owned", outputs: [] }];

test("Code Interpreter output and nested container references bind history to its account", () => {
  assert.equal(chatGPTAccountBoundHistory({ input: interpreterHistory }), true);
  assert.equal(chatGPTAccountBoundHistory({ tools: [{ type: "code_interpreter", environment: { type: "container_reference", container_id: "cntr_owned" } }] }), true);
  assert.equal(chatGPTAccountBoundHistory({ input: [{ role: "assistant", content: [{ type: "container_file_citation", container_id: "cntr_owned" }] }] }), true);
  for (const container_id of [undefined, "", null, 123]) {
    assert.equal(chatGPTAccountBoundHistory({ input: [{ type: "code_interpreter_call", container_id }] }), false);
  }
  assert.equal(chatGPTAccountBoundHistory({ tools: [{ type: "code_interpreter", container: { type: "auto" } }] }), false);
});

test("Code Interpreter output history retains its known owner through quota and unavailable-owner refusal", async (t) => {
  const { options, ids, plan } = fixture(t); await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); await first.close();
  const owner = await plan("interpreter"); assert.equal(owner.profileId, ids[1]); await owner.close();
  const selected = await plan("interpreter", interpreterHistory); const accounts = [];
  assert.equal(selected.profileId, ids[1]); assert.equal(selected.portable, false);
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", { body: JSON.stringify({ input: interpreterHistory }) }, {
    fetchImpl: async (_url, init) => { accounts.push(init.headers["chatgpt-account-id"]); return quota(); },
  });
  assert.equal(result.response.status, 429); await result.response.text(); assert.deepEqual(accounts, ["two"]); await selected.close();
  await assert.rejects(plan("interpreter", interpreterHistory), /account-bound history/);
});

test("untracked Code Interpreter container history requires the caller account and is refused after reset", async (t) => {
  const { options, ids, plan } = fixture(t); await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); await first.close();
  const proven = await plan("untracked", interpreterHistory); assert.equal(proven.profileId, ids[0]); assert.equal(proven.portable, false); await proven.close();
  await assert.rejects(plan("unknown", interpreterHistory, { headers: { "chatgpt-account-id": "unregistered", session_id: "unknown" } }), /account-bound history/);
  await setChatGPTAccountRouting("reset", options);
  await assert.rejects(plan("untracked", interpreterHistory), /account-bound history/);
});

for (const resetMode of ["off", "round-robin"]) {
  test(`reset while ${resetMode} preserves fresh native ownership across turns and re-enabling`, async (t) => {
    const { options, ids, plan } = fixture(t);
    await setChatGPTAccountRouting(resetMode, options);
    await setChatGPTAccountRouting("reset", options);
    await setChatGPTAccountRouting("off", options);
    const opaque = [{ type: "reasoning", encrypted_content: "synthetic-old-history" }];
    await assert.rejects(plan("pre-reset", opaque), /Re-enable|account-bound/);
    assert.equal(await plan("fresh-native"), undefined);
    assert.equal(await plan("fresh-native", opaque), undefined);
    assert.equal(await plan("fresh-native", "next", { payload: { previous_response_id: "resp_new" } }), undefined);
    await assert.rejects(plan("fresh-native", opaque, { headers: { session_id: "fresh-native", "chatgpt-account-id": "two" } }), /Re-enable/);
    await assert.rejects(plan("pre-reset", opaque), /Re-enable|account-bound/);
    await setChatGPTAccountRouting("round-robin", options);
    const pooled = await plan("fresh-native", opaque);
    assert.equal(pooled.profileId, ids[0]); await pooled.close();
    await setChatGPTAccountRouting("reset", options);
    await assert.rejects(plan("fresh-native", opaque), /account-bound/);
  });
}

test("post-reset native ownership needs no pooled files and keeps native collaboration native", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("reset", options);
  rmSync(options.poolPath); rmSync(options.homesDir, { recursive: true });
  const headers = { session_id: "native-only", "chatgpt-account-id": "one" };
  const payload = { input: "fresh", tools: [{ type: "function", name: "spawn_agent" }] };
  assert.equal(await plan("native-only", "fresh", { headers, payload }), undefined);
  payload.input = [{ type: "reasoning", encrypted_content: "synthetic-native" }];
  assert.equal(await plan("native-only", "next", { headers, payload }), undefined);
  assert.equal(await knownChatGPTAccountRoutingHeaders({ ...options, headers, payload }), undefined);
  await assert.rejects(knownChatGPTAccountRoutingHeaders({ ...options, headers: { ...headers, "chatgpt-account-id": "two" }, payload }), /owning this encrypted history is unknown/);
  const saved = readFileSync(options.filePath, "utf8");
  assert.doesNotMatch(saved, /native-only|synthetic-native|"one"|authorization|access_token/);
  await assert.rejects(plan("missing-owner", "fresh", { headers: { session_id: "missing-owner" } }), /requires its ChatGPT account identity/);
});

for (const phase of ["affinity", "cooldown", "native-affinity"]) {
  test(`request cancellation during Windows ${phase} write releases routing locks and preserves policy`, { skip: process.platform === "win32" ? "Deterministic injected Windows helper on POSIX" : false }, async (t) => {
    const { options, plan } = fixture(t);
    await setChatGPTAccountRouting(phase === "native-affinity" ? "reset" : "fill-first", options);
    const controller = new AbortController(); const reason = new Error("synthetic turn deadline");
    const selected = phase === "cooldown" ? await plan("cancel-write", "hello", { signal: controller.signal }) : undefined;
    const before = readFileSync(options.filePath);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    let writer; let entered;
    const writing = new Promise((resolve) => { entered = resolve; });
    t.mock.method(childProcess, "spawn", (_command, _args, options) => {
      const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
      child.exitCode = null; child.signalCode = null; child.kills = 0;
      child.kill = () => { child.kills++; child.signalCode = "SIGTERM"; return true; };
      const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
      if (files.some((file) => file.includes(".tmp."))) { writer = child; entered(); }
      else queueMicrotask(() => { child.stdout.end(JSON.stringify(files.map(() => true))); child.exitCode = 0; child.emit("close", 0); });
      return child;
    });
    syncBuiltinESMExports(); Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      const pending = phase === "cooldown" ? selected.quota(Date.now() + 60000) : plan("cancel-write", "hello", { signal: controller.signal });
      const rejected = assert.rejects(pending, (error) => error === reason);
      await writing; controller.abort(reason); await rejected;
      assert.equal(writer.kills, 1);
      assert.deepEqual(readFileSync(options.filePath), before);
      writer.emit("close", 0);
    } finally {
      Object.defineProperty(process, "platform", descriptor); t.mock.restoreAll(); syncBuiltinESMExports();
      await selected?.close();
    }
    assert.equal(fs.existsSync(`${options.filePath}.pool-lock.lock`), false);
    assert.equal(fs.readdirSync(path.dirname(options.filePath)).some((name) => name.includes(".tmp.")), false);
    const recovered = await plan("cancel-write"); await recovered?.close();
  });
}

test("fresh native ownership cannot replay bound history on an unavailable owner after enabling", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("reset", options);
  assert.equal(await plan("native-owner"), undefined);
  await setChatGPTAccountRouting("round-robin", options);
  const pool = readChatGPTAccountPoolState(options.poolPath);
  pool.accounts[ids[0]].paused = true; writeChatGPTAccountPoolState(pool, options.poolPath);
  const before = readFileSync(options.filePath);
  await assert.rejects(plan("native-owner", [{ encrypted_content: "synthetic-owner-history" }]), /account-bound history/);
  assert.deepEqual(readFileSync(options.filePath), before);
});

test("concurrent post-reset native first turns cannot overwrite another account's owner", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("reset", options);
  const attempts = await Promise.allSettled(["one", "two"].map((id) => plan("native-race", "fresh", { headers: { session_id: "native-race", "chatgpt-account-id": id } })));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.equal(chatGPTAccountRoutingSnapshot(options.filePath).sessions.count, 1);
});

for (const mode of ["portable", "bound", "relay-closed"]) {
  test(`deadline after atomic quota write is rethrown during lock release for ${mode} turns`, async (t) => {
    const { options, ids, plan } = fixture(t);
    await setChatGPTAccountRouting("fill-first", options);
    const controller = new AbortController();
    const reason = Object.assign(new Error("synthetic deadline during policy unlock"), { code: "ERR_ROUTER_REQUEST_TIMEOUT" });
    const selected = await plan(`quota-unlock-${mode}`, mode === "bound" ? [{ encrypted_content: "synthetic-owned" }] : "hello", { signal: controller.signal });
    const originalRmdir = fs.rmdir; let canceled = false; let calls = 0;
    t.mock.method(fs, "rmdir", (target, ...args) => {
      if (String(target) === `${options.filePath}.pool-lock.lock` && !canceled) { canceled = true; controller.abort(reason); }
      return originalRmdir(target, ...args);
    });
    try {
      await assert.rejects(fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", { signal: controller.signal }, {
        canRetry: () => mode !== "relay-closed",
        fetchImpl: async () => { calls++; return quota(); },
      }), (error) => error === reason);
      assert.equal(canceled, true); assert.equal(calls, 1); assert.equal(selected.profileId, ids[0]);
      assert.ok(readChatGPTAccountRouting(options.filePath).cooldowns[ids[0]] > Date.now());
      assert.equal(fs.existsSync(`${options.filePath}.pool-lock.lock`), false);
    } finally { t.mock.restoreAll(); await selected.close(); }
    const next = await plan(`quota-unlock-${mode}`); assert.equal(next.profileId, ids[1]); await next.close();
  });
}

test("quota selection failure racing cancellation preserves the original deadline reason", async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("synthetic deadline during next selection"), { code: "ERR_ROUTER_REQUEST_TIMEOUT" });
  let calls = 0;
  const selected = {
    headers: { authorization: "Bearer synthetic", "chatgpt-account-id": "one" }, portable: true,
    async quota() {},
    async next() { controller.abort(reason); throw new Error("synthetic unrelated selection failure"); },
  };
  await assert.rejects(fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", { signal: controller.signal }, {
    fetchImpl: async () => { calls++; return quota(); },
  }), (error) => error === reason);
  assert.equal(calls, 1);
});


test("turn-state headers bind visible history to its owning account", async (t) => {
  const payload = { input: [{ role: "user", content: "visible continuation" }] };
  assert.equal(chatGPTAccountBoundHistory(payload, { "x-codex-turn-state": "synthetic-state" }), true);
  assert.equal(chatGPTAccountBoundHistory(payload, { "x-codex-turn-state": "" }), false);
  assert.equal(chatGPTAccountBoundHistory(payload), false);
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const seed = await plan("seed"); await seed.close();
  const owner = await plan("sticky"); assert.equal(owner.profileId, ids[1]); await owner.close();
  const headers = { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one", session_id: "sticky", "x-codex-turn-state": "synthetic-state" };
  const bound = await plan("sticky", payload.input, { headers });
  assert.equal(bound.profileId, ids[1]); assert.equal(bound.portable, false);
  let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(bound, "https://synthetic.test", { headers }, { fetchImpl: async (_url, init) => {
    calls++; assert.equal(init.headers["chatgpt-account-id"], "two"); assert.equal(init.headers["x-codex-turn-state"], "synthetic-state"); return quota();
  } });
  assert.equal(result.response.status, 429); await result.response.text(); assert.equal(calls, 1); await bound.close();
  assert.ok(readChatGPTAccountRouting(options.filePath).cooldowns[ids[1]] > Date.now());
  await assert.rejects(plan("sticky", payload.input, { headers }), /account-bound history/);
  await setChatGPTAccountRouting("reset", options);
  await assert.rejects(plan("sticky", payload.input, { headers }), /account-bound history/);
});

for (const kind of ["persistence", "deadline"]) {
  test(`streamed quota ${kind} failure propagates and cancels upstream without replay`, async () => {
    const reason = Object.assign(new Error(`synthetic ${kind} failure`), { code: kind === "deadline" ? "ERR_ROUTER_REQUEST_TIMEOUT" : "EACCES" });
    const controller = new AbortController();
    let calls = 0; let writes = 0; let hops = 0; let cancelReason; let closeTimer;
    let canceled;
    const cancellation = new Promise((resolve) => { canceled = resolve; });
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(Buffer.from('data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n'));
        closeTimer = setTimeout(() => stream.close(), 200);
      },
      cancel(error) { clearTimeout(closeTimer); cancelReason = error; canceled(); },
    });
    const selected = {
      headers: { "chatgpt-account-id": "one" }, portable: true,
      async quota() { writes++; if (kind === "deadline") controller.abort(reason); throw reason; },
      async next() { hops++; },
    };
    const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", { signal: controller.signal }, {
      fetchImpl: async () => { calls++; return new Response(body, { headers: { "content-type": "text/event-stream" } }); },
    });
    await assert.rejects(result.response.text(), (error) => error === reason);
    await cancellation;
    assert.equal(cancelReason, reason); assert.equal(calls, 1); assert.equal(writes, 1); assert.equal(hops, 0);
  });
}

test("streamed quota deadline during policy unlock preserves the original reason and saved cooldown", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("fill-first", options);
  const controller = new AbortController();
  const reason = Object.assign(new Error("synthetic streamed quota deadline during unlock"), { code: "ERR_ROUTER_REQUEST_TIMEOUT" });
  const selected = await plan("stream-unlock", "hello", { signal: controller.signal });
  const originalRmdir = fs.rmdir; let canceled = false; let calls = 0;
  t.mock.method(fs, "rmdir", (target, ...args) => {
    if (String(target) === `${options.filePath}.pool-lock.lock` && !canceled) { canceled = true; controller.abort(reason); }
    return originalRmdir(target, ...args);
  });
  try {
    const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", { signal: controller.signal }, { fetchImpl: async () => {
      calls++; return new Response('data: {"type":"error","error":{"type":"usage_limit_reached"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    await assert.rejects(result.response.text(), (error) => error === reason);
    assert.equal(canceled, true); assert.equal(calls, 1); assert.equal(selected.profileId, ids[0]);
    assert.ok(readChatGPTAccountRouting(options.filePath).cooldowns[ids[0]] > Date.now());
    assert.equal(fs.existsSync(`${options.filePath}.pool-lock.lock`), false);
  } finally { t.mock.restoreAll(); await selected.close(); }
  const next = await plan("stream-unlock"); assert.equal(next.profileId, ids[1]); await next.close();
});

test("streamed quota parser ignores malformed and unrelated data and persists only once", async () => {
  const chunks = [
    'data: not-json\n\ndata: null\n\ndata: {"type":"response.output_text.delta","delta":"quota exhausted"}\n\n',
    'data: {"type":"error","error":{"type":"rate_limit_exceeded"}}\n\ndata: {"type":"response.failed","response":{"error":{"co',
    'de":"usage_limit_reached"}}}\r\n\r\ndata: {"type":"error","error":{"code":"usage_limit_reached"}}\n\n',
  ];
  let calls = 0; let writes = 0; let hops = 0;
  const selected = { headers: {}, portable: true, async quota(until) { writes++; assert.ok(until > Date.now()); }, async next() { hops++; } };
  const result = await fetchWithChatGPTAccountRouting(selected, "https://synthetic.test", {}, { fetchImpl: async () => {
    calls++; return new Response(new ReadableStream({ start(stream) { for (const chunk of chunks) stream.enqueue(Buffer.from(chunk)); stream.close(); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(await result.response.text(), chunks.join("")); assert.equal(calls, 1); assert.equal(writes, 1); assert.equal(hops, 0);
});
