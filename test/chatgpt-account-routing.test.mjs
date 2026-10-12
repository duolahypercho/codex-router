import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChatGPTSubscriptionAccount, readChatGPTAccountPoolState, writeChatGPTAccountPoolState } from "../src/chatgpt-account-pool.mjs";
import { createChatGPTAccountRoutingPlan, setChatGPTAccountRouting, readChatGPTAccountRouting, chatGPTAccountRoutingSnapshot, chatGPTAccountBoundHistory, fetchWithChatGPTAccountRouting, chatGPTQuotaCooldown, knownChatGPTAccountRoutingHeaders } from "../src/chatgpt-account-routing.mjs";
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
  for (const [status, error] of [[429, { type: "rate_limit_exceeded", message: "quota exhausted" }], [401, { code: "usage_limit_reached" }], [503, { type: "usage_limit_reached" }]]) {
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


test("native children and routed decryption inherit the parent account, independent threads stay independent", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const first = await plan("first"); await first.close();
  const parent = await plan("parent"); assert.equal(parent.profileId, ids[1]); await parent.close();
  const childHeaders = { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one", session_id: "shared-session", "thread-id": "child", "x-codex-parent-thread-id": "parent" };
  const child = await plan("child", "plain child input", { headers: childHeaders });
  assert.equal(child.profileId, ids[1]); assert.equal(child.portable, false); await child.close();
  const relay = await knownChatGPTAccountRoutingHeaders({ ...options, headers: { ...childHeaders, "thread-id": "routed-child" }, payload: { input: [{ encrypted_content: "cipher" }] } });
  assert.equal(relay["chatgpt-account-id"], "two");
  const independent = await plan("other", "plain", { headers: { ...childHeaders, "thread-id": "other", "x-codex-parent-thread-id": undefined } });
  assert.equal(independent.profileId, ids[2]); await independent.close();
  const again = await plan("parent"); assert.equal(again.portable, false); await again.close();
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


test("routed intermediate children persist owner for native grandchildren", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const a = await plan("first"); await a.close();
  const parent = await plan("parent"); assert.equal(parent.profileId, ids[1]); await parent.close();
  const base = { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one" };
  await knownChatGPTAccountRoutingHeaders({ ...options, headers: { ...base, "x-codex-parent-thread-id": "parent" }, payload: { client_metadata: { thread_id: "routed-child" }, input: [{ encrypted_content: "cipher" }] } });
  const grandchild = await plan("grandchild", "plain", { headers: { ...base, "thread-id": "grandchild", "x-codex-parent-thread-id": "routed-child" } });
  assert.equal(grandchild.profileId, ids[1]); await grandchild.close();
});

test("native child of an untracked routed parent establishes the caller's tree owner", async (t) => {
  const { options, ids, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const a = await plan("unrelated"); await a.close();
  const base = { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one" };
  const child = await plan("child", "plain", { headers: { ...base, "thread-id": "child", "x-codex-parent-thread-id": "routed-parent" } });
  assert.equal(child.profileId, ids[0]); assert.equal(child.portable, false); await child.close();
  const owner = await knownChatGPTAccountRoutingHeaders({ ...options, headers: base, payload: { client_metadata: { thread_id: "routed-parent" }, input: [{ encrypted_content: "cipher" }] } });
  assert.equal(owner["chatgpt-account-id"], "one");
});

test("tree established during a parent turn prevents subsequent quota replay", async (t) => {
  const { options, plan } = fixture(t);
  await setChatGPTAccountRouting("round-robin", options);
  const parent = await plan("parent");
  const child = await plan("child", "plain", { headers: { authorization: "Bearer synthetic-caller", "chatgpt-account-id": "one", "thread-id": "child", "x-codex-parent-thread-id": "parent" } }); await child.close();
  let calls = 0;
  const result = await fetchWithChatGPTAccountRouting(parent, "https://synthetic.test", {}, { fetchImpl: async () => { calls++; return quota(); } });
  assert.equal(calls, 1); await result.response.text(); await parent.close();
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
