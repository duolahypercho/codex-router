// One command table for every surface that drives apps/desktop/ui: the Tauri
// tray, the Electron shell, and the router's own browser panel. Each call is a
// single shell-out to the control CLI, so a shell is only a window and an IPC
// hop -- not a second implementation of what the companion does. Duplicating
// this table is how the surfaces would drift apart, so they all import it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL_TIMEOUT_MS = 120_000;

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function sourceRoot(env = process.env, here = SELF_ROOT) {
  if (env.MODEL_ROUTER_SOURCE_ROOT) return env.MODEL_ROUTER_SOURCE_ROOT;
  for (const guess of [here, path.resolve(here, "..", "..")]) {
    if (existsSync(path.join(guess, "src", "control.mjs"))) return guess;
  }
  return undefined;
}

// A command that mutates and then re-reads: the UI always wants the fresh
// snapshot, so the read is part of the call rather than a second round trip
// the renderer has to remember to make.
export const COMMANDS = {
  control_snapshot: () => ({ args: ["--json"] }),
  account_usage: () => ({ args: ["account", "--json"] }),
  provider_usage: () => ({ args: ["provider-usage", "--json"] }),
  provider_setup: () => ({ args: ["providers", "--json"] }),
  local_models: () => ({ args: ["local-models", "list", "--json"] }),
  local_model_speed: ({ model, tag }) => ({
    args: ["local-models", "benchmark", requireTag(model ?? tag)],
  }),
  update_local_ollama: () => ({ args: ["local-models", "runtime", "update", "--yes"] }),
  vision_bridge_status: () => ({ args: ["vision-bridge", "status"] }),
  vision_bridge_models: () => ({ args: ["vision-bridge", "models"] }),
  vision_bridge_probe: () => ({ args: ["vision-bridge", "probe"] }),
  set_vision_bridge: ({ enabled }) => ({
    args: ["vision-bridge", enabled ? "on" : "off"],
  }),
  set_vision_engine: ({ engine, effort }) => ({
    args: ["vision-bridge", "engine", String(engine || "auto"), ...(effort ? [String(effort)] : [])],
  }),
  set_vision_effort: ({ effort }) => ({ args: ["vision-bridge", "effort", String(effort || "default")] }),
  pull_vision_model: ({ model, tag }) => ({
    args: ["vision-bridge", "pull", requireTag(model ?? tag)],
  }),
  vision_pull_status: () => ({ args: ["vision-bridge", "pull-status"] }),
  benchmark_vision_model: ({ model, tag }) => ({
    args: ["vision-bridge", "benchmark", requireTag(model ?? tag)],
  }),
  use_local_vision_model: ({ model, tag }) => ({
    args: ["vision-bridge", "local", requireTag(model ?? tag)],
  }),
  install_local_model: ({ model, tag, force }) => ({
    args: [
      "local-models",
      "install",
      requireTag(model ?? tag),
      "--yes",
      ...(force ? ["--force"] : []),
    ],
  }),
  uninstall_local_model: ({ model, tag }) => ({
    args: ["local-models", "uninstall", requireTag(model ?? tag), "--yes", "--async"],
  }),
  cancel_local_model: ({ model, tag }) => ({
    args: ["local-models", "cancel", requireTag(model ?? tag)],
  }),
  set_local_model_enabled: ({ model, tag, enabled }) => ({
    args: ["local-models", "set", requireTag(model ?? tag), enabled ? "on" : "off"],
  }),
  set_lmstudio_model_enabled: ({ model, id, enabled }) => ({
    args: ["local-models", "lmstudio-set", requireTag(model ?? id), enabled ? "on" : "off"],
  }),
  install_provider_cli: ({ provider }) => ({ args: ["install-cli", requireProvider(provider)] }),
  connect_oauth: ({ provider }) => ({
    args: ["login", requireProvider(provider)],
    then: ["providers", "--json"],
  }),
  save_api_key: ({ provider, apiKey }) => {
    if (!String(apiKey ?? "").trim()) throw new Error("Enter a credential first.");
    if (String(apiKey).length > 16 * 1024) throw new Error("The credential is too large.");
    return {
      args: ["credential", requireProvider(provider)],
      stdin: String(apiKey),
      select: [["set", requireProvider(provider), "on", "--targets", "codex"]],
      then: ["providers", "--json"],
    };
  },
  remove_api_key: ({ provider }) => ({
    args: ["credential", requireProvider(provider), "--remove"],
    then: ["providers", "--json"],
  }),
  set_provider_enabled: ({ provider, enabled }) => ({
    args: ["set", requireProvider(provider), enabled ? "on" : "off", "--targets", "codex"],
    then: ["--json"],
  }),
  set_login_free: ({ enabled }) => ({
    args: ["auth-mode", enabled ? "on" : "off"],
    then: ["--json"],
  }),
  set_subagent_mode: ({ mode }) => ({ args: ["subagents", "mode", String(mode)] }),
  set_subagent_model: ({ slug, enabled }) => ({
    args: ["subagents", "set", String(slug), enabled ? "on" : "off"],
  }),
  set_subagent_provider: ({ provider, enabled }) => ({
    args: ["subagents", "provider", requireProvider(provider), enabled ? "on" : "off"],
  }),
  set_subagent_selection: ({ selection }) => ({ args: ["subagents", String(selection)] }),
  set_picker_model: ({ slug, visible }) => ({
    args: ["picker", "set", String(slug), visible ? "show" : "hide"],
  }),
  set_picker_provider: ({ provider, visible }) => ({
    args: ["picker", "provider", requireProvider(provider), visible ? "show" : "hide"],
  }),
  set_picker_models: ({ showAll }) => ({ args: ["picker", "all", showAll ? "show" : "hide"] }),
  set_tool_result_aging: ({ mode, enabled }) => ({
    args: ["tool-result-aging", (enabled ?? (mode === "on")) ? "on" : "off"],
  }),
  set_signed_routing: ({ enabled }) => ({
    args: ["signed-routing", enabled ? "on" : "off"],
    then: ["--json"],
  }),
  presence_status: () => ({ args: ["presence", "status"] }),
  set_presence_mode: ({ mode }) => ({ args: ["presence", "set", String(mode || "always")] }),
  service_start: () => ({ args: ["service", "start"] }),
  service_stop: () => ({ args: ["service", "stop"] }),
  maintenance: () => ({ args: ["maintenance"] }),
  doctor_fix: () => ({ args: ["doctor", "--fix", "--json"] }),
};

function requireProvider(provider) {
  const value = String(provider ?? "");
  // The renderer is local, but an id reaches a command line either way, so it
  // is constrained to the shape a provider id actually has.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`Unknown provider: ${provider}`);
  return value;
}

function requireTag(tag) {
  const value = String(tag ?? "");
  if (!/^[A-Za-z0-9][\w.:\/-]{0,127}$/.test(value)) throw new Error(`Unknown model tag: ${tag}`);
  return value;
}

// process.execPath is the Electron binary inside the main process, not Node,
// so using it launches a second Electron to run a Node script -- which fails
// with a sandbox error rather than anything that names the real cause. Prefer
// the system Node the router is tested against; fall back to Electron's own
// bundled Node, which is what ELECTRON_RUN_AS_NODE selects.
export function nodeRuntime({ env = process.env, execPath = process.execPath } = {}) {
  const onPath = which("node", env);
  if (onPath) return { command: onPath, env };
  if (process.versions.electron) {
    return { command: execPath, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { command: execPath, env };
}

function which(name, env) {
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of String(env.PATH || "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function runControl(root, args, { stdin, runtime = nodeRuntime() } = {}) {
  return new Promise((resolve, reject) => {
    if (!root) {
      reject(new Error("Model Router was not found. Set MODEL_ROUTER_SOURCE_ROOT."));
      return;
    }
    const child = execFile(
      runtime.command,
      [path.join(root, "src", "control.mjs"), ...args],
      {
        cwd: root,
        env: runtime.env,
        timeout: CONTROL_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim() || "The router command failed."));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

export function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Model Router returned an unreadable response.");
  }
}

// Runs a command from the table end to end. Every surface calls this rather
// than sequencing runControl itself, so "mutate, then re-read so the caller
// paints fresh state" cannot be implemented three slightly different ways.
export async function runDesktopCommand(command, args = {}, { root = sourceRoot() } = {}) {
  const build = COMMANDS[command];
  if (!build) throw new Error(`Unknown command: ${command}`);
  const plan = build(args ?? {});
  const output = await runControl(root, plan.args, { stdin: plan.stdin });
  for (const extra of plan.select ?? []) await runControl(root, extra);
  if (plan.then) return parseJson(await runControl(root, plan.then));
  return output.trim() ? parseJson(output) : null;
}
