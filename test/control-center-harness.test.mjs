import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  getContextSessionsSnapshot,
  registerIpcHandlers,
} from "../apps/control-center/electron/ipc.mjs";

const CODEX_ID = "019f7432-43d9-7413-8f18-5f964587f58e";
const DSH_ID = "session-123e4567-e89b-42d3-a456-426614174000";
const CURSOR_ID = "223e4567-e89b-42d3-a456-426614174000";
const CURSOR_AGENT_ID = "323e4567-e89b-42d3-a456-426614174000";

test("context manager reads bounded metadata without returning conversation messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-context-sessions-"));
  const codexHome = path.join(root, "codex");
  const dshHome = path.join(root, "dsh");
  const cursorDatabase = path.join(root, "conversation-search.db");
  const cursorAgentChats = path.join(root, "cursor-agent-chats");
  const workspace = path.join(root, "workspace");
  const priorCodexHome = process.env.CODEX_HOME;
  const priorDshHome = process.env.DSH_HOME;
  const priorCursorDatabase = process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB;
  const priorCursorAgentChats = process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS;
  try {
    await mkdir(path.join(codexHome, "sessions", "2026", "08", "17"), { recursive: true });
    await mkdir(path.join(dshHome, "sessions", "--workspace--", DSH_ID), { recursive: true });
    await mkdir(path.join(dshHome, "storages"), { recursive: true });
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
      path.join(dshHome, "storages", "workspace.json"),
      JSON.stringify({
        global: { archivedSessionIds: [] },
        workspaces: [{ path: workspace, title: "DeepSeek workspace", sessionIds: [DSH_ID] }],
      }),
    );
    await writeFile(
      path.join(dshHome, "sessions", "--workspace--", DSH_ID, "session.jsonl.zstd"),
      "TOP_SECRET_DSH_COMPRESSED_TRANSCRIPT",
    );
    const cursor = new DatabaseSync(cursorDatabase);
    cursor.exec("CREATE TABLE conversations (fts_rowid INTEGER PRIMARY KEY, source TEXT, scope TEXT, id TEXT, title TEXT, branches TEXT, updated_at INTEGER, is_archived INTEGER, root_fingerprint TEXT, cache_fingerprint TEXT)");
    cursor.prepare("INSERT INTO conversations(source, scope, id, title, branches, updated_at, is_archived, root_fingerprint) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run("local", "", CURSOR_ID, "Cursor session", "TOP_SECRET_CURSOR_BRANCH", Date.parse("2026-08-17T09:45:00Z"), 0, "fingerprint");
    cursor.close();
    const cursorAgentDirectory = path.join(cursorAgentChats, "workspace", CURSOR_AGENT_ID);
    await mkdir(cursorAgentDirectory, { recursive: true });
    await writeFile(path.join(cursorAgentDirectory, "meta.json"), JSON.stringify({
      schemaVersion: 1,
      createdAtMs: Date.parse("2026-08-17T09:50:00Z"),
      updatedAtMs: Date.parse("2026-08-17T09:55:00Z"),
      cwd: workspace,
    }));
    await writeFile(path.join(cursorAgentDirectory, "transcript.jsonl"), "TOP_SECRET_CURSOR_AGENT_TRANSCRIPT");

    process.env.CODEX_HOME = codexHome;
    process.env.DSH_HOME = dshHome;
    process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB = cursorDatabase;
    process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS = cursorAgentChats;
    const snapshot = getContextSessionsSnapshot();

    assert.deepEqual(snapshot.counts, { total: 4, codex: 1, dsh: 1, cursor: 2, claude: 0, gemini: 0, openclaw: 0, archived: 0 });
    assert.equal(snapshot.sessions.find((session) => session.id === CODEX_ID)?.model, "deepseek/deepseek-v4-pro");
    assert.equal(snapshot.sessions.find((session) => session.id === DSH_ID)?.workspaceLabel, "DeepSeek workspace");
    assert.equal(snapshot.sessions.find((session) => session.id === CURSOR_ID)?.title, "Cursor session");
    assert.equal(snapshot.sessions.find((session) => session.id === CURSOR_AGENT_ID)?.provider, "Cursor Agent");
    assert.doesNotMatch(JSON.stringify(snapshot), /TOP_SECRET/);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorDshHome;
    if (priorCursorDatabase === undefined) delete process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB;
    else process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB = priorCursorDatabase;
    if (priorCursorAgentChats === undefined) delete process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS;
    else process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS = priorCursorAgentChats;
    await rm(root, { recursive: true, force: true });
  }
});

test("a busy Codex history cannot crowd Cursor sessions out of the shared index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-context-fairness-"));
  const codexHome = path.join(root, "codex");
  const dshHome = path.join(root, "dsh");
  const cursorDatabase = path.join(root, "conversation-search.db");
  const cursorAgentChats = path.join(root, "cursor-agent-chats");
  const priorCodexHome = process.env.CODEX_HOME;
  const priorDshHome = process.env.DSH_HOME;
  const priorCursorDatabase = process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB;
  const priorCursorAgentChats = process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS;
  try {
    await mkdir(codexHome, { recursive: true });
    const codexIndex = Array.from({ length: 500 }, (_, index) => JSON.stringify({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      thread_name: `Codex ${index}`,
      updated_at: new Date(Date.parse("2026-08-17T10:00:00Z") + index).toISOString(),
    })).join("\n");
    await writeFile(path.join(codexHome, "session_index.jsonl"), `${codexIndex}\n`);

    const cursor = new DatabaseSync(cursorDatabase);
    cursor.exec("CREATE TABLE conversations (source TEXT, id TEXT, title TEXT, updated_at INTEGER, is_archived INTEGER)");
    const insert = cursor.prepare("INSERT INTO conversations(source, id, title, updated_at, is_archived) VALUES(?, ?, ?, ?, ?)");
    insert.run("local", CURSOR_ID, "Local Cursor session", Date.parse("2026-08-18T10:00:00Z"), 0);
    insert.run("local", `draft-${CURSOR_ID}`, "Cursor draft", Date.parse("2026-08-18T09:00:00Z"), 1);
    insert.run("cloud-cache", `bc-${CURSOR_ID}`, "Cursor cloud session", Date.parse("2026-08-18T08:00:00Z"), 0);
    cursor.close();

    process.env.CODEX_HOME = codexHome;
    // Keep the aggregate count independent of the developer's real ~/.dsh.
    // This test supplies only Codex and Cursor fixtures; every other client
    // index must therefore resolve inside the same empty test root.
    process.env.DSH_HOME = dshHome;
    process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB = cursorDatabase;
    process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS = cursorAgentChats;
    const snapshot = getContextSessionsSnapshot();
    assert.equal(snapshot.counts.codex, 500);
    assert.equal(snapshot.counts.cursor, 3);
    assert.equal(snapshot.counts.total, 503);
    assert.equal(snapshot.sessions.find((session) => session.id === CURSOR_ID)?.resumable, true);
    assert.equal(snapshot.sessions.find((session) => session.id === `draft-${CURSOR_ID}`)?.resumable, false);
    assert.equal(snapshot.sessions.find((session) => session.id === `bc-${CURSOR_ID}`)?.provider, "Cursor Cloud");
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorDshHome;
    if (priorCursorDatabase === undefined) delete process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB;
    else process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB = priorCursorDatabase;
    if (priorCursorAgentChats === undefined) delete process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS;
    else process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS = priorCursorAgentChats;
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
    openSession({}, { harnessId: "dsh", sessionId: `${DSH_ID}/..`, surface: "terminal" }),
    /Session is invalid/,
  );
});

test("agent bridge IPC accepts only the three fixed official clients", async () => {
  const handlers = new Map();
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    senderGuard: () => true,
  });
  const probe = handlers.get("router-control:probeAgentBridge");
  const login = handlers.get("router-control:loginAgentBridge");
  assert.equal(typeof probe, "function");
  assert.equal(typeof login, "function");
  await assert.rejects(probe({}, { bridgeId: "../../other-client" }), /Agent bridge must be one of/);
  await assert.rejects(login({}, { bridgeId: "openclaw" }), /Agent bridge must be one of/);
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

test("client setup is fixed to the six supported targets and keeps session bodies unread", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const HARNESS_IDS = \["codex", "dsh", "gemini", "cursor", "claude", "openclaw"\]/);
  assert.match(source, /const args = \["client-setup", harness\]/);
  assert.match(source, /Cursor public URL/);
  assert.match(source, /cursorConnectorRunner\(installer\.executable, installer\.args/);
  assert.match(source, /Detection and page load never mutate the host/);
  // Electron Builder packages only this app into app.asar. Router modules
  // must be loaded from the verified installed checkout, never imported by a
  // relative path that resolves outside the packaged archive at startup.
  assert.doesNotMatch(source, /from ["']\.\.\/\.\.\/\.\.\/src\//);
  assert.match(source, /installedRouterModule\("cursor-cloudflare-tunnel\.mjs"\)/);
  assert.match(source, /installedRouterModule\("client-restart-notice\.mjs"\)/);
  assert.match(source, /installedRouterModule\("agent-bridges\.mjs"\)/);
  assert.doesNotMatch(source, /\["agents", "(?:status|probe)"/);
  const connectorHandler = source.slice(
    source.indexOf('handleAction("prepareCursorTunnel"'),
    source.indexOf('handleAction("openHarnessSession"'),
  );
  assert.doesNotMatch(connectorHandler, /openTerminalCommand/);
  assert.doesNotMatch(source, /readFileSync\([^\n]*session\.jsonl\.zstd/);
  const preload = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(preload, /cwd|argv|runCommand|spawn/);
});

test("Claude setup reuses the exact CLI path detected outside a GUI PATH", async () => {
  const handlers = new Map();
  const calls = [];
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    harnessExecutableResolver: (name) => {
      assert.equal(name, "claude");
      return "/Users/test/.local/bin/claude";
    },
    controlJsonRunner: async (args, options) => {
      calls.push({ args, options });
      return { configured: true };
    },
    senderGuard: () => true,
  });

  const setup = handlers.get("router-control:setupHarness");
  assert.deepEqual(await setup({}, { harnessId: "claude" }), { configured: true });
  assert.deepEqual(calls, [{
    args: ["client-setup", "claude"],
    options: {
      timeoutMs: 11 * 60_000,
      environmentOverrides: { CLAUDE_CODE_BIN: "/Users/test/.local/bin/claude" },
    },
  }]);
});

test("Claude setup refuses a missing CLI before starting the router installer", async () => {
  const handlers = new Map();
  let called = false;
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    harnessExecutableResolver: () => undefined,
    controlJsonRunner: async () => { called = true; },
    senderGuard: () => true,
  });

  const setup = handlers.get("router-control:setupHarness");
  await assert.rejects(
    setup({}, { harnessId: "claude" }),
    /Claude Code is not installed.*refresh Harness/,
  );
  assert.equal(called, false);
});

test("OpenClaw setup stays a fixed one-click router command even when the CLI is missing", async () => {
  const handlers = new Map();
  const calls = [];
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    harnessExecutableResolver: () => undefined,
    controlJsonRunner: async (args, options) => {
      calls.push({ args, options });
      return { installedNow: true, configured: true };
    },
    senderGuard: () => true,
  });

  const setup = handlers.get("router-control:setupHarness");
  assert.deepEqual(
    await setup({}, { harnessId: "openclaw" }),
    { installedNow: true, configured: true },
  );
  assert.deepEqual(calls, [{
    args: ["client-setup", "openclaw"],
    options: { timeoutMs: 11 * 60_000 },
  }]);
});

test("app actions open the official site when a client has no app surface", async () => {
  const handlers = new Map();
  const opened = [];
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: { openExternal: async (url) => { opened.push(url); } },
    cursorAppPath: () => undefined,
    openclawAppPath: () => undefined,
    harnessExecutableResolver: () => undefined,
    senderGuard: () => true,
  });

  const launch = handlers.get("router-control:launchHarness");
  assert.deepEqual(
    await launch({}, { harnessId: "openclaw", surface: "app" }),
    { opened: true, surface: "site" },
  );
  assert.deepEqual(
    await launch({}, { harnessId: "cursor", surface: "app" }),
    { opened: true, surface: "site" },
  );
  assert.deepEqual(
    await launch({}, { harnessId: "dsh", surface: "app" }),
    { opened: true, surface: "site" },
  );
  assert.deepEqual(opened, [
    "https://openclaw.ai/",
    "https://cursor.com/",
    "https://github.com/deepseek-ai/deepseek-harness",
  ]);
});

test("OpenClaw app actions prefer the installed desktop companion", async () => {
  const handlers = new Map();
  const opened = [];
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {
      openExternal: async (url) => { opened.push({ type: "site", value: url }); },
      openPath: async (appPath) => { opened.push({ type: "app", value: appPath }); return ""; },
    },
    openclawAppPath: () => "/Applications/OpenClaw.app",
    senderGuard: () => true,
  });

  const launch = handlers.get("router-control:launchHarness");
  assert.deepEqual(
    await launch({}, { harnessId: "openclaw", surface: "app" }),
    { opened: true, surface: "app" },
  );
  assert.deepEqual(opened, [{ type: "app", value: "/Applications/OpenClaw.app" }]);
});

test("Cursor connector installation reports in-app progress and refresh-ready completion", async () => {
  const handlers = new Map();
  const events = [];
  let installed = false;
  let openedExternal = false;
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
      }],
    },
    shell: { openExternal: async () => { openedExternal = true; } },
    cursorConnectorExecutable: () => installed ? "/fixed/cloudflared" : undefined,
    cursorConnectorInstaller: () => ({
      executable: "/fixed/brew",
      args: ["install", "cloudflared"],
      environment: { HOMEBREW_NO_AUTO_UPDATE: "1" },
    }),
    cursorConnectorRunner: async (executable, args, options) => {
      assert.equal(executable, "/fixed/brew");
      assert.deepEqual(args, ["install", "cloudflared"]);
      assert.equal(options.kind, "install");
      options.progress("Downloading Cloudflare connector…");
      options.progress("Installing Cloudflare connector…");
      installed = true;
      return { exitCode: 0 };
    },
    senderGuard: () => true,
  });

  const prepare = handlers.get("router-control:prepareCursorTunnel");
  assert.deepEqual(await prepare({}, undefined), { installed: true });
  assert.equal(openedExternal, false);
  const messages = events.map((entry) => entry.payload.message);
  assert.equal(events.every((entry) => entry.channel === "router-control:operation"), true);
  assert.equal(messages.includes("Downloading Cloudflare connector…"), true);
  assert.equal(messages.includes("Installing Cloudflare connector…"), true);
  assert.equal(messages.includes("Cloudflare connector installed. Refreshing Cursor setup…"), true);
  assert.equal(events.at(-1).payload.status, "completed");
});

test("Cursor connector installation failure stays in-app and leaves setup unconfigured", async () => {
  const handlers = new Map();
  const events = [];
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: { send: (_channel, payload) => events.push(payload) },
      }],
    },
    shell: {},
    cursorConnectorExecutable: () => undefined,
    cursorConnectorInstaller: () => ({ executable: "/fixed/brew", args: ["install", "cloudflared"], environment: {} }),
    cursorConnectorRunner: async (_executable, _args, options) => {
      options.progress("Downloading Cloudflare connector…");
      throw new Error("planned connector failure");
    },
    senderGuard: () => true,
  });

  const prepare = handlers.get("router-control:prepareCursorTunnel");
  await assert.rejects(prepare({}, undefined), /planned connector failure/);
  assert.equal(events.some((event) => event.message === "Downloading Cloudflare connector…"), true);
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.at(-1).error, "planned connector failure");
});

test("Cloudflare sign-in stays in-app while browser authorization completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-cloudflare-login-"));
  const handlers = new Map();
  const events = [];
  const priorHome = process.env.MODEL_ROUTER_CLOUDFLARED_HOME;
  try {
    process.env.MODEL_ROUTER_CLOUDFLARED_HOME = root;
    registerIpcHandlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      BrowserWindow: {
        getAllWindows: () => [{
          isDestroyed: () => false,
          webContents: { send: (_channel, payload) => events.push(payload) },
        }],
      },
      shell: {},
      cursorConnectorExecutable: () => "/fixed/cloudflared",
      cursorConnectorRunner: async (executable, args, options) => {
        assert.equal(executable, "/fixed/cloudflared");
        assert.deepEqual(args, ["tunnel", "login"]);
        assert.equal(options.kind, "login");
        options.progress("Complete Cloudflare authorization in your browser…");
        await writeFile(path.join(root, "cert.pem"), "test certificate");
        return { exitCode: 0 };
      },
      senderGuard: () => true,
    });

    const prepare = handlers.get("router-control:prepareCursorTunnel");
    assert.deepEqual(await prepare({}, undefined), { loggedIn: true });
    assert.equal(events.some((event) => event.message === "Complete Cloudflare authorization in your browser…"), true);
    assert.equal(events.at(-1).status, "completed");
  } finally {
    if (priorHome === undefined) delete process.env.MODEL_ROUTER_CLOUDFLARED_HOME;
    else process.env.MODEL_ROUTER_CLOUDFLARED_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect Cursor resumes through install, login, quit, publish, verify, and reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-cursor-connect-"));
  const handlers = new Map();
  const events = [];
  const commands = [];
  let installed = false;
  let configured = false;
  let processReads = 0;
  let openedPath;
  const priorHome = process.env.MODEL_ROUTER_CLOUDFLARED_HOME;
  try {
    process.env.MODEL_ROUTER_CLOUDFLARED_HOME = root;
    registerIpcHandlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      BrowserWindow: {
        getAllWindows: () => [{
          isDestroyed: () => false,
          webContents: { send: (_channel, payload) => events.push(payload) },
        }],
      },
      shell: {
        openPath: async (target) => { openedPath = target; return ""; },
      },
      cursorAppPath: () => "/Applications/Cursor.app",
      cursorConnectorExecutable: () => installed ? "/fixed/cloudflared" : undefined,
      cursorConnectorInstaller: () => ({ executable: "/fixed/brew", args: ["install", "cloudflared"], environment: {} }),
      cursorConnectorRunner: async (_executable, _args, options) => {
        if (options.kind === "install") installed = true;
        if (options.kind === "login") await writeFile(path.join(root, "cert.pem"), "authorized");
        return { exitCode: 0 };
      },
      cursorHostnameResolver: async () => "codex-router-a1b2c3d4.example.com",
      cursorProcessReader: () => processReads++ === 0 ? [{ pid: 42 }] : [],
      cursorWait: async () => {},
      controlJsonRunner: async (args, options) => {
        commands.push({ args, options });
        configured = true;
        return { configured: true };
      },
      harnessSnapshotReader: () => ({
        harnesses: [{
          id: "cursor",
          tunnel: {},
          agentConfigured: configured,
          appConfigured: configured,
        }],
      }),
      senderGuard: () => true,
    });

    const connect = handlers.get("router-control:connectCursor");
    assert.deepEqual(await connect({}, {}), {
      configured: true,
      hostname: "codex-router-a1b2c3d4.example.com",
      opened: true,
    });
    assert.deepEqual(commands[0].args, [
      "client-setup", "cursor", "--hostname", "codex-router-a1b2c3d4.example.com",
    ]);
    assert.equal(openedPath, "/Applications/Cursor.app");
    assert.equal(events.some((event) => /Fully quit Cursor/.test(event.message || "")), true);
    assert.equal(events.some((event) => /routing verified/.test(event.message || "")), true);
    assert.equal(events.at(-1).status, "completed");
  } finally {
    if (priorHome === undefined) delete process.env.MODEL_ROUTER_CLOUDFLARED_HOME;
    else process.env.MODEL_ROUTER_CLOUDFLARED_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("service stop and restart are rejected at the IPC boundary", async () => {
  const handlers = new Map();
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  try {
    process.env.CODEX_ROUTER_SOURCE_ROOT = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
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
