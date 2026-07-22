import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validCallerSecret } from "./caller-auth.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import {
  CALLER_SECRET_PATH,
  CLAUDE_CONFIG_LIBRARY_DIR,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  PORTS,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { providerSelectionStatus, selectedListedModels } from "./provider-selection.mjs";

if (TARGET !== "claude") {
  throw new Error("claude-doctor.mjs requires MODEL_ROUTER_TARGET=claude.");
}

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, fix });
const jsonOutput = process.argv.includes("--json");

function childJson(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${script} exited with ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function repair() {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(SOURCE_ROOT, "install.ps1"),
            "-CheckoutInstall",
            "-Target",
            "claude",
          ],
          { cwd: SOURCE_ROOT, env: process.env, stdio: "inherit" },
        )
      : spawnSync(path.join(SOURCE_ROOT, "bin", "install"), [], {
          cwd: SOURCE_ROOT,
          env: process.env,
          stdio: "inherit",
        });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Repair installer exited with ${result.status}.`);
}

function claudeDesktopPath() {
  const configured = process.env.CLAUDE_DESKTOP_PATH;
  if (configured && existsSync(configured)) return configured;
  if (process.platform === "darwin") {
    return [
      "/Applications/Claude.app",
      path.join(os.homedir(), "Applications", "Claude.app"),
    ].find((candidate) => existsSync(candidate));
  }
  if (process.platform === "win32") {
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Claude", "Claude.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "AnthropicClaude", "Claude.exe"),
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(candidate));
  }
  return undefined;
}

function readableSecret(target) {
  if (!existsSync(target)) return false;
  try {
    return validCallerSecret(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: model-router claude doctor [--json] [--fix]

Checks Claude Desktop third-party inference without printing credentials.
--fix reinstalls generated files, the local Claude configuration, and service.
`);
  process.exit(0);
}

if (process.argv.includes("--fix")) {
  try {
    repair();
    if (!jsonOutput) process.stdout.write("Repair completed; verifying the result.\n\n");
  } catch (error) {
    console.error(`claude-router repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
  "Install Node.js 24 LTS, then rerun the Claude installer.",
);
const supportedDesktopPlatform = ["darwin", "win32"].includes(process.platform);
add(
  supportedDesktopPlatform ? "ok" : process.platform === "linux" ? "warn" : "fail",
  "Platform",
  supportedDesktopPlatform
    ? process.platform
    : process.platform === "linux"
      ? "linux; router development only (no supported Claude Desktop distribution)"
      : process.platform,
  "Use the latest Claude Desktop on macOS or Windows.",
);
const claude = claudeDesktopPath();
add(
  claude ? "ok" : "warn",
  "Claude Desktop",
  claude || "not found in a standard location",
  "Install the latest Claude Desktop or set CLAUDE_DESKTOP_PATH.",
);

let selection = { providers: [] };
let models = [];
try {
  selection = providerSelectionStatus();
  models = selectedListedModels();
  add(
    selection.providers.length && models.length ? "ok" : "fail",
    "Enabled providers",
    selection.providers.length ? selection.providers.join(", ") : "none",
    "Run ./bin/model-router claude setup --guided.",
  );
} catch (error) {
  add(
    "fail",
    "Enabled providers",
    error instanceof Error ? error.message : String(error),
    "Run Claude setup again to replace the invalid provider selection.",
  );
}

add(
  existsSync(LITELLM_CONFIG_PATH) ? "ok" : "fail",
  "Generated gateway config",
  LITELLM_CONFIG_PATH,
  "Run ./bin/model-router claude doctor --fix.",
);

for (const [name, target] of [
  ["Internal service key", INTERNAL_SECRET_PATH],
  ["Claude caller key", CALLER_SECRET_PATH],
]) {
  const valid = readableSecret(target);
  const protectedFile = valid && privateFileIsProtected(target);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  add(
    protectedFile ? "ok" : "fail",
    name,
    mode === undefined
      ? "missing"
      : !valid
        ? "invalid"
        : process.platform === "win32"
          ? "current-user Windows ACL"
          : `mode ${mode.toString(8)}`,
    "Run ./bin/model-router claude doctor --fix.",
  );
}

const oauth = kimiOAuthStatus();
add(
  oauth.configured ? "ok" : selection.providers.includes("kimi-oauth") ? "fail" : "warn",
  "Kimi OAuth",
  oauth.configured ? "credential present" : `not configured; ${oauth.setup}`,
  "Run kimi login, then rerun the doctor.",
);
const grokOauth = grokOAuthStatus();
add(
  grokOauth.configured ? "ok" : selection.providers.includes("grok-oauth") ? "fail" : "warn",
  "Grok OAuth",
  grokOauth.configured ? grokOauth.source : `not configured; ${grokOauth.setup}`,
  "Run grok login, then rerun the doctor.",
);
for (const provider of PROVIDERS.values()) {
  if (provider.kind !== "openai-compatible") continue;
  const credential = credentialStatus(provider, { persistent: true });
  add(
    credential.configured ? "ok" : selection.providers.includes(provider.id) ? "fail" : "warn",
    `${provider.displayName} key`,
    credential.configured ? credential.source : "not configured",
    `Run ./bin/model-router claude provider-key ${provider.id} set.`,
  );
}

try {
  const config = childJson("claude-config-manager.mjs", ["status"]);
  add(
    config.mode === "router" ? "ok" : "fail",
    "Claude 3P configuration",
    `${config.mode}; ${config.modelCount ?? 0} routed models`,
    "Run ./bin/model-router claude enable, then fully restart Claude Desktop.",
  );
  add(
    existsSync(CLAUDE_CONFIG_LIBRARY_DIR) ? "ok" : "fail",
    "Claude configuration library",
    CLAUDE_CONFIG_LIBRARY_DIR,
    "Run the Claude installer again.",
  );
} catch (error) {
  add(
    "fail",
    "Claude 3P configuration",
    error instanceof Error ? error.message : String(error),
    "Inspect the Claude 3P configuration library before running repair.",
  );
}

let serviceLoaded = false;
try {
  const service = childJson("service.mjs", ["status"]);
  serviceLoaded = Boolean(service.loaded);
  add(
    service.loaded ? "ok" : "fail",
    "Claude router service",
    service.state || "stopped",
    "Run ./bin/model-router claude enable.",
  );
} catch (error) {
  add(
    "fail",
    "Claude router service",
    error instanceof Error ? error.message : "not available",
    "Run the Claude installer again.",
  );
}

const health = await waitForRouterHealth({ timeoutMs: serviceLoaded ? 30_000 : 2_000 });
add(
  health.ok ? "ok" : "fail",
  "Claude router health",
  health.ok
    ? `version ${health.payload.version}`
    : `not ready on 127.0.0.1:${PORTS.router} after ${serviceLoaded ? 30 : 2} seconds; ${health.error}`,
  "Run ./bin/model-router claude doctor --fix.",
);

if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), target: "claude", checks }, null, 2)}\n`,
  );
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    if (check.status === "fail" && check.fix) process.stdout.write(`      Fix: ${check.fix}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
