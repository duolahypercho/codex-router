import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getContextSessionsSnapshot,
  registerIpcHandlers,
} from "../apps/control-center/electron/ipc.mjs";

const CODEX_ID = "019f7432-43d9-7413-8f18-5f964587f58e";
const DEEPCODE_ID = "123e4567-e89b-42d3-a456-426614174000";

test("context manager reads bounded metadata without returning conversation messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-context-sessions-"));
  const codexHome = path.join(root, "codex");
  const deepcodeHome = path.join(root, "deepcode");
  const workspace = path.join(root, "workspace");
  const priorCodexHome = process.env.CODEX_HOME;
  const priorDeepcodeHome = process.env.CODEX_ROUTER_DEEPCODE_HOME;
  try {
    await mkdir(path.join(codexHome, "sessions", "2026", "08", "17"), { recursive: true });
    await mkdir(path.join(deepcodeHome, "projects", "workspace"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: CODEX_ID, thread_name: "Router session", updated_at: "2026-08-17T10:00:00Z" })}\n`,
    );
    await writeFile(
      path.join(codexHome, "sessions", "2026", "08", "17", `rollout-2026-08-17T10-00-00-${CODEX_ID}.jsonl`),
      [
        { type: "session_meta", payload: { id: CODEX_ID, timestamp: "2026-08-17T09:00:00Z", cwd: workspace, originator: "Codex Desktop", model_provider: "codex-router" } },
        { type: "event_msg", payload: { type: "user_message", message: "TOP_SECRET_PROMPT" } },
        { type: "turn_context", payload: { model: "deepseek/deepseek-v4-pro", effort: "high", cwd: workspace } },
        { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 200000, last_token_usage: { input_tokens: 1000, cached_input_tokens: 750, total_tokens: 1100 }, total_token_usage: { total_tokens: 9000 } } } },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    await writeFile(
      path.join(deepcodeHome, "projects", "workspace", "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: workspace,
        entries: [{
          id: DEEPCODE_ID,
          summary: "Deep Code session",
          status: "completed",
          createTime: "2026-08-16T09:00:00Z",
          updateTime: "2026-08-17T09:30:00Z",
          activeTokens: 4000,
          usagePerModel: { "deepseek-v4-pro": { prompt_tokens: 5000, prompt_cache_hit_tokens: 3000, total_tokens: 5500, total_reqs: 2 } },
        }],
      }),
    );
    await writeFile(
      path.join(deepcodeHome, "projects", "workspace", `${DEEPCODE_ID}.jsonl`),
      `${JSON.stringify({ role: "user", content: "TOP_SECRET_DEEPCODE_PROMPT" })}\n`,
    );

    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_ROUTER_DEEPCODE_HOME = deepcodeHome;
    const snapshot = getContextSessionsSnapshot();

    assert.deepEqual(snapshot.counts, { total: 2, codex: 1, deepcode: 1, archived: 0 });
    assert.equal(snapshot.sessions.find((session) => session.id === CODEX_ID)?.model, "deepseek/deepseek-v4-pro");
    assert.equal(snapshot.sessions.find((session) => session.id === DEEPCODE_ID)?.model, "deepseek-v4-pro");
    assert.doesNotMatch(JSON.stringify(snapshot), /TOP_SECRET/);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorDeepcodeHome === undefined) delete process.env.CODEX_ROUTER_DEEPCODE_HOME;
    else process.env.CODEX_ROUTER_DEEPCODE_HOME = priorDeepcodeHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("session opening rejects traversal and non-UUID identifiers before launch", async () => {
  const handlers = new Map();
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    senderGuard: () => true,
  });
  const openSession = handlers.get("router-control:openHarnessSession");
  assert.equal(typeof openSession, "function");
  await assert.rejects(
    openSession({}, { harnessId: "codex", sessionId: "../../etc/passwd", surface: "terminal" }),
    /Session is invalid/,
  );
  await assert.rejects(
    openSession({}, { harnessId: "deepcode", sessionId: `${DEEPCODE_ID}/..`, surface: "terminal" }),
    /Session is invalid/,
  );
});

test("health IPC reads in-process and preserves the injected fetch boundary", async () => {
  const handlers = new Map();
  const fetchImpl = async () => { throw new Error("the reader owns fetch"); };
  const expected = {
    ok: true,
    status: 200,
    activity: { state: "idle", active: [], activeCount: 0 },
    gateway: { reachable: true },
  };
  let calls = 0;
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    fetchImpl,
    healthReader: async (options) => {
      calls += 1;
      assert.equal(options.fetchImpl, fetchImpl);
      return expected;
    },
    senderGuard: () => true,
  });

  const getHealth = handlers.get("router-control:getHealth");
  assert.equal(typeof getHealth, "function");
  assert.deepEqual(await getHealth({}), expected);
  assert.equal(calls, 1);

  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /handle\("getHealth"[\s\S]{0,100}runJson\(\["health"\]\)/);
});

test("Deep Code installation is a fixed interactive command with no settings read", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /openTerminalCommand\(npm, \["install", "-g", DEEPCODE_PACKAGE\], discoverSourceRoot\(\)\)/);
  assert.match(source, /const deepcodeSettings = path\.join\(os\.homedir\(\), "\.deepcode", "settings\.json"\)/);
  assert.doesNotMatch(source, /readFileSync\(deepcodeSettings|readBounded\(deepcodeSettings/);
  const preload = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(preload, /cwd|argv|runCommand|spawn/);
});

test("service stop and restart are rejected at the IPC boundary", async () => {
  const handlers = new Map();
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  try {
    process.env.CODEX_ROUTER_SOURCE_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
    registerIpcHandlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      BrowserWindow: { getAllWindows: () => [] },
      shell: {},
      senderGuard: () => true,
    });
    const controlService = handlers.get("router-control:controlService");
    await assert.rejects(controlService({}, { action: "stop" }), /status, start/);
    await assert.rejects(controlService({}, { action: "restart" }), /status, start/);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
  }
});

test("mutation IPC is ordered and continues after a failed action", async () => {
  const handlers = new Map();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const lifecycle = registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {
      openExternal: async (url) => {
        const name = new URL(url).hostname.split(".", 1)[0];
        order.push(`start:${name}`);
        if (name === "first") await firstGate;
        if (name === "failed") throw new Error("planned failure");
        order.push(`end:${name}`);
      },
    },
    senderGuard: () => true,
  });
  const openExternal = handlers.get("router-control:openExternal");
  const first = openExternal({}, { url: "https://first.example" });
  const failed = openExternal({}, { url: "https://failed.example" });
  const third = openExternal({}, { url: "https://third.example" });
  assert.equal(lifecycle.hasActiveMutations(), true);
  let becameIdle = false;
  const idle = lifecycle.whenMutationsIdle().then(() => { becameIdle = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:first"]);
  assert.equal(becameIdle, false);
  releaseFirst();
  await first;
  await assert.rejects(failed, /planned failure/);
  await third;
  await idle;
  assert.equal(becameIdle, true);
  assert.equal(lifecycle.hasActiveMutations(), false);
  assert.deepEqual(order, [
    "start:first",
    "end:first",
    "start:failed",
    "start:third",
    "end:third",
  ]);
});
