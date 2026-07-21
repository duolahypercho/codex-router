import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validCallerSecret } from "./caller-auth.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  PORTS,
  SOURCE_ROOT,
  TARGET,
  loopback,
} from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { providerSelectionStatus, selectedListedModels } from "./provider-selection.mjs";

if (TARGET !== "cursor") {
  throw new Error("cursor-doctor.mjs requires MODEL_ROUTER_TARGET=cursor.");
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
            "cursor",
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

function cursorAppPath() {
  const configured = process.env.CURSOR_APP_PATH;
  if (configured && existsSync(configured)) return configured;
  if (process.platform === "darwin") {
    return [
      "/Applications/Cursor.app",
      path.join(os.homedir(), "Applications", "Cursor.app"),
    ].find((candidate) => existsSync(candidate));
  }
  if (process.platform === "win32") {
    return [
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe"),
    ]
      .filter(Boolean)
      .find((candidate) => existsSync(candidate));
  }
  return [
    "/usr/bin/cursor",
    "/opt/Cursor/cursor",
    path.join(os.homedir(), ".local", "bin", "cursor"),
  ].find((candidate) => existsSync(candidate));
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
  process.stdout.write(`Usage: model-router cursor doctor [--json] [--fix]

Checks the local Cursor OpenAI-compatible gateway without printing credentials.
--fix reinstalls generated files and the service. Cursor's own settings are
never edited; run \`model-router cursor setup\` for the values to paste into
Cursor -> Settings -> Models.
`);
  process.exit(0);
}

if (process.argv.includes("--fix")) {
  try {
    repair();
    if (!jsonOutput) process.stdout.write("Repair completed; verifying the result.\n\n");
  } catch (error) {
    console.error(`cursor-router repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
  "Install Node.js 24 LTS, then rerun the Cursor installer.",
);

const cursor = cursorAppPath();
add(
  cursor ? "ok" : "warn",
  "Cursor",
  cursor || "not found in a standard location",
  "Install Cursor or set CURSOR_APP_PATH; the router still runs without it.",
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
    "Run ./bin/model-router cursor setup --guided.",
  );
} catch (error) {
  add(
    "fail",
    "Enabled providers",
    error instanceof Error ? error.message : String(error),
    "Run Cursor setup again to replace the invalid provider selection.",
  );
}

add(
  existsSync(LITELLM_CONFIG_PATH) ? "ok" : "fail",
  "Generated gateway config",
  LITELLM_CONFIG_PATH,
  "Run ./bin/model-router cursor doctor --fix.",
);

for (const [name, target] of [
  ["Internal service key", INTERNAL_SECRET_PATH],
  ["Cursor caller key", CALLER_SECRET_PATH],
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
    "Run ./bin/model-router cursor doctor --fix.",
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
    `Run ./bin/model-router cursor provider-key ${provider.id} set.`,
  );
}

try {
  const config = childJson("cursor-config-manager.mjs", ["status"]);
  add(
    config.enabled ? "ok" : "warn",
    "Cursor integration",
    config.enabled
      ? `enabled; ${config.models.length} models at ${config.baseUrl}`
      : "not enabled (router-side)",
    "Run ./bin/model-router cursor setup --guided, then paste the values into Cursor.",
  );
} catch (error) {
  add(
    "fail",
    "Cursor integration",
    error instanceof Error ? error.message : String(error),
    "Run ./bin/model-router cursor setup --guided.",
  );
}

try {
  const service = childJson("service.mjs", ["status"]);
  add(
    service.loaded ? "ok" : "fail",
    "Cursor router service",
    service.state || "stopped",
    "Run ./bin/model-router cursor enable.",
  );
} catch (error) {
  add(
    "fail",
    "Cursor router service",
    error instanceof Error ? error.message : "not available",
    "Run the Cursor installer again.",
  );
}

try {
  const response = await fetch(loopback(PORTS.router, "/health"), {
    signal: AbortSignal.timeout(2_000),
  });
  const payload = await response.json().catch(() => ({}));
  const healthy = response.ok && payload.service === "cursor-router";
  add(
    healthy ? "ok" : "fail",
    "Cursor router health",
    healthy ? `version ${payload.version}` : `unexpected service or HTTP ${response.status}`,
    "Run ./bin/model-router cursor doctor --fix.",
  );
} catch {
  add(
    "fail",
    "Cursor router health",
    `not reachable on 127.0.0.1:${PORTS.router}`,
    "Run ./bin/model-router cursor doctor --fix.",
  );
}

if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), target: "cursor", checks }, null, 2)}\n`,
  );
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    if (check.status === "fail" && check.fix) process.stdout.write(`      Fix: ${check.fix}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
