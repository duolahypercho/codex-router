import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertMutationCompatibility,
  discoverSourceRoot,
  runControl,
  runControlDetached,
  runControlJson,
  runRouterScript,
} from "./command-runner.mjs";

// Codex is the one client-specific adapter this panel still exposes (native
// GPT details and the current task default). Routed model identity and picker
// policy come from the shared router catalog below.
const CLIENT_TARGET = "codex";
const PRESENCE_MODES = ["always", "follow-codex"];
// Stop/restart can interrupt active router turns and downloads. Keep those
// intentional operator actions in the interactive CLI during the beta.
const SERVICE_COMMANDS = ["status", "start"];
const TRAY_COMMANDS = ["enable", "disable", "status", "restart"];
const SUBAGENT_MODES = ["all", "selected", "proven"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"];
const LOCAL_RUNTIME_COMMANDS = ["start", "update"];
const RETENTION_MIN_TTL_DAYS = 1;
const RETENTION_MAX_TTL_DAYS = 3_650;
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,200}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const CHATGPT_ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const LOCAL_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_UUID_IN_FILENAME = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const HARNESS_IDS = ["codex", "deepcode"];
const HARNESS_SURFACES = ["app", "terminal"];
const SESSION_INDEX_LIMIT = 16 * 1024 * 1024;
const SESSION_EDGE_BYTES = 256 * 1024;
const SESSION_LIST_LIMIT = 500;
// Catalog publishers now wait on a cross-process lock before probing Codex
// and committing all coupled model files. Leave room for both the bounded
// lock wait and the build itself; killing the lock holder at the old 30/120s
// limits would strand a stale lock and force a rollback to race recovery.
const CATALOG_MUTATION_TIMEOUT_MS = 330_000;
// Repair reruns the installer with --force-deps, which rebuilds node_modules
// and the Python environment from scratch. That is the slowest thing this app
// can start, so it gets the runner's whole ceiling rather than a catalog-sized
// budget; timing it out early would leave a half-rebuilt tree behind.
const REPAIR_TIMEOUT_MS = 11 * 60_000;
const DEEPCODE_PACKAGE = "@vegamo/deepcode-cli";
const DEEPCODE_DOCS = "https://api-docs.deepseek.com/quick_start/agent_integrations/deepcode";
const CODEX_DOCS = "https://developers.openai.com/codex/cli/";
const OAUTH_LOGIN_COMMANDS = Object.freeze({
  "kimi-oauth": { executable: "kimi", args: ["login"] },
  "grok-oauth": { executable: "grok", args: ["login", "--oauth"] },
  "devin-cli": { executable: "devin", args: ["auth", "login"] },
});
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];
const CHATGPT_LOGIN_URL = /^https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"'<>]+$/;

function cleanText(value, fallback = "", limit = 240) {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function safeTimestamp(value, fallback = undefined) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function executablePath(name) {
  const directories = new Set();
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (path.isAbsolute(directory)) directories.add(directory);
  }
  for (const directory of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(os.homedir(), ".npm-global", "bin"),
    path.join(os.homedir(), ".local", "bin"),
    ...(process.platform === "win32"
      ? [
          process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : undefined,
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs") : undefined,
          process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined,
        ]
      : []),
  ]) {
    if (directory && path.isAbsolute(directory)) directories.add(directory);
  }
  const names = process.platform === "win32" && !path.extname(name)
    ? WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${name}${extension}`)
    : [name];
  const candidates = [...directories].flatMap((directory) => names.map((entry) => path.join(directory, entry)));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* keep looking */ }
  }
  return undefined;
}

function executableVersion(executable) {
  if (!executable) return undefined;
  // Modern Node deliberately refuses to execute batch shims with shell:false.
  // Version text is optional, so do not weaken the no-shell boundary just to
  // decorate a card on Windows.
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) return undefined;
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: process.env,
    timeout: 2_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) return undefined;
  return cleanText(String(result.stdout || result.stderr).split("\n", 1)[0], "", 80) || undefined;
}

function codexDesktopPath() {
  return [
    "/Applications/Codex.app",
    "/Applications/ChatGPT.app",
    path.join(os.homedir(), "Applications", "Codex.app"),
    path.join(os.homedir(), "Applications", "ChatGPT.app"),
  ].find((candidate) => existsSync(candidate));
}

function terminalAvailable() {
  return process.platform === "darwin" && existsSync("/usr/bin/open");
}

export function getHarnessSnapshot() {
  const codex = executablePath("codex");
  const deepcode = executablePath("deepcode");
  const npm = executablePath("npm");
  const nodeVersion = executableVersion(executablePath("node"));
  const nodeMajor = Number.parseInt(String(nodeVersion || "").replace(/^v/, "").split(".", 1)[0], 10);
  const codexVersion = executableVersion(codex);
  const deepcodeVersion = executableVersion(deepcode);
  const deepcodeSettings = path.join(os.homedir(), ".deepcode", "settings.json");
  return {
    platform: process.platform,
    terminalAvailable: terminalAvailable(),
    harnesses: [
      {
        id: "codex",
        displayName: "Codex",
        ownership: "openai",
        description: "OpenAI's desktop and terminal coding harness.",
        cliInstalled: Boolean(codex),
        ...(codexVersion ? { cliVersion: codexVersion } : {}),
        appInstalled: Boolean(codexDesktopPath()),
        configured: Boolean(codex),
        canInstall: false,
        installRequirement: codex ? undefined : "Install Codex from the official OpenAI download.",
        docsUrl: CODEX_DOCS,
      },
      {
        id: "deepcode",
        displayName: "Deep Code",
        ownership: "third-party",
        description: "A third-party terminal harness optimized for DeepSeek models.",
        cliInstalled: Boolean(deepcode),
        ...(deepcodeVersion ? { cliVersion: deepcodeVersion } : {}),
        appInstalled: false,
        // Presence only. The control center never opens this file because it can contain an API key.
        configured: existsSync(deepcodeSettings),
        canInstall: Boolean(npm) && Number.isInteger(nodeMajor) && nodeMajor >= 22 && terminalAvailable(),
        installRequirement: !npm
          ? "npm is required."
          : !Number.isInteger(nodeMajor) || nodeMajor < 22
            ? "Node.js 22 or newer is required."
            : !terminalAvailable()
              ? "Open an interactive terminal and install the package manually."
              : undefined,
        docsUrl: DEEPCODE_DOCS,
      },
    ],
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function openTerminalCommand(executable, args, cwd, { environment = {} } = {}) {
  if (!terminalAvailable()) throw new Error("Opening a terminal from the Control Center is currently available on macOS only.");
  if (!executable || !path.isAbsolute(executable) || !Array.isArray(args)) throw new Error("Harness command is unavailable.");
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Harness command is invalid.");
  const resolvedCwd = cwd ? realpathSync(cwd) : discoverSourceRoot();
  if (!statSync(resolvedCwd).isDirectory()) throw new Error("The session workspace is unavailable.");
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Terminal environment is invalid.");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Terminal environment is invalid.");
    }
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-terminal-"));
  const script = path.join(directory, "launch.command");
  const executableDirectory = path.dirname(executable);
  const node = executablePath("node");
  const searchDirectories = [...new Set([executableDirectory, node && path.dirname(node)].filter(Boolean))];
  const body = [
    "#!/bin/sh",
    `cd -- ${shellQuote(resolvedCwd)} || exit 1`,
    ...(searchDirectories.length ? [`export PATH=${shellQuote(searchDirectories.join(":"))}:"$PATH"`] : []),
    ...Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `rm -f -- ${shellQuote(script)}`,
    `rmdir -- ${shellQuote(directory)} 2>/dev/null || true`,
    `exec ${[executable, ...args].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
  writeFileSync(script, body, { encoding: "utf8", mode: 0o700, flag: "wx" });
  const opened = spawnSync("/usr/bin/open", ["-a", "Terminal", path.resolve(script)], {
    encoding: "utf8",
    env: process.env,
    timeout: 5_000,
    windowsHide: true,
    shell: false,
  });
  if (opened.error || opened.status !== 0) throw new Error("Could not open Terminal.");
  return { opened: true, surface: "terminal" };
}

// Codex owns the OAuth callback and browser hand-off for ChatGPT login. Spawn
// it detached instead of wrapping it in Terminal: the CLI starts its local
// callback server, opens the system browser, and keeps the isolated
// CODEX_HOME profile while the user completes sign-in.
export function openBrowserCommand(executable, args, cwd, { environment = {}, onExit, openExternal } = {}) {
  if (!executable || !path.isAbsolute(executable) || !Array.isArray(args)) throw new Error("Browser command is unavailable.");
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Browser command is invalid.");
  if (typeof openExternal !== "function") throw new Error("The default browser opener is unavailable.");
  const resolvedCwd = cwd ? realpathSync(cwd) : discoverSourceRoot();
  if (!statSync(resolvedCwd).isDirectory()) throw new Error("The session workspace is unavailable.");
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Browser environment is invalid.");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Browser environment is invalid.");
    }
  }
  const node = executablePath("node");
  const childPath = [...new Set([
    path.dirname(executable),
    node && path.dirname(node),
    ...String(environment.PATH || process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean))].join(path.delimiter);
  const child = spawn(executable, args, {
    cwd: resolvedCwd,
    env: { ...process.env, ...environment, PATH: childPath },
    // Codex prints the OAuth authorize URL before waiting for the callback.
    // Keep its own process detached, but observe that bounded output so the
    // router can explicitly hand the URL to macOS's default browser when the
    // CLI's best-effort opener is unavailable from a GUI-launched process.
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
    shell: false,
  });
  let browserOpened = false;
  let urlObserved = false;
  let childExited = false;
  let openingBrowser = false;
  let loginOutput = "";
  let finished = false;
  let settled = false;
  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    if (typeof onExit === "function") onExit();
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    rejectOpen(error instanceof Error ? error : new Error(String(error)));
  };
  const maybeFailAfterExit = () => {
    if (childExited && !urlObserved && !openingBrowser) {
      fail(new Error("Codex login exited before providing an OAuth browser URL."));
    }
  };
  const inspectLoginOutput = (chunk) => {
    if (urlObserved || settled) return;
    // A GUI-launched child can still emit terminal styling; remove it before
    // extracting the URL so the browser hand-off does not depend on a TTY.
    loginOutput = `${loginOutput}${String(chunk).replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")}`.slice(-128 * 1024);
    const match = loginOutput.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"'<>]+/);
    if (!match) return;
    urlObserved = true;
    openingBrowser = true;
    Promise.resolve()
      .then(() => openExternal(match[0]))
      .then(() => {
        openingBrowser = false;
        if (settled) return;
        browserOpened = true;
        settled = true;
        clearTimeout(timeout);
        resolveOpen({ opened: true, surface: "browser" });
      })
      .catch((error) => {
        openingBrowser = false;
        fail(new Error(`Could not open the default browser: ${error instanceof Error ? error.message : String(error)}`));
      });
  };
  child.stdout?.on("data", inspectLoginOutput);
  child.stderr?.on("data", inspectLoginOutput);
  const timeout = setTimeout(() => {
    if (!browserOpened) {
      try { child.kill("SIGTERM"); } catch { /* process may have exited */ }
      fail(new Error("Codex login did not provide an OAuth browser URL."));
    }
  }, 15_000);
  child.once("error", (error) => {
    console.error(`Browser login process failed: ${error.message}`);
    finish();
    fail(error);
  });
  child.once("close", () => {
    childExited = true;
    finish();
    maybeFailAfterExit();
  });
  child.unref();
  return opened;
}

function readBounded(filePath, limit = SESSION_INDEX_LIMIT) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > limit) return undefined;
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function walkRollouts(root, archived, files, depth = 0) {
  if (depth > 6 || files.length >= SESSION_LIST_LIMIT * 3) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (files.length >= SESSION_LIST_LIMIT * 3 || entry.isSymbolicLink()) break;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walkRollouts(target, archived, files, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const id = entry.name.match(SESSION_UUID_IN_FILENAME)?.[0];
      if (id) files.push({ id: id.toLowerCase(), filePath: target, archived });
    }
  }
}

function readFileEdges(filePath) {
  let descriptor;
  try {
    const stat = statSync(filePath);
    descriptor = openSync(filePath, "r");
    if (stat.size <= SESSION_EDGE_BYTES * 2) {
      return [{ text: readFileSync(filePath, "utf8"), skipFirst: false, stat }];
    }
    const first = Buffer.alloc(SESSION_EDGE_BYTES);
    const tail = Buffer.alloc(SESSION_EDGE_BYTES);
    const firstLength = readSync(descriptor, first, 0, first.length, 0);
    const tailLength = readSync(descriptor, tail, 0, tail.length, stat.size - tail.length);
    return [
      { text: first.subarray(0, firstLength).toString("utf8"), skipFirst: false, stat },
      { text: tail.subarray(0, tailLength).toString("utf8"), skipFirst: true, stat },
    ];
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function codexRolloutMetadata(filePath) {
  let sessionMeta;
  let turnContext;
  let tokenInfo;
  let stat;
  for (const edge of readFileEdges(filePath)) {
    stat = edge.stat;
    const lines = edge.text.split("\n");
    if (edge.skipFirst) lines.shift();
    for (const line of lines) {
      if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === "session_meta") sessionMeta ||= entry.payload;
      else if (entry?.type === "turn_context") turnContext = entry.payload;
      else if (entry?.payload?.type === "token_count") tokenInfo = entry.payload.info;
    }
  }
  const lastUsage = tokenInfo?.last_token_usage || {};
  const totalUsage = tokenInfo?.total_token_usage || {};
  const workspace = cleanText(turnContext?.cwd || sessionMeta?.cwd, "", 1024) || undefined;
  const model = cleanText(turnContext?.model, "", 200) || undefined;
  return {
    workspace,
    workspaceLabel: workspace ? cleanText(path.basename(workspace), workspace, 100) : undefined,
    model,
    provider: cleanText(model?.includes("/") ? model.split("/", 1)[0] : sessionMeta?.model_provider, "", 100) || undefined,
    effort: cleanText(turnContext?.effort, "", 40) || undefined,
    originator: cleanText(sessionMeta?.originator, "", 80) || undefined,
    createdAt: safeTimestamp(sessionMeta?.timestamp),
    activeTokens: finiteNumber(lastUsage.total_tokens),
    contextWindow: finiteNumber(tokenInfo?.model_context_window || turnContext?.model_context_window || sessionMeta?.context_window),
    inputTokens: finiteNumber(lastUsage.input_tokens),
    cachedInputTokens: finiteNumber(lastUsage.cached_input_tokens),
    totalTokens: finiteNumber(totalUsage.total_tokens),
    fileUpdatedAt: stat ? new Date(stat.mtimeMs).toISOString() : undefined,
  };
}

function codexIndexEntries(codexHome) {
  const text = readBounded(path.join(codexHome, "session_index.jsonl"));
  const entries = new Map();
  for (const line of text?.split("\n") || []) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const id = typeof item?.id === "string" && SESSION_UUID.test(item.id) ? item.id.toLowerCase() : undefined;
      if (!id) continue;
      const next = {
        title: cleanText(item.thread_name, "Untitled Codex task", 240),
        updatedAt: safeTimestamp(item.updated_at),
      };
      const current = entries.get(id);
      if (!current || String(next.updatedAt || "") >= String(current.updatedAt || "")) entries.set(id, next);
    } catch { /* ignore a partial row */ }
  }
  return entries;
}

function codexSessions() {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const names = codexIndexEntries(codexHome);
  const files = [];
  walkRollouts(path.join(codexHome, "sessions"), false, files);
  walkRollouts(path.join(codexHome, "archived_sessions"), true, files);
  const byId = new Map();
  for (const file of files) {
    // The live rollout tree also contains subagent turns. The task index is
    // the authority for which root sessions belong in this continuity list.
    if (!file.archived && !names.has(file.id)) continue;
    const metadata = codexRolloutMetadata(file.filePath);
    const indexed = names.get(file.id);
    const updatedAt = indexed?.updatedAt || metadata.fileUpdatedAt || new Date(0).toISOString();
    const session = {
      id: file.id,
      harnessId: "codex",
      title: indexed?.title || (file.archived ? "Archived Codex task" : "Untitled Codex task"),
      updatedAt,
      ...metadata,
      archived: file.archived,
      resumable: !file.archived,
      status: file.archived ? "archived" : "saved",
    };
    const current = byId.get(file.id);
    if (!current || session.updatedAt >= current.updatedAt) byId.set(file.id, session);
  }
  for (const [id, indexed] of names) {
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      harnessId: "codex",
      title: indexed.title,
      updatedAt: indexed.updatedAt || new Date(0).toISOString(),
      archived: false,
      resumable: true,
      status: "saved",
    });
  }
  return [...byId.values()];
}

function sumDeepcodeUsage(entry, modelNames) {
  const records = entry?.usagePerModel && typeof entry.usagePerModel === "object"
    ? modelNames.map((model) => entry.usagePerModel[model]).filter((value) => value && typeof value === "object")
    : entry?.usage && typeof entry.usage === "object" ? [entry.usage] : [];
  const sum = (key) => records.reduce((total, usage) => total + (finiteNumber(usage[key]) || 0), 0);
  return {
    inputTokens: sum("prompt_tokens") || undefined,
    cachedInputTokens: sum("prompt_cache_hit_tokens") || undefined,
    totalTokens: sum("total_tokens") || undefined,
    requestCount: sum("total_reqs") || undefined,
  };
}

function deepcodeSessions() {
  const deepcodeHome = path.resolve(process.env.CODEX_ROUTER_DEEPCODE_HOME || path.join(os.homedir(), ".deepcode"));
  const projectsRoot = path.join(deepcodeHome, "projects");
  let projects;
  try { projects = readdirSync(projectsRoot, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const project of projects.slice(0, SESSION_LIST_LIMIT)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const text = readBounded(path.join(projectsRoot, project.name, "sessions-index.json"), 2 * 1024 * 1024);
    if (!text) continue;
    let index;
    try { index = JSON.parse(text); } catch { continue; }
    const workspace = cleanText(index?.originalPath, "", 1024) || undefined;
    const entries = Array.isArray(index?.entries) ? index.entries.slice(0, 100) : [];
    for (const entry of entries) {
      if (typeof entry?.id !== "string" || !SESSION_UUID.test(entry.id)) continue;
      const modelNames = entry?.usagePerModel && typeof entry.usagePerModel === "object"
        ? Object.keys(entry.usagePerModel).filter((model) => typeof model === "string").slice(0, 12)
        : [];
      const createdAt = safeTimestamp(entry.createTime || entry.createdAt);
      const updatedAt = safeTimestamp(entry.updateTime || entry.updatedAt, createdAt || new Date(0).toISOString());
      sessions.push({
        id: entry.id.toLowerCase(),
        harnessId: "deepcode",
        title: cleanText(entry.summary || entry.title, "Untitled Deep Code task", 240),
        updatedAt,
        ...(createdAt ? { createdAt } : {}),
        ...(workspace ? { workspace, workspaceLabel: cleanText(path.basename(workspace), workspace, 100) } : { workspaceLabel: cleanText(project.name, "Deep Code project", 100) }),
        ...(modelNames.length ? { model: modelNames.at(-1), modelHistory: modelNames } : {}),
        provider: "Deep Code",
        status: cleanText(entry.status, "saved", 40),
        archived: false,
        resumable: true,
        activeTokens: finiteNumber(entry.activeTokens),
        ...sumDeepcodeUsage(entry, modelNames),
      });
    }
  }
  return sessions;
}

export function getContextSessionsSnapshot() {
  const sessions = [...codexSessions(), ...deepcodeSessions()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, SESSION_LIST_LIMIT);
  return {
    fetchedAt: new Date().toISOString(),
    sessions,
    counts: {
      total: sessions.length,
      codex: sessions.filter((session) => session.harnessId === "codex").length,
      deepcode: sessions.filter((session) => session.harnessId === "deepcode").length,
      archived: sessions.filter((session) => session.archived).length,
    },
  };
}

function stringValue(value, label, pattern = undefined) {
  if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value.trim()))) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function oneOf(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label} must be one of: ${values.join(", ")}.`);
  return value;
}

async function snapshot() {
  return runControlJson(["--json"]);
}

async function modelEntries() {
  const result = await snapshot();
  const entries = [];
  const seen = new Set();
  // The router catalog is the durable source for routed models. Keep the
  // Codex target's native entries as an adapter-only supplement because those
  // models come from the user's OpenAI session rather than the router plane.
  const targetModels = Array.isArray(result?.targets?.[CLIENT_TARGET]?.models)
    ? result.targets[CLIENT_TARGET].models
    : [];
  const adapterModels = result?.catalog
    ? targetModels.filter((model) => model.native)
    : targetModels;
  for (const model of [
    ...(Array.isArray(result?.catalog?.models) ? result.catalog.models : []),
    ...adapterModels,
  ]) {
    if (!model?.slug || seen.has(model.slug)) continue;
    seen.add(model.slug);
    entries.push(model);
  }
  return entries;
}

async function providerEntries() {
  const result = await runControlJson(["providers"]);
  return result?.providers || [];
}

async function validateProvider(providerId, capability) {
  const id = stringValue(providerId, "Provider", PROVIDER_ID);
  const provider = (await providerEntries()).find((entry) => String(entry.id) === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  if (capability === "credential" && provider.kind !== "api") {
    throw new Error(`${provider.displayName || id} does not accept an API credential.`);
  }
  if (capability === "sign-in" && provider.kind !== "oauth") {
    throw new Error(`${provider.displayName || id} does not support CLI sign-in.`);
  }
  return { id, provider };
}

async function validateCatalogProvider(providerId) {
  const id = stringValue(providerId, "Provider catalog", PROVIDER_ID);
  const providers = await providerEntries();
  for (const provider of providers) {
    const sources = Array.isArray(provider.catalogSources) ? provider.catalogSources : [];
    const source = sources.find((entry) => String(entry?.id) === id);
    if (source) return { id, provider, source };
    // Compatibility with an older router snapshot: its canonical row has no
    // source descriptors, but discovery of that exact id was already allowed.
    if (String(provider.id) === id && sources.length === 0) return { id, provider };
  }
  throw new Error(`Unknown provider catalog: ${id}`);
}

async function validateModel(slug) {
  const value = stringValue(slug, "Model", MODEL_SLUG);
  const models = await modelEntries();
  if (!models.some((model) => model.slug === value)) throw new Error(`Unknown model: ${value}`);
  return value;
}

function validateLocalTag(tag) {
  const raw = stringValue(tag, "Local model");
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error("Local model URL is invalid."); }
    if (parsed.protocol !== "https:" || !["ollama.com", "www.ollama.com"].includes(parsed.hostname.toLowerCase())) {
      throw new Error("Use an HTTPS Ollama model-page URL.");
    }
    const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts.length < 2 || parts[0] === "search") throw new Error("That URL does not contain an Ollama model tag.");
    const candidate = parts[0] === "library" ? parts.slice(1).join("/") : parts.join("/");
    if (!LOCAL_TAG.test(candidate)) throw new Error("Local model reference is invalid.");
    return candidate.includes(":") ? candidate : `${candidate}:latest`;
  }
  const value = stringValue(raw, "Local model", LOCAL_TAG);
  if (value.includes("//")) throw new Error("Local model reference is invalid.");
  return value.includes(":") ? value : `${value}:latest`;
}

async function runJson(args, options = {}) {
  return runControlJson(args, options);
}

// Mirrors `control tool-result-aging ttl <days|off|default>`. The bounds come
// from src/tool-result-retention.mjs; validating here keeps an out-of-range
// number from reaching the CLI as a confusing subprocess failure.
function retentionTtlArgument(days) {
  if (days === "default" || days === "off" || days === "never") return days;
  const value = Number(days);
  if (!Number.isInteger(value)) throw new Error("Retention TTL must be a whole number of days.");
  if (value === 0) return "off";
  if (value < RETENTION_MIN_TTL_DAYS || value > RETENTION_MAX_TTL_DAYS) {
    throw new Error(`Retention TTL must be between ${RETENTION_MIN_TTL_DAYS} and ${RETENTION_MAX_TTL_DAYS} days.`);
  }
  return String(value);
}

async function updateProviderSelection(id, enabled) {
  // `set-apply` owns selection, publication, and rollback under one shared
  // model-overlay lock. Splitting those commands here lets a failed apply
  // restore a snapshot older than another process's successful toggle.
  await runControl(
    // Provider selection and publication are shared by every installed
    // client. Leaving targets to control.mjs makes this true even when the
    // Control Center was opened from a Codex-only view.
    ["set-apply", id, enabled ? "on" : "off"],
    { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS },
  );
  return snapshot();
}

export function registerIpcHandlers({ ipcMain, BrowserWindow, shell, fetchImpl = globalThis.fetch, senderGuard = () => true } = {}) {
  if (!ipcMain?.handle) throw new TypeError("ipcMain.handle is required.");
  const operations = new Map();
  // Every mutation is a fresh control.mjs process. Keep their read/modify/
  // apply/rollback sequences in one order so two rapid UI actions cannot race
  // each other's snapshots or restore stale state. Reads remain concurrent.
  let mutationTail = Promise.resolve();
  let pendingMutations = 0;
  // A detached OAuth process can outlive the IPC call. Keep one browser login
  // per isolated account so a double-click cannot race two Codex callbacks.
  const subscriptionLoginInFlight = new Set();
  const idleWaiters = new Set();
  const enqueueMutation = (task) => {
    pendingMutations += 1;
    const queued = mutationTail.then(task);
    mutationTail = queued.then(() => undefined, () => undefined);
    return queued.finally(() => {
      pendingMutations -= 1;
      if (pendingMutations === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    });
  };
  const whenMutationsIdle = () => pendingMutations === 0
    ? Promise.resolve()
    : new Promise((resolve) => idleWaiters.add(resolve));
  const emit = (payload) => {
    for (const window of BrowserWindow?.getAllWindows?.() || []) {
      if (!window.isDestroyed?.()) window.webContents.send("router-control:operation", payload);
    }
  };
  const operation = (name, fn) => async (_event, input = {}) => {
    const id = randomUUID();
    operations.set(id, name);
    emit({ id, name, action: name, status: "started", message: `${name} started` });
    try {
      const value = await fn(input);
      emit({ id, name, action: name, status: "completed", message: `${name} completed` });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Operation failed.";
      emit({ id, name, action: name, status: "failed", message: message.slice(0, 500), error: message.slice(0, 500) });
      throw new Error(message.slice(0, 500));
    } finally {
      operations.delete(id);
    }
  };
  const handle = (name, fn) => ipcMain.handle(`router-control:${name}`, (event, input) => {
    if (!senderGuard(event)) throw new Error("Untrusted IPC sender.");
    return fn(input, event);
  });
  const handleAction = (name, fn, { requiresCompatibleRouter = true } = {}) => ipcMain.handle(`router-control:${name}`, (event, input) => {
    if (!senderGuard(event)) throw new Error("Untrusted IPC sender.");
    return enqueueMutation(() => operation(name, async (value) => {
      if (requiresCompatibleRouter) assertMutationCompatibility();
      return fn(value);
    })(event, input));
  });

  handle("getSnapshot", async () => snapshot());
  handle("getChatGptSession", async () => runJson(["chatgpt-session", "status"]));
  handle("getChatGptAccountPool", async () => runJson(["chatgpt-account-pool", "status"]));
  const windowFor = (event) => {
    const window = BrowserWindow?.fromWebContents?.(event.sender);
    if (!window || window.isDestroyed?.()) throw new Error("Application window is unavailable.");
    return window;
  };
  handle("minimizeWindow", async (_input, event) => {
    windowFor(event).minimize();
    return { ok: true };
  });
  handle("toggleMaximizeWindow", async (_input, event) => {
    const window = windowFor(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return { ok: true, maximized: window.isMaximized() };
  });
  handle("closeWindow", async (_input, event) => {
    windowFor(event).close();
    return { ok: true };
  });
  handleAction("openExternal", async ({ url } = {}) => {
    if (!shell?.openExternal) throw new Error("External links are unavailable.");
    let parsed;
    try { parsed = new URL(stringValue(url, "URL")); } catch { throw new Error("URL is invalid."); }
    if (parsed.protocol !== "https:") throw new Error("Only HTTPS links can be opened.");
    await shell.openExternal(parsed.href);
    return { opened: true };
  }, { requiresCompatibleRouter: false });
  handle("getProviders", async () => runJson(["providers"]));
  handle("discoverProviderModels", async ({ providerId, refresh = false } = {}) => {
    const { id } = await validateCatalogProvider(providerId);
    if (typeof refresh !== "boolean") throw new Error("refresh must be boolean.");
    // Without --refresh the router answers from the provider's cached list, so
    // opening a provider costs no round trip and works offline. Refreshing is
    // the caller's explicit choice and is the only path that re-asks upstream.
    const result = await runRouterScript(
      "model-discovery.mjs",
      [id, "--json", ...(refresh ? ["--refresh"] : [])],
      { timeoutMs: 45_000 },
    );
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("Provider discovery returned invalid JSON.");
    }
  });
  handle("getAccountUsage", async () => runJson(["account"], { timeoutMs: 20_000 }));
  handle("getProviderUsage", async () => runJson(["provider-usage"], { timeoutMs: 20_000 }));
  handle("getLocalModels", async () => runJson(["local-models", "list", "--json"], { timeoutMs: 20_000 }));
  handle("getVisionBridge", async () => runJson(["vision-bridge", "status"], { timeoutMs: 20_000 }));
  handle("getToolResultAging", async () => runJson(["tool-result-aging", "status"], { timeoutMs: 20_000 }));
  handle("getPresence", async () => runJson(["presence", "status"]));
  handle("getHarnesses", async () => getHarnessSnapshot());
  handle("getContextSessions", async () => getContextSessionsSnapshot());
  handle("getDoctor", async () => {
    const result = await runRouterScript("doctor.mjs", ["--json"], { timeoutMs: 120_000, allowNonZero: true });
    try {
      const report = JSON.parse(result.stdout.trim());
      return { ...report, ok: result.code === 0 && report.ok !== false };
    } catch { throw new Error("Doctor returned invalid JSON."); }
  });
  // Doctor reads; repair is the one maintenance path that writes. It runs the
  // same `doctor.mjs --fix` the CLI exposes and takes no renderer arguments at
  // all, so the installer -- not this process, and certainly not the page --
  // decides what gets rewritten. --json keeps the installer's own chatter off
  // stdout, so the report below is the only thing parsed.
  //
  // requiresCompatibleRouter is off deliberately. A protocol mismatch between
  // this app and the installed router is precisely the damage repair exists to
  // undo, so gating repair on compatibility would withhold the fix exactly
  // when it is needed. Repair is also the one action that must work while the
  // service is down, which is why it reinstalls rather than merely restarting.
  handleAction("repairInstall", async () => {
    let response;
    try {
      const result = await runRouterScript("doctor.mjs", ["--fix", "--json"], {
        timeoutMs: REPAIR_TIMEOUT_MS,
        allowNonZero: true,
        environmentOverrides: { CODEX_ROUTER_DEFER_TRAY_REBUILD: "1" },
      });
      let report;
      try { report = JSON.parse(result.stdout.trim()); }
      catch { throw new Error("Repair returned invalid JSON."); }
      // A non-zero exit here means repair ran and some check still fails, not
      // that repair itself failed. Report that as a completed run with failing
      // checks so the page can name them; throwing would hide the report.
      response = { ...report, ok: result.code === 0 && report.ok !== false };
    } finally {
      // Start the detached refresh before this handler settles and releases the
      // mutation drain, including a partial repair whose final check failed. A
      // quit already waiting on repair resumes as soon as the drain clears, so
      // a timer scheduled for later can be discarded with the process and
      // strand the old companion. Spawn is nonblocking; the updater stages its
      // replacement before it asks this process to quit.
      try { await runControlDetached(["tray", "refresh"]); }
      catch { /* the next update retries a stale tray if spawn itself is unavailable */ }
    }
    return response;
  }, { requiresCompatibleRouter: false });
  // The public health leaf deliberately omits per-service payloads. The
  // control command reads the protected leaf with the local caller capability
  // and returns only the redacted service summary the UI needs.
  handle("getHealth", async () => runJson(["health"]));
  handle("refreshAll", async () => ({
    snapshot: await snapshot(),
    providers: await runJson(["providers"]),
    accountUsage: await runJson(["account"], { timeoutMs: 20_000 }),
    providerUsage: await runJson(["provider-usage"], { timeoutMs: 20_000 }),
    localModels: await runJson(["local-models", "list", "--json"], { timeoutMs: 20_000 }),
    visionBridge: await runJson(["vision-bridge", "status"]),
    presence: await runJson(["presence", "status"]),
  }));

  handleAction("setProviderEnabled", async ({ providerId, enabled = true } = {}) => {
    const { id } = await validateProvider(providerId);
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return updateProviderSelection(id, enabled);
  });
  handleAction("addProviderModels", async ({ providerId, modelIds } = {}) => {
    const { id } = await validateCatalogProvider(providerId);
    if (!Array.isArray(modelIds) || modelIds.length < 1 || modelIds.length > 200) {
      throw new Error("Choose between 1 and 200 provider models.");
    }
    const unique = [...new Set(modelIds.map((modelId) => stringValue(modelId, "Model id", MODEL_SLUG)))];
    if (unique.length !== modelIds.length) throw new Error("Provider model ids must be unique.");
    // The trusted curation script repeats live discovery, rejects ids that are
    // no longer candidates, writes the private overlay transactionally, and
    // republishes every installed client. The renderer never supplies paths,
    // credentials, request profiles, or arbitrary command arguments.
    //
    // --refresh is what keeps the first clause of that true. Browsing a
    // provider is answered from its stored list, but committing a model to the
    // picker must be checked against what the provider serves right now, or a
    // list old enough to name a withdrawn model would curate a route that
    // fails on its first real request. The added round trip is nothing beside
    // the republish this same command performs, and it leaves the stored list
    // fresh for the next visit.
    await runRouterScript(
      "curate-models.mjs",
      [id, "--models", unique.join(","), "--refresh", "--apply"],
      { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS },
    );
    return { provider: id, added: unique };
  });
  handleAction("connectProvider", async ({ providerId } = {}) => {
    if (!terminalAvailable()) {
      throw new Error("Provider CLI sign-in must be run in your own terminal on Windows or Linux.");
    }
    const { id } = await validateProvider(providerId, "sign-in");
    await runControl(["install-cli", id], { timeoutMs: 120_000 });
    const login = OAUTH_LOGIN_COMMANDS[id];
    if (!login) throw new Error(`Interactive sign-in is not available for ${id}.`);
    const executable = executablePath(login.executable);
    if (!executable) throw new Error(`The official ${login.executable} CLI was not found after installation.`);
    // The terminal belongs to the provider CLI, so Electron cannot observe
    // whether it switches accounts. Clear any account-specific model list
    // before handing off; cancellation costs one later fetch, while retaining
    // the previous account's entitlements for a day would be incorrect.
    await runControl(["catalog-cache", "invalidate", id]);
    // OAuth CLIs own browser/device authorization and may require a real TTY.
    // Never hide those prompts behind Electron's piped child-process stdio.
    return {
      ...openTerminalCommand(executable, login.args, discoverSourceRoot()),
      providerId: id,
      pending: true,
    };
  });
  handleAction("saveProviderCredential", async ({ providerId, credential } = {}) => {
    const { id } = await validateProvider(providerId, "credential");
    if (typeof credential !== "string" || !credential.trim() || credential.length > 16 * 1024) {
      throw new Error("Credential is invalid.");
    }
    // control credential owns the credential write, provider enable, and
    // publication under one cross-process model-overlay lock. Do not split a
    // second set/apply here: a concurrent removal could otherwise delete the
    // key after this child succeeds and before the follow-up enable.
    await runJson(["credential", id], {
      stdin: credential,
      timeoutMs: CATALOG_MUTATION_TIMEOUT_MS,
    });
    return runJson(["providers"]);
  });
  handleAction("removeProviderCredential", async ({ providerId } = {}) => {
    const { id } = await validateProvider(providerId, "credential");
    // The control command owns credential deletion, provider withdrawal, and
    // publication under the same lock as credential setup. Splitting a
    // pre-disable/apply here would reopen the inter-process race and publish
    // the model list twice.
    return runJson(["credential", id, "--remove"], {
      timeoutMs: CATALOG_MUTATION_TIMEOUT_MS,
    });
  });

  handleAction("setSubagentMode", async ({ mode } = {}) => {
    oneOf(mode, SUBAGENT_MODES, "Subagent mode");
    return runJson(["subagents", "mode", mode], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setSubagentModel", async ({ slug, enabled } = {}) => {
    const model = await validateModel(slug);
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["subagents", "set", model, enabled ? "on" : "off"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setSubagentEffort", async ({ slug, effort } = {}) => {
    const model = await validateModel(slug);
    oneOf(effort, EFFORTS, "Subagent effort");
    return runJson(["subagents", "effort", model, effort], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setSubagentSelection", async ({ selectAll } = {}) => {
    if (typeof selectAll !== "boolean") throw new Error("selectAll must be boolean.");
    return runJson(["subagents", selectAll ? "select-all" : "unselect-all"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setPickerModel", async ({ slug, visible } = {}) => {
    const model = await validateModel(slug);
    if (typeof visible !== "boolean") throw new Error("visible must be boolean.");
    return runJson(["picker", "set", model, visible ? "show" : "hide"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setPickerModels", async (input = {}) => {
    const { models, showAll } = input;
    // The renderer's compact "show all" control uses a boolean; bulk callers
    // may instead provide individual validated model entries.
    if (typeof models === "undefined" && typeof showAll === "boolean") {
      return runJson(["picker", "all", showAll ? "show" : "hide"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
    }
    if (!Array.isArray(models) || models.length > 500) throw new Error("models must be an array.");
    let result;
    for (const item of models) {
      const slug = typeof item === "string" ? item : item?.slug;
      const visible = typeof item === "string" ? true : item?.visible;
      if (typeof visible !== "boolean") throw new Error("Each picker model needs a boolean visible value.");
      result = await runJson(["picker", "set", await validateModel(slug), visible ? "show" : "hide"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
    }
    return result || (await runJson(["picker", "status"]));
  });

  handleAction("installLocalModel", async ({ tag, yes = false, force = false } = {}) => {
    if (typeof yes !== "boolean") throw new Error("yes must be boolean.");
    if (typeof force !== "boolean") throw new Error("force must be boolean.");
    const args = ["local-models", "install", validateLocalTag(tag)];
    if (yes) args.push("--yes");
    if (force) args.push("--force");
    return runJson(args, { timeoutMs: 330_000 });
  });
  handleAction("installLocalMlx", async ({ yes = false } = {}) => {
    if (yes !== true) throw new Error("Installing the MLX runtime and model requires explicit consent.");
    return runJson(["local-models", "mlx-install", "--yes"], { timeoutMs: 30_000 });
  });
  handleAction("cancelLocalMlx", async () => runJson(["local-models", "mlx-cancel"], { timeoutMs: 20_000 }));
  handleAction("uninstallLocalModel", async ({ tag } = {}) => runJson(["local-models", "uninstall", validateLocalTag(tag), "--yes"], { timeoutMs: 330_000 }));
  handleAction("setLocalModelEnabled", async ({ tag, enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["local-models", "set", validateLocalTag(tag), enabled ? "on" : "off"], { timeoutMs: 330_000 });
  });
  handleAction("benchmarkLocalModel", async ({ tag } = {}) => runJson(["local-models", "benchmark", validateLocalTag(tag)], { timeoutMs: 5 * 60_000 }));
  handleAction("controlLocalRuntime", async ({ action } = {}) => {
    const value = oneOf(action, LOCAL_RUNTIME_COMMANDS, "Local runtime action");
    return runJson(["local-models", "runtime", value, "--yes"], { timeoutMs: 5 * 60_000 });
  });

  handleAction("setVisionBridgeEnabled", async ({ enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["vision-bridge", enabled ? "on" : "off"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setVisionBridgeEngine", async ({ engine, effort } = {}) => {
    const value = stringValue(engine, "Vision engine", MODEL_SLUG);
    if (effort !== undefined) oneOf(effort, EFFORTS, "Vision effort");
    if (value !== "auto" && value !== "local") {
      const current = await runJson(["vision-bridge", "status"]);
      if (!Array.isArray(current?.availableEngines) || !current.availableEngines.includes(value)) {
        throw new Error(`Vision engine is not currently available: ${value}.`);
      }
    }
    return runJson(["vision-bridge", "engine", value, ...(effort === undefined ? [] : [effort])], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setVisionBridgeEffort", async ({ effort } = {}) => {
    oneOf(effort, EFFORTS, "Vision effort");
    return runJson(["vision-bridge", "effort", effort], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("downloadVisionModel", async ({ tag } = {}) => runJson(["vision-bridge", "pull", validateLocalTag(tag)], { timeoutMs: 120_000 }));
  handleAction("useLocalVisionModel", async ({ tag } = {}) => runJson(["vision-bridge", "local", validateLocalTag(tag)], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS }));
  handleAction("benchmarkVisionModel", async ({ tag } = {}) => runJson(["vision-bridge", "benchmark", validateLocalTag(tag)], { timeoutMs: 5 * 60_000 }));
  handleAction("setToolResultAging", async ({ enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["tool-result-aging", enabled ? "on" : "off"], { timeoutMs: 60_000 });
  });
  handleAction("setNativeToolResultAging", async ({ enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["tool-result-aging", "native", enabled ? "on" : "off"], { timeoutMs: 60_000 });
  });
  // `off` and `default` are distinct answers the backend keeps apart: `off`
  // stores 0 ("keep retained originals until I say otherwise") while `default`
  // clears the stored answer so a later release's number applies again.
  handleAction("setToolResultRetentionTtl", async ({ days } = {}) => {
    return runJson(["tool-result-aging", "ttl", retentionTtlArgument(days)], { timeoutMs: 60_000 });
  });
  handleAction("setDefaultModel", async ({ slug } = {}) => {
    const model = await validateModel(slug);
    await runControl(["model-set", model], { timeoutMs: 120_000 });
    return snapshot();
  });
  handleAction("setRouterDefault", async ({ slug } = {}) => {
    const model = await validateModel(slug);
    await runControl(["router-default", "set", model], { timeoutMs: 120_000 });
    return snapshot();
  });
  handleAction("clearRouterDefault", async () => {
    await runControl(["router-default", "clear"], { timeoutMs: 120_000 });
    return snapshot();
  });
  handleAction("setSignedRouting", async ({ enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["signed-routing", enabled ? "on" : "off"], { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS });
  });
  handleAction("setChatGptSessionSharing", async ({ enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    // Renderer input selects one of two fixed control verbs. The upstream
    // transaction records/revokes consent and republishes every installed
    // client catalog before this result is returned.
    return runJson(
      ["chatgpt-session", enabled ? "enable" : "disable"],
      { timeoutMs: CATALOG_MUTATION_TIMEOUT_MS },
    );
  });
  handleAction("addChatGptSubscriptionAccount", async ({ label = "" } = {}) => {
    if (typeof label !== "string" || label.length > 120 || /[\u0000]/.test(label)) {
      throw new Error("Account label is invalid.");
    }
    return runJson(["chatgpt-account-pool", "add", label.trim()], { timeoutMs: 60_000 });
  });
  handleAction("loginChatGptSubscriptionAccount", async ({ accountId } = {}) => {
    const id = stringValue(accountId, "Account id", CHATGPT_ACCOUNT_ID);
    const pool = await runJson(["chatgpt-account-pool", "status"], { timeoutMs: 20_000 });
    const account = pool?.accounts?.[id];
    if (!account) throw new Error("The subscription account is not registered.");
    if (account.state !== "active") throw new Error("The subscription account is not active.");
    if (account.subscription?.usable === true) {
      return {
        accountId: id,
        opened: false,
        surface: "browser",
        pending: false,
        alreadyAuthenticated: true,
      };
    }
    if (subscriptionLoginInFlight.has(id)) {
      return {
        accountId: id,
        opened: false,
        surface: "browser",
        pending: true,
        inProgress: true,
      };
    }
    const codex = executablePath("codex");
    if (!codex) throw new Error("Codex CLI is not installed.");
    const profile = await runJson(["chatgpt-account-pool", "home", id], { timeoutMs: 20_000 });
    if (typeof profile?.home !== "string" || !path.isAbsolute(profile.home)) {
      throw new Error("The subscription account profile is unavailable.");
    }
    const profileHome = path.resolve(profile.home);
    const primaryHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    if (path.basename(profileHome) !== id || profileHome === primaryHome) {
      throw new Error("The subscription account profile is not isolated from the primary Codex login.");
    }
    subscriptionLoginInFlight.add(id);
    try {
      return {
        ...await openBrowserCommand(codex, ["login"], discoverSourceRoot(), {
          environment: { CODEX_HOME: profileHome },
          openExternal: shell?.openExternal?.bind(shell),
          onExit: () => subscriptionLoginInFlight.delete(id),
        }),
        accountId: id,
        pending: true,
      };
    } catch (error) {
      subscriptionLoginInFlight.delete(id);
      throw error;
    }
  });
  handleAction("removeChatGptSubscriptionAccount", async ({ accountId } = {}) => {
    const id = stringValue(accountId, "Account id", CHATGPT_ACCOUNT_ID);
    return runJson(["chatgpt-account-pool", "remove", id], { timeoutMs: 60_000 });
  });
  handleAction("setChatGptAccountPoolEnabled", async ({ enabled } = {}) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean.");
    return runJson(["chatgpt-account-pool", enabled ? "enable" : "disable"], { timeoutMs: 60_000 });
  });
  handleAction("setChatGptAccountPoolMode", async ({ mode } = {}) => {
    oneOf(mode, ["switch", "pool"], "Account mode");
    return runJson(["chatgpt-account-pool", "mode", mode], { timeoutMs: 60_000 });
  });
  handleAction("setChatGptAccountPoolStrategy", async ({ strategy } = {}) => {
    oneOf(strategy, ["quota", "round-robin", "fill-first"], "Account-pool strategy");
    return runJson(["chatgpt-account-pool", "strategy", strategy], { timeoutMs: 60_000 });
  });
  handleAction("setChatGptAccountSelection", async ({ selection } = {}) => {
    const value = selection === "auto"
      ? selection
      : stringValue(selection, "Account selection", CHATGPT_ACCOUNT_ID);
    return runJson(["chatgpt-account-pool", "select", value], { timeoutMs: 60_000 });
  });
  handleAction("setPresence", async ({ mode } = {}) => runJson(["presence", "set", oneOf(mode, PRESENCE_MODES, "Presence mode")]));
  handleAction("controlService", async ({ action = "status" } = {}) => {
    const value = oneOf(action, SERVICE_COMMANDS, "Service action");
    const timeoutMs = value === "start" ? 330_000 : 120_000;
    await runControl(["service", value], { timeoutMs });
    return { action: value, ok: true };
  });
  handleAction("controlTray", async ({ action = "status" } = {}) => {
    const value = oneOf(action, TRAY_COMMANDS, "Tray action");
    const status = await runControlJson(["tray", "status"], { timeoutMs: 120_000 });
    if (value === "status") {
      return { action: value, ok: true, status };
    }
    if (status?.supported === false) {
      throw new Error(
        cleanText(
          status.why,
          "Tray supervision is unavailable on this platform. Launch the Control Center directly.",
        ),
      );
    }
    // enable/disable/restart may ask this very GUI to drain and quit. Waiting
    // for that child while the IPC mutation remains active creates a cycle:
    // the child waits for the mutation, and the mutation waits for the child.
    // Accept the validated action once the OS confirms the detached control
    // process spawned, then let it outlive this window and perform the
    // lifecycle transaction.
    await runControlDetached(["tray", value]);
    return { action: value, ok: true, accepted: true };
  });
  handleAction("launchHarness", async ({ harnessId, surface } = {}) => {
    const harness = oneOf(harnessId, HARNESS_IDS, "Harness");
    const destination = oneOf(surface, HARNESS_SURFACES, "Harness surface");
    if (harness === "deepcode" && destination === "app") {
      throw new Error("Deep Code is a third-party terminal harness and has no official desktop app.");
    }
    if (harness === "codex" && destination === "app") {
      const appPath = codexDesktopPath();
      if (!appPath) throw new Error("Codex desktop is not installed. Open the official Codex documentation to download it.");
      if (!shell?.openPath) throw new Error("Opening desktop apps is unavailable.");
      const failure = await shell.openPath(appPath);
      if (failure) throw new Error("Could not open the Codex desktop app.");
      return { opened: true, surface: "app" };
    }
    const executable = executablePath(harness === "codex" ? "codex" : "deepcode");
    if (!executable) throw new Error(`${harness === "codex" ? "Codex" : "Deep Code"} CLI is not installed.`);
    return openTerminalCommand(executable, [], discoverSourceRoot());
  }, { requiresCompatibleRouter: false });
  handleAction("installHarness", async ({ harnessId } = {}) => {
    const harness = oneOf(harnessId, ["deepcode"], "Installable harness");
    const npm = executablePath("npm");
    const nodeVersion = executableVersion(executablePath("node"));
    const nodeMajor = Number.parseInt(String(nodeVersion || "").replace(/^v/, "").split(".", 1)[0], 10);
    if (!npm) throw new Error("npm is required to install Deep Code.");
    if (!Number.isInteger(nodeMajor) || nodeMajor < 22) throw new Error("Deep Code requires Node.js 22 or newer.");
    // The fixed command is shown in a real terminal. No credential, cwd, package,
    // or argv value crosses the renderer boundary.
    return openTerminalCommand(npm, ["install", "-g", DEEPCODE_PACKAGE], discoverSourceRoot());
  }, { requiresCompatibleRouter: false });
  handleAction("openHarnessSession", async ({ harnessId, sessionId, surface, model } = {}) => {
    const harness = oneOf(harnessId, HARNESS_IDS, "Harness");
    const destination = oneOf(surface, HARNESS_SURFACES, "Harness surface");
    const id = stringValue(sessionId, "Session", SESSION_UUID).toLowerCase();
    const session = getContextSessionsSnapshot().sessions.find((entry) => entry.harnessId === harness && entry.id === id);
    if (!session) throw new Error("That session is not available in its harness store.");
    if (session.archived || !session.resumable) throw new Error("Restore this archived task in its owning harness before resuming it.");
    if (harness === "deepcode" && destination !== "terminal") {
      throw new Error("Deep Code sessions resume in an interactive terminal.");
    }
    if (model !== undefined && (harness !== "codex" || destination !== "terminal")) {
      throw new Error("A model override is supported only for Codex terminal resumes.");
    }
    if (harness === "codex" && destination === "app") {
      if (!shell?.openExternal) throw new Error("Codex task links are unavailable.");
      await shell.openExternal(`codex://threads/${id}`);
      return { opened: true, surface: "app", sessionId: id };
    }
    const executable = executablePath(harness === "codex" ? "codex" : "deepcode");
    if (!executable) throw new Error(`${harness === "codex" ? "Codex" : "Deep Code"} CLI is not installed.`);
    const args = harness === "codex"
      ? ["resume", id, ...(model === undefined || model === "" ? [] : ["-m", await validateModel(model)])]
      : ["--resume", id];
    const cwd = session.workspace && existsSync(session.workspace) ? session.workspace : discoverSourceRoot();
    return { ...openTerminalCommand(executable, args, cwd), sessionId: id };
  }, { requiresCompatibleRouter: false });
  return {
    operationNames: [...operations.values()],
    hasActiveMutations: () => pendingMutations > 0,
    whenMutationsIdle,
  };
}
