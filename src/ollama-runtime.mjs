import { spawn as spawnChild, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { processStartIdentity, stateOwnsProcess } from "./process-identity.mjs";

export const DEFAULT_OLLAMA_HOST = "127.0.0.1:11434";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_RUNTIME_STATE_PATH =
  process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE ||
  path.join(STATE_DIR, "ollama-runtime.json");
export const OLLAMA_LOG_PATH =
  process.env.MODEL_ROUTER_OLLAMA_LOG || path.join(STATE_DIR, "ollama.log");

function commandWorks(command, args = ["--version"], spawn = spawnSync) {
  try {
    return spawn(command, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// The app and the package-manager installs put the same CLI in different
// places. Looking at known locations lets a headless service reuse an Ollama
// app install without opening the app itself.
export function ollamaCommand({ spawn = spawnSync, platform = process.platform } = {}) {
  const candidates = ["ollama"];
  if (platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/ollama",
      "/usr/local/bin/ollama",
      "/Applications/Ollama.app/Contents/Resources/ollama",
    );
  } else if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    if (local) candidates.push(path.join(local, "Programs", "Ollama", "ollama.exe"));
    if (programFiles) candidates.push(path.join(programFiles, "Ollama", "ollama.exe"));
  } else {
    candidates.push("/usr/local/bin/ollama", "/usr/bin/ollama");
  }
  return candidates.find((candidate) =>
    candidate === "ollama"
      ? commandWorks(candidate, ["--version"], spawn)
      : existsSync(candidate) && commandWorks(candidate, ["--version"], spawn),
  );
}

export function parseOllamaVersion(output) {
  const match = String(output || "").match(/(?:version\s+is\s+|ollama\s+)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/i);
  return match?.[1] || undefined;
}

export function ollamaVersion({ command = ollamaCommand(), spawn = spawnSync } = {}) {
  if (!command) return undefined;
  try {
    const result = spawn(command, ["--version"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    return parseOllamaVersion(`${result.stdout || ""}\n${result.stderr || ""}`);
  } catch {
    return undefined;
  }
}

export function ollamaAvailable({ spawn = spawnSync } = {}) {
  return Boolean(ollamaCommand({ spawn }));
}

export function ollamaModelsPath({ platform = process.platform, home = os.homedir() } = {}) {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  if (platform === "win32") {
    return path.join(process.env.USERPROFILE || home, ".ollama", "models");
  }
  if (platform === "linux") return "/usr/share/ollama/.ollama/models";
  return path.join(home, ".ollama", "models");
}

export function ollamaRootUrl(baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || DEFAULT_OLLAMA_BASE_URL) {
  return String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function ollamaHostForUrl(baseUrl = DEFAULT_OLLAMA_BASE_URL) {
  const parsed = new URL(ollamaRootUrl(baseUrl));
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname.toLowerCase())) return undefined;
  return `${hostname.includes(":") ? `[${hostname}]` : hostname}:${parsed.port || "11434"}`;
}

export async function probeOllama({
  baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 1500,
} = {}) {
  const root = ollamaRootUrl(baseUrl);
  try {
    const response = await fetchImpl(`${root}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, status: response.status };
    const body = await response.json();
    const models = Array.isArray(body?.models)
      ? body.models
          .map((model) => model?.name || model?.model)
          .filter((model) => typeof model === "string")
      : [];
    return { reachable: true, models };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readOllamaRuntimeState() {
  try {
    const parsed = JSON.parse(readFileSync(OLLAMA_RUNTIME_STATE_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function clearOllamaRuntimeState() {
  try {
    unlinkSync(OLLAMA_RUNTIME_STATE_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// A PID alone is not ownership: after the process exits the operating system
// may reuse it for an unrelated Ollama server (or an entirely different
// process). Persist the process start identity beside the PID and require both
// to match before the router ever calls kill().
// Kept under its original name: the implementation is shared with the harness
// web server now, and nothing about it was ever Ollama-specific.
export const ollamaProcessIdentity = processStartIdentity;

export function ollamaRuntimeStateOwnsProcess(
  state = readOllamaRuntimeState(),
  { identity = ollamaProcessIdentity } = {},
) {
  return stateOwnsProcess(state, { identity });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Stop only the exact daemon this router started. A reachable server with no
// matching identity belongs to somebody else and is deliberately untouched.
export async function stopManagedOllama({
  identity = ollamaProcessIdentity,
  kill = process.kill,
  timeoutMs = 5_000,
  intervalMs = 100,
} = {}) {
  const state = readOllamaRuntimeState();
  if (!state?.managed) return { stopped: false, reason: "external-or-unmanaged" };
  if (!ollamaRuntimeStateOwnsProcess(state, { identity })) {
    clearOllamaRuntimeState();
    return { stopped: false, reason: "ownership-lost" };
  }

  try {
    kill(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      clearOllamaRuntimeState();
      return { stopped: false, reason: "already-stopped" };
    }
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && ollamaRuntimeStateOwnsProcess(state, { identity })) {
    await wait(intervalMs);
  }
  if (ollamaRuntimeStateOwnsProcess(state, { identity })) {
    kill(state.pid, "SIGKILL");
  }
  clearOllamaRuntimeState();
  return { stopped: true, pid: state.pid };
}

function commandExists(command, spawn = spawnSync) {
  return commandWorks(command, ["--version"], spawn);
}

export function ollamaInstallPlan({
  platform = process.platform,
  spawn = spawnSync,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY),
} = {}) {
  if (platform === "darwin" && commandExists("brew", spawn)) {
    return {
      command: "brew",
      args: ["install", "ollama"],
      label: "Homebrew",
      hint: "brew install ollama",
    };
  }
  if (platform === "win32" && commandExists("winget", spawn)) {
    return {
      command: "winget",
      args: [
        "install",
        "--id",
        "Ollama.Ollama",
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      label: "WinGet",
      hint: "winget install --id Ollama.Ollama --exact",
    };
  }
  if (platform === "darwin") {
    if (!interactive) {
      return {
        command: "/usr/bin/osascript",
        args: [
          "-e",
          'do shell script "curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh" with administrator privileges',
        ],
        label: "Ollama's official macOS installer (administrator authorization)",
        hint: "curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh",
      };
    }
    return {
      command: "sh",
      // Ollama's official installer supports macOS too. Its normal behavior
      // opens the app after installing; OLLAMA_NO_START keeps this path
      // headless so the router owns only the daemon.
      args: ["-c", "curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh"],
      label: "Ollama's official macOS installer (headless)",
      hint: "curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh",
    };
  }
  if (platform === "linux") {
    if (!interactive) {
      if (commandExists("pkexec", spawn)) {
        return {
          command: "pkexec",
          args: ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
          label: "Ollama's official Linux installer (PolicyKit)",
          hint: "curl -fsSL https://ollama.com/install.sh | sh",
        };
      }
      return {
        command: undefined,
        args: [],
        label: "manual",
        hint: "Run `curl -fsSL https://ollama.com/install.sh | sh` in a terminal so sudo can ask for permission.",
        env,
      };
    }
    return {
      command: "sh",
      args: ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
      label: "Ollama's official Linux installer",
      hint: "curl -fsSL https://ollama.com/install.sh | sh",
    };
  }
  const detail = platform === "darwin"
    ? "Install Homebrew first or download the headless Ollama CLI from https://ollama.com/download."
    : platform === "win32"
      ? "Install WinGet or download Ollama from https://ollama.com/download."
      : `No supported Ollama installer is available for ${platform}.`;
  return { command: undefined, args: [], label: "manual", hint: detail, env };
}

export function installOllamaRuntime({
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY),
} = {}) {
  const existing = ollamaCommand({ spawn, platform });
  if (existing) return { installed: true, command: existing, version: ollamaVersion({ command: existing, spawn }) };
  const plan = ollamaInstallPlan({ platform, spawn, env, interactive });
  if (!plan.command) {
    throw new Error(`Ollama is not installed. ${plan.hint}`);
  }
  const result = spawn(plan.command, plan.args, {
    stdio: "inherit",
    windowsHide: true,
    env,
  });
  if (result.status !== 0) {
    throw new Error(`Ollama installation failed (exit ${result.status ?? "unknown"}).`);
  }
  const command = ollamaCommand({ spawn, platform });
  if (!command) throw new Error("Ollama's installer finished, but its CLI was not found.");
  return { installed: true, command, version: ollamaVersion({ command, spawn }) };
}

function resolvedCommand(command) {
  let candidate = command;
  if (!command.includes(path.sep)) {
    const found = String(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, command))
      .find((entry) => existsSync(entry));
    if (found) candidate = found;
  }
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export function ollamaUpdatePlan({
  spawn = spawnSync,
  platform = process.platform,
  interactive = Boolean(process.stdin.isTTY),
  resolveCommand = resolvedCommand,
} = {}) {
  const command = ollamaCommand({ spawn, platform });
  if (!command) throw new Error("Ollama is not installed.");
  const resolved = resolveCommand(command);
  if (
    platform === "darwin" &&
    /\/Cellar\/ollama\//.test(resolved) &&
    commandExists("brew", spawn) &&
    spawn("brew", ["list", "--formula", "ollama"], { stdio: "ignore" }).status === 0
  ) {
    return { command: "brew", args: ["upgrade", "ollama"], source: "homebrew" };
  }
  if (
    platform === "darwin" &&
    resolved.includes("/Ollama.app/") &&
    commandExists("brew", spawn) &&
    spawn("brew", ["list", "--cask", "ollama-app"], { stdio: "ignore" }).status === 0
  ) {
    return {
      command: "brew",
      args: ["upgrade", "--cask", "ollama-app"],
      source: "homebrew-cask",
    };
  }
  if (platform === "win32" && commandExists("winget", spawn)) {
    const listed = spawn("winget", ["list", "--id", "Ollama.Ollama", "--exact"], {
      stdio: "ignore",
    });
    if (listed.status === 0) {
      return {
        command: "winget",
        args: ["upgrade", "--id", "Ollama.Ollama", "--exact"],
        source: "winget",
      };
    }
  }
  if (platform === "linux") {
    if (!interactive) {
      if (commandExists("pkexec", spawn)) {
        return {
          command: "pkexec",
          args: ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
          source: "official-policykit",
        };
      }
      throw new Error(
        "Updating Ollama needs administrator permission. Run `curl -fsSL https://ollama.com/install.sh | sh` in a terminal.",
      );
    }
    return {
      command: "sh",
      args: ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
      source: "official",
    };
  }
  if (platform === "darwin") {
    if (!interactive) {
      return {
        command: "/usr/bin/osascript",
        args: [
          "-e",
          'do shell script "curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh" with administrator privileges',
        ],
        source: resolved.includes("/Ollama.app/") ? "official-app" : "official",
      };
    }
    return {
      command: "sh",
      args: ["-c", "curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh"],
      source: resolved.includes("/Ollama.app/") ? "official-app" : "official",
    };
  }
  throw new Error(`Update Ollama from https://ollama.com/download, then restart the router.`);
}

export function updateOllamaRuntime({
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY),
} = {}) {
  const command = ollamaCommand({ spawn, platform });
  if (!command) throw new Error("Ollama is not installed.");
  const plan = ollamaUpdatePlan({ spawn, platform, interactive });
  const result = spawn(plan.command, plan.args, { stdio: "inherit", windowsHide: true, env });
  if (result.status !== 0) throw new Error(`Ollama update failed (exit ${result.status ?? "unknown"}).`);
  return { command, source: plan.source, version: ollamaVersion({ command, spawn }) };
}

export async function waitForOllama({
  baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  intervalMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probeOllama({ baseUrl, fetchImpl, timeoutMs: Math.min(intervalMs * 2, 1500) });
    if (last.reachable) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last || { reachable: false, error: "Timed out waiting for Ollama." };
}

export async function ensureOllamaHeadless({
  install = false,
  baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  fetchImpl = fetch,
  spawn = spawnChild,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  processIdentity = (pid) => ollamaProcessIdentity(pid, { spawn: spawnSyncImpl, platform }),
  timeoutMs = 15_000,
} = {}) {
  const host = ollamaHostForUrl(baseUrl);
  if (!host) throw new Error(`The configured local model endpoint is not loopback: ${baseUrl}`);
  const existingProbe = await probeOllama({ baseUrl, fetchImpl });
  if (existingProbe.reachable) {
    const state = readOllamaRuntimeState();
    const managed = ollamaRuntimeStateOwnsProcess(state, { identity: processIdentity });
    if (state?.managed && !managed) clearOllamaRuntimeState();
    return {
      installed: Boolean(ollamaCommand({ spawn: spawnSyncImpl, platform })),
      running: true,
      managed,
      version: ollamaVersion({ spawn: spawnSyncImpl, command: ollamaCommand({ spawn: spawnSyncImpl, platform }) }),
      ...existingProbe,
    };
  }

  let command = ollamaCommand({ spawn: spawnSyncImpl, platform });
  if (!command && install) {
    const installed = installOllamaRuntime({ spawn: spawnSyncImpl, platform });
    command = installed.command;
  }
  if (!command) {
    const plan = ollamaInstallPlan({ platform, spawn: spawnSyncImpl });
    throw new Error(`Ollama is not installed. ${plan.hint}`);
  }
  mkdirSync(path.dirname(OLLAMA_LOG_PATH), { recursive: true, mode: 0o700 });
  const logFd = openSync(OLLAMA_LOG_PATH, "a", 0o600);
  let child;
  try {
    child = spawn(command, ["serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: { ...process.env, OLLAMA_HOST: host },
    });
  } finally {
    closeSync(logFd);
  }
  child?.unref?.();
  const ready = await waitForOllama({ baseUrl, fetchImpl, timeoutMs });
  if (!ready.reachable) {
    throw new Error(
      `Ollama was started headlessly but did not become ready${ready.error ? `: ${ready.error}` : "."}`,
    );
  }
  const identity = processIdentity(child?.pid);
  if (!identity) {
    child?.kill?.("SIGTERM");
    throw new Error("Ollama started, but Codex Router could not verify ownership of its process.");
  }
  try {
    writePrivateJson(OLLAMA_RUNTIME_STATE_PATH, {
      version: 1,
      managed: true,
      pid: child?.pid || null,
      processIdentity: identity,
      command,
      baseUrl: ollamaRootUrl(baseUrl),
      startedAt: Date.now(),
      logPath: OLLAMA_LOG_PATH,
    });
  } catch (error) {
    // A daemon whose ownership record could not be persisted would be
    // indistinguishable from an external server on shutdown. Do not leave it
    // behind after reporting startup failure.
    child?.kill?.("SIGTERM");
    throw error;
  }
  return {
    installed: true,
    running: true,
    managed: true,
    pid: child?.pid || null,
    version: ollamaVersion({ command, spawn: spawnSyncImpl }),
    ...ready,
  };
}

export function localOllamaRuntimeSnapshot({
  spawn = spawnSync,
  platform = process.platform,
  baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
} = {}) {
  const command = ollamaCommand({ spawn, platform });
  const state = readOllamaRuntimeState();
  let running = false;
  if (command) {
    const host = ollamaHostForUrl(baseUrl);
    try {
      running = spawn(command, ["list"], {
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
        env: { ...process.env, ...(host ? { OLLAMA_HOST: host } : {}) },
      }).status === 0;
    } catch {
      running = false;
    }
  }
  return {
    installed: Boolean(command),
    command: command || null,
    version: command ? ollamaVersion({ command, spawn }) || null : null,
    running,
    managed: running && ollamaRuntimeStateOwnsProcess(state),
    modelsPath: ollamaModelsPath({ platform }),
    logPath: OLLAMA_LOG_PATH,
  };
}

export function ollamaInstallHint() {
  return ollamaInstallPlan().hint;
}
