import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KIMI_CLI_INSTALL_URL,
  KIMI_CLI_NPM_PACKAGE,
  MAX_CLI_WAIT_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  kimiCliInstallGuidance,
} from "./kimi-oauth-onboarding.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { configuredProviderIds, validateProviderIds } from "./provider-selection.mjs";

// Target-agnostic setup helpers shared by every target's <target>-setup.mjs.
// Only the app name, the provider-key command hint, and the install/doctor
// invocation differ per target; everything here (argument parsing, interactive
// prompting, provider selection, and credential onboarding) is identical.

const FLAG_OPTIONS = new Set([
  "--guided",
  "--auto",
  "--smoke-test",
  "--selection-only",
  "--help",
]);

// Parse the shared setup flags, validating --providers and rejecting unknowns.
export function parseSetupArgs(args) {
  let argumentError;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--providers") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        argumentError = "--providers requires a comma-separated value.";
        break;
      }
      index += 1;
    } else if (!FLAG_OPTIONS.has(argument)) {
      argumentError = `Unknown setup option: ${argument}`;
      break;
    }
  }
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  return {
    guided: args.includes("--guided"),
    runSmoke: args.includes("--smoke-test"),
    selectionOnly: args.includes("--selection-only"),
    help: args.includes("--help"),
    providers: option("--providers"),
    argumentError,
  };
}

export function promptLine(label, defaultValue = "") {
  if (process.platform === "win32") {
    const prompt = `${label}${defaultValue ? ` [${defaultValue}]` : ""}`;
    const script = "$answer = Read-Host $env:MODEL_ROUTER_PROMPT_LABEL; [Console]::Out.Write($answer)";
    let lastError;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        const answer = execFileSync(
          executable,
          ["-NoLogo", "-NoProfile", "-Command", script],
          {
            encoding: "utf8",
            env: { ...process.env, MODEL_ROUTER_PROMPT_LABEL: prompt },
            stdio: ["inherit", "pipe", "inherit"],
          },
        ).trim();
        return answer || defaultValue;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("PowerShell is required for guided setup on Windows.");
  }
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("Interactive setup requires a terminal; use --providers for automatic setup.");
  }
  try {
    writeSync(descriptor, `${label}${defaultValue ? ` [${defaultValue}]` : ""}: `);
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    writeSync(descriptor, "\n");
    return Buffer.concat(chunks).toString("utf8").trim() || defaultValue;
  } finally {
    closeSync(descriptor);
  }
}

export function confirm(label, defaultYes = true) {
  const answer = promptLine(`${label} ${defaultYes ? "[Y/n]" : "[y/N]"}`).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

export function providerConfigured(provider) {
  if (provider.kind === "oauth") {
    if (provider.id === "kimi-oauth") return kimiOAuthStatus().configured;
    if (provider.id === "grok-oauth") return grokOAuthStatus().configured;
    return false;
  }
  return credentialStatus(provider, { persistent: true }).configured;
}

// Per-provider hint for a selected-but-unconfigured OAuth provider.
function oauthSetupHint(provider) {
  return provider.id === "grok-oauth"
    ? "install the official Grok CLI and run `grok login`"
    : `run \`kimi login\` (install the Kimi Code CLI from ${KIMI_CLI_INSTALL_URL} first if needed)`;
}

function executable(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    return execFileSync(finder, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

export function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with status ${result.status}.`);
  }
}

// Like run(), but reports success instead of throwing on a non-zero exit so the
// caller can offer a retry (e.g. a cancelled `kimi login`).
function tryRun(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function guidedSelection(appName) {
  const providers = [...PROVIDERS.values()];
  process.stdout.write(`\nChoose the providers to show in ${appName}:\n`);
  providers.forEach((provider, index) => {
    process.stdout.write(
      `  ${index + 1}. ${provider.displayName} ${
        providerConfigured(provider) ? "(ready)" : "(setup required)"
      }\n`,
    );
  });
  process.stdout.write(
    "\nOAuth entries reuse official Kimi or Grok CLI sessions; API entries use a provider key.\n",
  );
  const readyIndexes = providers
    .map((provider, index) => (providerConfigured(provider) ? String(index + 1) : undefined))
    .filter(Boolean)
    .join(",");
  const raw = promptLine("Enter numbers separated by commas", readyIndexes || "1");
  const selected = raw.split(",").map((value) => Number(value.trim()));
  if (selected.some((value) => !Number.isInteger(value) || value < 1 || value > providers.length)) {
    throw new Error("Provider selection contains an invalid number.");
  }
  return validateProviderIds(selected.map((value) => providers[value - 1].id));
}

// Resolve which provider ids to enable from --providers, or interactively.
export function selectProviders({ requested, guided, appName }) {
  if (requested) {
    if (requested === "configured") return configuredProviderIds();
    if (requested === "all") return [...PROVIDERS.keys()];
    return validateProviderIds(requested.split(","));
  }
  return guided ? guidedSelection(appName) : configuredProviderIds();
}

function locateKimiCli() {
  let kimi = executable("kimi");
  if (kimi) return kimi;
  process.stdout.write(`\n${kimiCliInstallGuidance()}\n\n`);
  for (let attempt = 0; attempt < MAX_CLI_WAIT_ATTEMPTS && !kimi; attempt += 1) {
    const npm = executable("npm");
    if (npm && confirm(`Install it now with \`npm install -g ${KIMI_CLI_NPM_PACKAGE}\`?`)) {
      tryRun(npm, ["install", "-g", KIMI_CLI_NPM_PACKAGE]);
    } else if (!confirm("Have you installed the Kimi Code CLI and want to continue?")) {
      break;
    }
    kimi = executable("kimi");
    if (!kimi) {
      process.stdout.write(
        "Still can't find `kimi` on PATH. Open a new terminal after installing, then continue.\n",
      );
    }
  }
  return kimi;
}

function onboardKimiOauth() {
  const kimi = locateKimiCli();
  if (!kimi) {
    throw new Error(
      `Kimi Code CLI is required for OAuth. Install it from ${KIMI_CLI_INSTALL_URL}, then run setup again.`,
    );
  }
  for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
    if (!confirm("Run `kimi login` now?")) {
      throw new Error("Kimi OAuth setup was cancelled.");
    }
    tryRun(kimi, ["login"]);
    if (kimiOAuthStatus().configured) return;
    process.stdout.write("Kimi login did not produce a usable OAuth credential yet.\n");
  }
  throw new Error("Kimi OAuth login did not produce a usable credential after several attempts.");
}

function onboardGrokOauth() {
  let grok = executable("grok");
  const installed = path.join(
    process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
    "bin",
    "grok",
  );
  if (!grok && existsSync(installed)) grok = installed;
  if (!grok) {
    const npm = executable("npm");
    if (!npm || !confirm("Install the official Grok CLI with `npm install -g @xai-official/grok`?")) {
      throw new Error(
        "The official Grok CLI is required for OAuth. Install `@xai-official/grok`, then run setup again.",
      );
    }
    tryRun(npm, ["install", "-g", "@xai-official/grok"]);
    grok = executable("grok");
    if (!grok && existsSync(installed)) grok = installed;
  }
  if (!grok) throw new Error("The official Grok CLI was installed but could not be located.");
  for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
    if (!confirm("Run `grok login` now?")) throw new Error("Grok OAuth setup was cancelled.");
    tryRun(grok, ["login"]);
    if (grokOAuthStatus().configured) return;
    process.stdout.write("Grok login did not produce a usable OAuth credential yet.\n");
  }
  throw new Error("Grok OAuth login did not produce a usable credential after several attempts.");
}

// Ensure a selected provider has a usable credential, onboarding it when guided.
// providerKeyCommand(id) yields the target-specific hint for the non-guided path.
export function configureProvider(provider, { guided, providerKeyCommand }) {
  if (providerConfigured(provider)) return;
  if (!guided) {
    const setup =
      provider.kind === "oauth"
        ? oauthSetupHint(provider)
        : `run \`${providerKeyCommand(provider.id)}\``;
    throw new Error(`${provider.displayName} is selected but not configured; ${setup} first.`);
  }
  if (provider.kind === "oauth") {
    if (provider.id === "grok-oauth") onboardGrokOauth();
    else onboardKimiOauth();
  } else {
    if (!confirm(`Enter a ${provider.displayName} key securely now?`)) {
      throw new Error(`${provider.displayName} setup was cancelled.`);
    }
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "provider-key.mjs"), provider.id, "set"]);
  }
}
