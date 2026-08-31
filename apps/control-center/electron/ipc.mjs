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
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
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
const LOCAL_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_SESSION_ID = /^(?:(?:draft|bc)-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_UUID_IN_FILENAME = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const DSH_SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HARNESS_IDS = ["codex", "dsh", "gemini", "cursor", "claude"];
const HARNESS_SURFACES = ["app", "terminal"];
const AGENT_BRIDGE_IDS = ["anthropic", "cursor", "gemini"];
const SESSION_INDEX_LIMIT = 16 * 1024 * 1024;
const SESSION_EDGE_BYTES = 256 * 1024;
const SESSION_LIST_LIMIT = 500;
// Catalog publishers now wait on a cross-process lock before probing Codex
// and committing all coupled model files. Leave room for both the bounded
// lock wait and the build itself; killing the lock holder at the old 30/120s
// limits would strand a stale lock and force a rollback to race recovery.
const CATALOG_MUTATION_TIMEOUT_MS = 330_000;
// Five live checks, two of them a full Codex parent-and-child turn. The
// catalog ceiling is not enough headroom for a slow provider, and a timeout
// here reads to the operator as "your model failed" when it did not.
const SUBAGENT_CERTIFY_TIMEOUT_MS = 600_000;
// Repair reruns the installer with --force-deps, which rebuilds node_modules
// and the Python environment from scratch. That is the slowest thing this app
// can start, so it gets the runner's whole ceiling rather than a catalog-sized
// budget; timing it out early would leave a half-rebuilt tree behind.
const REPAIR_TIMEOUT_MS = 11 * 60_000;
const CURSOR_CONNECTOR_TIMEOUT_MS = 10 * 60_000;
const CURSOR_QUIT_TIMEOUT_MS = 5 * 60_000;
const DSH_DOCS = "https://github.com/deepseek-ai/deepseek-harness";
const CURSOR_DOCS = "https://docs.cursor.com/en/cli/overview";
const CLOUDFLARED_INSTALL_DOCS = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
const CODEX_DOCS = "https://developers.openai.com/codex/cli/";
const CLAUDE_CODE_DOCS = "https://code.claude.com/docs/en/overview";
const GEMINI_CLI_DOCS = "https://github.com/google-gemini/gemini-cli";
const OAUTH_LOGIN_COMMANDS = Object.freeze({
  "kimi-oauth": { executable: "kimi", args: ["login"] },
  "grok-oauth": { executable: "grok", args: ["login", "--oauth"] },
  "devin-cli": { executable: "devin", args: ["auth", "login"] },
});
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

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
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links") : undefined,
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

function cursorDesktopPath() {
  return [
    "/Applications/Cursor.app",
    path.join(os.homedir(), "Applications", "Cursor.app"),
    ...(process.platform === "win32" && process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe")]
      : []),
  ].find((candidate) => existsSync(candidate));
}

function cursorConnectorInstallSpec() {
  if (process.platform === "darwin") {
    const brew = executablePath("brew");
    return brew ? {
      executable: brew,
      args: ["install", "cloudflared"],
      environment: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
    } : undefined;
  }
  if (process.platform === "win32") {
    const winget = executablePath("winget");
    return winget ? {
      executable: winget,
      args: [
        "install", "--id", "Cloudflare.cloudflared", "--exact", "--silent",
        "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity",
      ],
      environment: {},
    } : undefined;
  }
  return undefined;
}

function routerStateDirectory() {
  return process.env.MODEL_ROUTER_STATE_DIR || process.env.CODEX_ROUTER_STATE_DIR ||
    process.env.KIMI_CODEX_STATE_DIR ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-router");
}

function cursorHome() {
  return process.env.CURSOR_HOME || (
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cursor")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor")
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor")
  );
}

function readJsonObject(filePath, limit = SESSION_INDEX_LIMIT) {
  const text = readBounded(filePath, limit);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function terminalAvailable() {
  return process.platform === "darwin" && existsSync("/usr/bin/open");
}

export function getHarnessSnapshot() {
  const codex = executablePath("codex");
  const dsh = executablePath("dsh");
  const cursorAgent = executablePath("cursor-agent");
  const cursorLauncher = executablePath("cursor-router-agent");
  const claude = executablePath("claude");
  const claudeLauncher = executablePath("claude-router");
  const gemini = executablePath("gemini");
  const codexVersion = executableVersion(codex);
  const dshVersion = executableVersion(dsh);
  const cursorVersion = executableVersion(cursorAgent);
  const claudeVersion = executableVersion(claude);
  const geminiVersion = executableVersion(gemini);
  const stateDirectory = routerStateDirectory();
  const codexConfig = readBounded(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"), 2 * 1024 * 1024);
  const cursorState = readJsonObject(path.join(stateDirectory, "cursor-models.json"), 2 * 1024 * 1024);
  const claudeState = readJsonObject(path.join(stateDirectory, "claude-models.json"), 2 * 1024 * 1024);
  const geminiState = readJsonObject(path.join(stateDirectory, "gemini-models.json"), 2 * 1024 * 1024);
  const cursorTunnel = readJsonObject(path.join(stateDirectory, "cursor-tunnel.json"), 512 * 1024);
  const cloudflared = executablePath("cloudflared");
  const cloudflareLoggedIn = existsSync(
    process.env.TUNNEL_ORIGIN_CERT || path.join(
      process.env.MODEL_ROUTER_CLOUDFLARED_HOME || path.join(os.homedir(), ".cloudflared"),
      "cert.pem",
    ),
  );
  const cursorApp = cursorDesktopPath();
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
        configured: /# BEGIN (?:kimi-)?codex-(?:router|proxy)-/m.test(codexConfig || ""),
        canInstall: Boolean(codex || codexDesktopPath()),
        installRequirement: codex || codexDesktopPath()
          ? "Publishes the shared router catalog into Codex."
          : "Install Codex from the official OpenAI download.",
        docsUrl: CODEX_DOCS,
      },
      {
        id: "dsh",
        displayName: "DeepSeek Harness",
        ownership: "deepseek",
        description: "DeepSeek's coding harness, sharing this router's model catalog and credentials.",
        cliInstalled: Boolean(dsh),
        ...(dshVersion ? { cliVersion: dshVersion } : {}),
        appInstalled: Boolean(dsh),
        configured: existsSync(path.join(stateDirectory, "dsh-models.json")),
        canInstall: true,
        installRequirement: "Setup installs @deepseek-ai/dsh when it is missing and publishes the shared route.",
        docsUrl: DSH_DOCS,
      },
      {
        id: "claude",
        displayName: "Claude Code",
        ownership: "anthropic",
        description: "Anthropic's coding agent using every model selected in this router.",
        cliInstalled: Boolean(claude),
        ...(claudeVersion ? { cliVersion: claudeVersion } : {}),
        appInstalled: false,
        configured: Boolean(claudeLauncher && claudeState?.models?.length),
        canInstall: Boolean(claude),
        installRequirement: claude
          ? "Creates a private claude-router launcher and publishes the shared routed catalog. Claude settings remain untouched."
          : "Install the official Claude Code CLI first.",
        docsUrl: CLAUDE_CODE_DOCS,
      },
      {
        id: "gemini",
        displayName: "Gemini CLI",
        ownership: "google",
        description: "Google's terminal coding agent using the shared routed model catalog.",
        cliInstalled: Boolean(gemini),
        ...(geminiVersion ? { cliVersion: geminiVersion } : {}),
        appInstalled: false,
        configured: Boolean(geminiState?.models?.length),
        canInstall: Boolean(gemini),
        installRequirement: gemini
          ? "Publishes the shared router catalog into Gemini CLI. Its settings file remains untouched."
          : "Install the official Gemini CLI first.",
        docsUrl: GEMINI_CLI_DOCS,
      },
      {
        id: "cursor",
        displayName: "Cursor",
        ownership: "cursor",
        description: "Cursor Agent and Cursor App using the router's separate authenticated adapters.",
        cliInstalled: Boolean(cursorAgent),
        ...(cursorVersion ? { cliVersion: cursorVersion } : {}),
        appInstalled: Boolean(cursorApp),
        configured: Boolean(cursorLauncher && (!cursorApp || cursorState?.publicOrigin)),
        agentConfigured: Boolean(cursorLauncher),
        appConfigured: Boolean(cursorState?.publicOrigin),
        canInstall: Boolean(cursorAgent || cursorApp),
        installRequirement: cursorAgent || cursorApp
          ? !cursorApp
            ? "Cursor Agent connects locally and always reads the current routed catalog."
            : cursorState?.publicOrigin
              ? "Cursor App and Cursor Agent use the shared routed catalog."
              : "Connect Cursor installs the connector when needed, opens Cloudflare authorization, creates an isolated hostname, publishes the catalog, verifies it, and reopens Cursor."
          : "Install Cursor App or Cursor Agent first.",
        tunnel: {
          provider: "cloudflare",
          binaryInstalled: Boolean(cloudflared),
          loggedIn: cloudflareLoggedIn,
          configured: Boolean(cursorTunnel?.hostname),
          ...(cursorTunnel?.hostname ? { hostname: cursorTunnel.hostname } : {}),
          nextAction: !cloudflared
            ? "install-cloudflared"
            : cursorTunnel?.hostname
              ? "ready"
              : !cloudflareLoggedIn ? "login" : "choose-hostname",
        },
        ...(typeof cursorState?.publicOrigin === "string" ? { publicOrigin: cursorState.publicOrigin } : {}),
        docsUrl: CURSOR_DOCS,
      },
    ],
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function openTerminalCommand(executable, args, cwd) {
  if (!terminalAvailable()) throw new Error("Opening a terminal from the Control Center is currently available on macOS only.");
  if (!executable || !path.isAbsolute(executable) || !Array.isArray(args)) throw new Error("Harness command is unavailable.");
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Harness command is invalid.");
  const resolvedCwd = cwd ? realpathSync(cwd) : discoverSourceRoot();
  if (!statSync(resolvedCwd).isDirectory()) throw new Error("The session workspace is unavailable.");
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-terminal-"));
  const script = path.join(directory, "launch.command");
  const executableDirectory = path.dirname(executable);
  const node = executablePath("node");
  const searchDirectories = [...new Set([executableDirectory, node && path.dirname(node)].filter(Boolean))];
  const body = [
    "#!/bin/sh",
    `cd -- ${shellQuote(resolvedCwd)} || exit 1`,
    ...(searchDirectories.length ? [`export PATH=${shellQuote(searchDirectories.join(":"))}:"$PATH"`] : []),
    `rm -f -- ${shellQuote(script)}`,
    `rmdir -- ${shellQuote(directory)} 2>/dev/null || true`,
    `exec ${[executable, ...args].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
  writeFileSync(script, body, { encoding: "utf8", mode: 0o700, flag: "wx" });
  const opened = spawnSync("/usr/bin/open", ["-a", "Terminal", script], {
    encoding: "utf8",
    env: process.env,
    timeout: 5_000,
    windowsHide: true,
    shell: false,
  });
  if (opened.error || opened.status !== 0) throw new Error("Could not open Terminal.");
  return { opened: true, surface: "terminal" };
}

function cursorConnectorStage(kind, chunk) {
  const output = String(chunk || "");
  if (kind === "login") {
    return /https:\/\/|login|authorize|browser|waiting/i.test(output)
      ? "Complete Cloudflare authorization in your browser…"
      : undefined;
  }
  if (/download|fetch|manifest/i.test(output)) return "Downloading Cloudflare connector…";
  if (/install|pour|link/i.test(output)) return "Installing Cloudflare connector…";
  if (/cleanup|caveat|success|already installed/i.test(output)) return "Finishing Cloudflare connector setup…";
  return undefined;
}

function runCursorConnectorCommand(executable, args, {
  kind,
  environment = {},
  progress = () => {},
  timeoutMs = CURSOR_CONNECTOR_TIMEOUT_MS,
} = {}) {
  if (!executable || !path.isAbsolute(executable) || !Array.isArray(args)) {
    throw new Error("Cloudflare connector command is unavailable.");
  }
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Cloudflare connector command is invalid.");
  }
  const initial = kind === "login"
    ? "Opening Cloudflare authorization in your browser…"
    : "Preparing Cloudflare connector installation…";
  progress(initial);
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastStage = initial;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const child = spawn(executable, args, {
      cwd: discoverSourceRoot(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const readProgress = (chunk) => {
      const stage = cursorConnectorStage(kind, chunk);
      if (stage && stage !== lastStage) {
        lastStage = stage;
        progress(stage);
      }
    };
    child.stdout?.on("data", readProgress);
    child.stderr?.on("data", readProgress);
    child.once("error", () => finish(new Error(
      kind === "login"
        ? "Cloudflare authorization could not start."
        : "Cloudflare connector installation could not start.",
    )));
    child.once("close", (code, signal) => {
      if (code === 0) return finish(undefined, { exitCode: 0 });
      const suffix = signal ? ` (${signal})` : Number.isInteger(code) ? ` (exit ${code})` : "";
      finish(new Error(
        kind === "login"
          ? `Cloudflare authorization did not complete${suffix}.`
          : `Cloudflare connector installation failed${suffix}.`,
      ));
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
      force.unref?.();
      finish(new Error(
        kind === "login"
          ? "Cloudflare authorization timed out."
          : "Cloudflare connector installation timed out.",
      ));
    }, timeoutMs);
    timeout.unref?.();
  });
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

function dshWorkspaceIndex(dshHome) {
  const document = readJsonObject(path.join(dshHome, "storages", "workspace.json"));
  const workspaces = new Map();
  const archived = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, SESSION_LIST_LIMIT * 3)) visit(item, depth + 1);
      return;
    }
    if (Array.isArray(value.archivedSessionIds)) {
      for (const id of value.archivedSessionIds) if (typeof id === "string" && DSH_SESSION_ID.test(id)) archived.add(id.toLowerCase());
    }
    if (Array.isArray(value.sessionIds)) {
      const workspace = cleanText(value.path || value.cwd, "", 1024) || undefined;
      const workspaceLabel = cleanText(value.title, workspace ? path.basename(workspace) : "DeepSeek workspace", 100);
      for (const id of value.sessionIds) {
        if (typeof id === "string" && DSH_SESSION_ID.test(id)) workspaces.set(id.toLowerCase(), { workspace, workspaceLabel });
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(document);
  return { workspaces, archived };
}

function walkDshSessions(root, files, depth = 0) {
  if (depth > 5 || files.length >= SESSION_LIST_LIMIT * 2) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (files.length >= SESSION_LIST_LIMIT * 2) break;
    if (entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walkDshSessions(target, files, depth + 1);
    else if (entry.isFile() && (entry.name === "session.jsonl.zstd" || entry.name === "session.jsonl")) {
      const id = path.basename(path.dirname(target));
      if (DSH_SESSION_ID.test(id)) files.push({ id: id.toLowerCase(), filePath: target });
    }
  }
}

function dshSessions() {
  const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  const files = [];
  walkDshSessions(path.join(dshHome, "sessions"), files);
  const { workspaces, archived } = dshWorkspaceIndex(dshHome);
  return files.map(({ id, filePath }) => {
    let updatedAt = new Date(0).toISOString();
    try { updatedAt = new Date(statSync(filePath).mtimeMs).toISOString(); } catch {}
    const workspace = workspaces.get(id);
    const isArchived = archived.has(id);
    return {
      id,
      harnessId: "dsh",
      title: workspace?.workspaceLabel || "DeepSeek Harness session",
      updatedAt,
      ...(workspace?.workspace ? { workspace: workspace.workspace } : {}),
      ...(workspace?.workspaceLabel ? { workspaceLabel: workspace.workspaceLabel } : {}),
      provider: "DeepSeek Harness",
      status: isArchived ? "archived" : "saved",
      archived: isArchived,
      resumable: !isArchived,
    };
  });
}

function cursorAppSessions() {
  const databasePath = process.env.CODEX_ROUTER_CURSOR_CONVERSATION_DB ||
    path.join(cursorHome(), "User", "globalStorage", "conversation-search.db");
  if (!existsSync(databasePath)) return [];
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare(
      "SELECT source, id, title, updated_at, is_archived FROM conversations ORDER BY updated_at DESC",
    ).all();
    const sessions = new Map();
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
      if (!CURSOR_SESSION_ID.test(id) || sessions.has(id)) continue;
      const archived = Boolean(row.is_archived);
      const local = row.source === "local";
      sessions.set(id, {
        id,
        harnessId: "cursor",
        title: cleanText(row.title, "Untitled Cursor session", 240),
        updatedAt: Number.isFinite(Number(row.updated_at))
          ? new Date(Number(row.updated_at)).toISOString()
          : new Date(0).toISOString(),
        provider: local ? "Cursor" : "Cursor Cloud",
        status: archived ? "archived" : local ? "saved" : "cloud_cache",
        archived,
        resumable: local && !archived && !id.startsWith("draft-"),
      });
    }
    return [...sessions.values()];
  } catch {
    return [];
  } finally {
    try { database?.close(); } catch {}
  }
}

function cursorAgentSessions() {
  const chatsRoot = process.env.CODEX_ROUTER_CURSOR_AGENT_CHATS ||
    path.join(os.homedir(), ".cursor", "chats");
  let workspaceDirectories;
  try { workspaceDirectories = readdirSync(chatsRoot, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const workspaceDirectory of workspaceDirectories.slice(0, SESSION_LIST_LIMIT)) {
    if (!workspaceDirectory.isDirectory() || workspaceDirectory.isSymbolicLink()) continue;
    const workspaceRoot = path.join(chatsRoot, workspaceDirectory.name);
    let chatDirectories;
    try { chatDirectories = readdirSync(workspaceRoot, { withFileTypes: true }); } catch { continue; }
    for (const chatDirectory of chatDirectories.slice(0, SESSION_LIST_LIMIT)) {
      if (!chatDirectory.isDirectory() || chatDirectory.isSymbolicLink() || !SESSION_UUID.test(chatDirectory.name)) continue;
      const metadata = readJsonObject(path.join(workspaceRoot, chatDirectory.name, "meta.json"), 256 * 1024);
      if (!metadata) continue;
      const createdMs = finiteNumber(metadata.createdAtMs);
      const updatedMs = finiteNumber(metadata.updatedAtMs) ?? createdMs;
      const workspace = cleanText(metadata.cwd, "", 1024) || undefined;
      sessions.push({
        id: chatDirectory.name.toLowerCase(),
        harnessId: "cursor",
        title: "Cursor Agent session",
        updatedAt: updatedMs === undefined ? new Date(0).toISOString() : new Date(updatedMs).toISOString(),
        ...(createdMs === undefined ? {} : { createdAt: new Date(createdMs).toISOString() }),
        ...(workspace ? { workspace, workspaceLabel: cleanText(path.basename(workspace), workspace, 100) } : {}),
        provider: "Cursor Agent",
        status: "saved",
        archived: false,
        resumable: true,
      });
    }
  }
  return sessions;
}

function cursorSessions() {
  const sessions = new Map(cursorAppSessions().map((session) => [session.id, session]));
  for (const session of cursorAgentSessions()) {
    if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  return [...sessions.values()];
}

export function getContextSessionsSnapshot() {
  // Each client owns its own bounded index. Applying one cap after merging
  // them let a busy Codex history crowd every Cursor row out of the result.
  // Cursor's conversation-search database already enforces its own configured
  // cap, so return every row it exposes while keeping the filesystem walkers
  // for Codex and DeepSeek bounded independently.
  const sessions = [
    ...codexSessions().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, SESSION_LIST_LIMIT),
    ...dshSessions().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, SESSION_LIST_LIMIT),
    ...cursorSessions(),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    fetchedAt: new Date().toISOString(),
    sessions,
    counts: {
      total: sessions.length,
      codex: sessions.filter((session) => session.harnessId === "codex").length,
      dsh: sessions.filter((session) => session.harnessId === "dsh").length,
      cursor: sessions.filter((session) => session.harnessId === "cursor").length,
      claude: sessions.filter((session) => session.harnessId === "claude").length,
      gemini: sessions.filter((session) => session.harnessId === "gemini").length,
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

async function readInstalledControlHealth({ fetchImpl = globalThis.fetch } = {}) {
  const modulePath = path.join(discoverSourceRoot(), "src", "control-health.mjs");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.readControlHealth !== "function") {
    throw new Error("The installed router does not expose direct health reads.");
  }
  return module.readControlHealth({ fetchImpl });
}

async function installedRouterModule(name) {
  const packagedPath = typeof process.resourcesPath === "string" && process.resourcesPath
    ? path.join(process.resourcesPath, "router-src", name)
    : undefined;
  const modulePath = packagedPath && existsSync(packagedPath)
    ? packagedPath
    : path.join(discoverSourceRoot(), "src", name);
  return import(pathToFileURL(modulePath).href);
}

async function discoverInstalledCursorTunnelHostname(options) {
  const module = await installedRouterModule("cursor-cloudflare-tunnel.mjs");
  if (typeof module.discoverCursorTunnelHostname !== "function") {
    throw new Error("The installed router does not support automatic Cursor hostname discovery.");
  }
  return module.discoverCursorTunnelHostname(options);
}

async function readRunningCursorProcesses() {
  const module = await installedRouterModule("client-restart-notice.mjs");
  if (typeof module.runningClientProcesses !== "function") {
    throw new Error("The installed router cannot detect running Cursor processes.");
  }
  return module.runningClientProcesses("cursor");
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

export function registerIpcHandlers({
  ipcMain,
  BrowserWindow,
  shell,
  fetchImpl = globalThis.fetch,
  healthReader = readInstalledControlHealth,
  cursorConnectorExecutable = () => executablePath("cloudflared"),
  cursorConnectorInstaller = cursorConnectorInstallSpec,
  cursorConnectorRunner = runCursorConnectorCommand,
  cursorHostnameResolver = discoverInstalledCursorTunnelHostname,
  cursorProcessReader = readRunningCursorProcesses,
  cursorWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  controlJsonRunner = runControlJson,
  harnessSnapshotReader = getHarnessSnapshot,
  cursorAppPath = cursorDesktopPath,
  senderGuard = () => true,
} = {}) {
  if (!ipcMain?.handle) throw new TypeError("ipcMain.handle is required.");
  const operations = new Map();
  // Every mutation is a fresh control.mjs process. Keep their read/modify/
  // apply/rollback sequences in one order so two rapid UI actions cannot race
  // each other's snapshots or restore stale state. Reads remain concurrent.
  let mutationTail = Promise.resolve();
  let pendingMutations = 0;
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
      const progress = (message) => emit({
        id,
        name,
        action: name,
        status: "started",
        message: cleanText(message, `${name} is running`, 240),
      });
      const value = await fn(input, { id, name, progress });
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
    return enqueueMutation(() => operation(name, async (value, context) => {
      if (requiresCompatibleRouter) assertMutationCompatibility();
      return fn(value, context);
    })(event, input));
  });

  handle("getSnapshot", async () => snapshot());
  handle("getChatGptSession", async () => runJson(["chatgpt-session", "status"]));
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
  handle("getAgentBridges", async () => {
    const module = await installedRouterModule("agent-bridges.mjs");
    if (typeof module.agentBridgeStatus !== "function") {
      throw new Error("The Control Center does not include agent bridge status support.");
    }
    // Use the same desktop-safe executable resolution as the client rows.
    // A packaged app has a narrower PATH than an interactive shell; allowing
    // the bridge module to resolve commands again produced contradictory
    // "router ready" and "not installed" states for the same client.
    return module.agentBridgeStatus({
      ...process.env,
      ...(executablePath("claude") ? { MODEL_ROUTER_CLAUDE_BIN: executablePath("claude") } : {}),
      ...(executablePath("agent") || executablePath("cursor-agent")
        ? { MODEL_ROUTER_CURSOR_AGENT_BIN: executablePath("agent") || executablePath("cursor-agent") }
        : {}),
      ...(executablePath("gemini") ? { MODEL_ROUTER_GEMINI_BIN: executablePath("gemini") } : {}),
    });
  });
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
  // Read health in this trusted process instead of spawning a fresh
  // ELECTRON_RUN_AS_NODE child for every one-second renderer poll. The shared
  // reader owns the caller capability and preserves the CLI's redacted shape.
  handle("getHealth", async () => healthReader({ fetchImpl }));
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
  // A certification run makes live calls to the provider and to a native
  // parent that delegates to it, so it needs its own ceiling rather than the
  // catalog mutation one: the delegation alone can take a minute per turn.
  handleAction("certifySubagentModels", async ({ slugs } = {}) => {
    if (!Array.isArray(slugs) || !slugs.length) throw new Error("slugs must be a non-empty array.");
    if (slugs.length > 24) throw new Error("Certify at most 24 routes at once.");
    const models = [];
    for (const slug of slugs) models.push(await validateModel(slug));
    // One command for the whole batch: the runs fan out inside it, and the
    // proofs write and catalog republish happen once, in that process.
    return runJson(["subagents", "certify", ...models], { timeoutMs: SUBAGENT_CERTIFY_TIMEOUT_MS });
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
    if (harness === "codex" && destination === "app") {
      const appPath = codexDesktopPath();
      if (!appPath) throw new Error("Codex desktop is not installed. Open the official Codex documentation to download it.");
      if (!shell?.openPath) throw new Error("Opening desktop apps is unavailable.");
      const failure = await shell.openPath(appPath);
      if (failure) throw new Error("Could not open the Codex desktop app.");
      return { opened: true, surface: "app" };
    }
    if (harness === "cursor" && destination === "app") {
      const appPath = cursorDesktopPath();
      if (!appPath) throw new Error("Cursor App is not installed.");
      if (!shell?.openPath) throw new Error("Opening desktop apps is unavailable.");
      const failure = await shell.openPath(appPath);
      if (failure) throw new Error("Could not open Cursor App.");
      return { opened: true, surface: "app" };
    }
    if (harness === "dsh" && destination === "app") {
      if (!shell?.openExternal) throw new Error("Opening DeepSeek Harness is unavailable.");
      const state = await runControlJson(["harness", "start"], { timeoutMs: 120_000 });
      if (!state?.url) throw new Error("DeepSeek Harness started without a browser URL.");
      await shell.openExternal(state.url);
      return { opened: true, surface: "app" };
    }
    const executable = executablePath(
      harness === "codex" ? "codex"
        : harness === "dsh" ? "dsh"
          : harness === "claude" ? "claude-router"
            : harness === "gemini" ? "gemini"
              : "cursor-router-agent",
    );
    const label = harness === "codex" ? "Codex"
      : harness === "dsh" ? "DeepSeek Harness"
        : harness === "claude" ? "Claude Code Router"
          : harness === "gemini" ? "Gemini CLI"
            : "Cursor Router Agent";
    if (!executable) throw new Error(`${label} CLI is not installed or configured.`);
    return openTerminalCommand(executable, [], discoverSourceRoot());
  }, { requiresCompatibleRouter: false });
  handleAction("probeAgentBridge", async ({ bridgeId } = {}) => {
    const bridge = oneOf(bridgeId, AGENT_BRIDGE_IDS, "Agent bridge");
    const module = await installedRouterModule("agent-bridges.mjs");
    if (typeof module.probeAgentBridge !== "function") {
      throw new Error("The Control Center does not include agent bridge probing support.");
    }
    return module.probeAgentBridge(bridge);
  }, { requiresCompatibleRouter: false });
  handleAction("loginAgentBridge", async ({ bridgeId } = {}) => {
    const bridge = oneOf(bridgeId, AGENT_BRIDGE_IDS, "Agent bridge");
    const executable = bridge === "anthropic"
      ? executablePath("claude")
      : bridge === "cursor"
        ? executablePath("agent") || executablePath("cursor-agent")
        : executablePath("gemini");
    if (!executable) throw new Error(`${bridge === "anthropic" ? "Claude Code" : bridge === "cursor" ? "Cursor Agent" : "Gemini CLI"} is not installed.`);
    const args = bridge === "anthropic" ? ["auth", "login"] : bridge === "cursor" ? ["login"] : [];
    return openTerminalCommand(executable, args, discoverSourceRoot());
  }, { requiresCompatibleRouter: false });
  handleAction("setupHarness", async ({ harnessId, hostname, publicUrl } = {}) => {
    const harness = oneOf(harnessId, HARNESS_IDS, "Harness");
    const args = ["client-setup", harness];
    if (harness === "cursor") {
      if (hostname !== undefined) {
        const selected = stringValue(hostname, "Cursor hostname", /^[A-Za-z0-9](?:[A-Za-z0-9.-]{1,251}[A-Za-z0-9])?$/);
        args.push("--hostname", selected);
      }
      if (publicUrl !== undefined) {
        if (hostname !== undefined) throw new Error("Use either a managed hostname or an existing public URL, not both.");
        const origin = stringValue(publicUrl, "Cursor public URL", /^https:\/\/[^\s]{1,1000}$/);
        args.push("--public-url", origin);
      }
    } else if (publicUrl !== undefined || hostname !== undefined) {
      throw new Error("A hostname or public URL applies only to Cursor setup.");
    }
    return runControlJson(args, { timeoutMs: REPAIR_TIMEOUT_MS });
  });
  handleAction("prepareCursorTunnel", async (_input, context) => {
    const cloudflared = cursorConnectorExecutable();
    if (!cloudflared) {
      // Installing a system connector is intentionally a click-triggered
      // action. Detection and page load never mutate the host. The renderer
      // supplies no executable or argv; this fixed command reports sanitized
      // stages through the existing in-app operation channel.
      const installer = cursorConnectorInstaller();
      if (installer) {
        await cursorConnectorRunner(installer.executable, installer.args, {
          kind: "install",
          environment: installer.environment,
          progress: context.progress,
        });
        const installed = cursorConnectorExecutable();
        if (!installed) throw new Error("Cloudflare connector finished installing but could not be detected.");
        context.progress("Cloudflare connector installed. Refreshing Cursor setup…");
        return { installed: true };
      }
      if (!shell?.openExternal) throw new Error("Opening Cloudflare installation instructions is unavailable.");
      await shell.openExternal(CLOUDFLARED_INSTALL_DOCS);
      return { opened: true, destination: "install" };
    }
    const certificate = process.env.TUNNEL_ORIGIN_CERT || path.join(
      process.env.MODEL_ROUTER_CLOUDFLARED_HOME || path.join(os.homedir(), ".cloudflared"),
      "cert.pem",
    );
    if (existsSync(certificate)) return { loggedIn: true };
    await cursorConnectorRunner(cloudflared, ["tunnel", "login"], {
      kind: "login",
      progress: context.progress,
    });
    if (!existsSync(certificate)) {
      throw new Error("Cloudflare authorization finished without creating its local certificate.");
    }
    context.progress("Cloudflare authorization complete. Refreshing Cursor setup…");
    return { loggedIn: true };
  });
  handleAction("connectCursor", async ({ hostname } = {}, context) => {
    const appPath = cursorAppPath();
    if (!appPath) throw new Error("Cursor App is not installed.");

    let cloudflared = cursorConnectorExecutable();
    if (!cloudflared) {
      const installer = cursorConnectorInstaller();
      if (!installer) {
        throw new Error("Automatic Cloudflare connector installation is unavailable on this machine.");
      }
      await cursorConnectorRunner(installer.executable, installer.args, {
        kind: "install",
        environment: installer.environment,
        progress: context.progress,
      });
      cloudflared = cursorConnectorExecutable();
      if (!cloudflared) throw new Error("Cloudflare connector finished installing but could not be detected.");
      context.progress("Cloudflare connector installed.");
    }

    const certificate = process.env.TUNNEL_ORIGIN_CERT || path.join(
      process.env.MODEL_ROUTER_CLOUDFLARED_HOME || path.join(os.homedir(), ".cloudflared"),
      "cert.pem",
    );
    if (!existsSync(certificate)) {
      await cursorConnectorRunner(cloudflared, ["tunnel", "login"], {
        kind: "login",
        progress: context.progress,
      });
      if (!existsSync(certificate)) {
        throw new Error("Cloudflare authorization finished without creating its local certificate.");
      }
      context.progress("Cloudflare authorization complete.");
    }

    const savedHostname = harnessSnapshotReader().harnesses.find((entry) => entry.id === "cursor")?.tunnel?.hostname;
    const selectedHostname = hostname === undefined || !String(hostname).trim()
      ? savedHostname || await cursorHostnameResolver({ environment: process.env, fetchImpl })
      : stringValue(hostname, "Cursor hostname", /^[A-Za-z0-9](?:[A-Za-z0-9.-]{1,251}[A-Za-z0-9])?$/);
    context.progress(`Using ${selectedHostname} for Cursor's private connector.`);

    const quitDeadline = Date.now() + CURSOR_QUIT_TIMEOUT_MS;
    let waitingAnnounced = false;
    while ((await cursorProcessReader()).length) {
      if (!waitingAnnounced) {
        context.progress("Fully quit Cursor. Setup will resume here automatically…");
        waitingAnnounced = true;
      }
      if (Date.now() >= quitDeadline) {
        throw new Error("Cursor is still running. Fully quit it, then click Connect Cursor again.");
      }
      await cursorWait(1_000);
    }

    context.progress("Creating the isolated Cursor connector and publishing routed models…");
    await controlJsonRunner(
      ["client-setup", "cursor", "--hostname", selectedHostname],
      { timeoutMs: REPAIR_TIMEOUT_MS },
    );
    const cursor = harnessSnapshotReader().harnesses.find((entry) => entry.id === "cursor");
    if (!cursor?.agentConfigured || !cursor?.appConfigured) {
      throw new Error("Cursor setup finished without publishing its routed model catalog.");
    }
    context.progress("Cursor routing verified. Opening Cursor…");
    if (!shell?.openPath) throw new Error("Opening Cursor App is unavailable.");
    const failure = await shell.openPath(appPath);
    if (failure) throw new Error("Cursor was configured but could not be reopened.");
    return { configured: true, hostname: selectedHostname, opened: true };
  });
  handleAction("openHarnessSession", async ({ harnessId, sessionId, surface, model } = {}) => {
    const harness = oneOf(harnessId, HARNESS_IDS, "Harness");
    const destination = oneOf(surface, HARNESS_SURFACES, "Harness surface");
    const id = stringValue(
      sessionId,
      "Session",
      harness === "dsh" ? DSH_SESSION_ID : harness === "cursor" ? CURSOR_SESSION_ID : SESSION_UUID,
    ).toLowerCase();
    const session = getContextSessionsSnapshot().sessions.find((entry) => entry.harnessId === harness && entry.id === id);
    if (!session) throw new Error("That session is not available in its harness store.");
    if (session.archived || !session.resumable) throw new Error("Restore this archived task in its owning harness before resuming it.");
    if (harness !== "codex" && destination !== "terminal") {
      throw new Error(`${harness === "dsh" ? "DeepSeek Harness" : "Cursor"} sessions resume in an interactive terminal.`);
    }
    if (model !== undefined && (harness !== "codex" || destination !== "terminal")) {
      throw new Error("A model override is supported only for Codex terminal resumes.");
    }
    if (harness === "codex" && destination === "app") {
      if (!shell?.openExternal) throw new Error("Codex task links are unavailable.");
      await shell.openExternal(`codex://threads/${id}`);
      return { opened: true, surface: "app", sessionId: id };
    }
    const executable = executablePath(
      harness === "codex" ? "codex" : harness === "dsh" ? "dsh" : "cursor-router-agent",
    );
    const label = harness === "codex" ? "Codex" : harness === "dsh" ? "DeepSeek Harness" : "Cursor Router Agent";
    if (!executable) throw new Error(`${label} CLI is not installed or configured.`);
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
