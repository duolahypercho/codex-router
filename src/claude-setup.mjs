import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
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
import { SOURCE_ROOT, TARGET } from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  configuredProviderIds,
  validateProviderIds,
  writeProviderSelection,
} from "./provider-selection.mjs";

if (TARGET !== "claude") {
  throw new Error("claude-setup.mjs requires MODEL_ROUTER_TARGET=claude.");
}

const args = process.argv.slice(2);
const guided = args.includes("--guided");
const runSmoke = args.includes("--smoke-test");
const selectionOnly = args.includes("--selection-only");
const flagOptions = new Set([
  "--guided",
  "--auto",
  "--smoke-test",
  "--selection-only",
  "--help",
]);

let argumentError;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--providers") {
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      argumentError = "--providers requires a comma-separated value.";
      break;
    }
    index += 1;
  } else if (!flagOptions.has(argument)) {
    argumentError = `Unknown Claude setup option: ${argument}`;
    break;
  }
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (args.includes("--help")) {
  process.stdout.write(`Usage: model-router claude setup [options]

Configure Claude Desktop third-party inference through the local router.

Options:
  --guided             Ask provider and authentication questions interactively
  --auto               Use already configured credentials (default)
  --providers LIST     Comma-separated provider ids
  --smoke-test         Make one small live request per enabled provider
  --selection-only     Save provider selection without installing (development)
  --help               Show this help

Providers: ${[...PROVIDERS.keys()].join(", ")}
`);
  process.exit(0);
}

function promptLine(label, defaultValue = "") {
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

function confirm(label, defaultYes = true) {
  const answer = promptLine(`${label} ${defaultYes ? "[Y/n]" : "[y/N]"}`).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function providerConfigured(provider) {
  return provider.kind === "oauth"
    ? provider.id === "kimi-oauth" && kimiOAuthStatus().configured
    : credentialStatus(provider, { persistent: true }).configured;
}

function guidedSelection() {
  const providers = [...PROVIDERS.values()];
  process.stdout.write("\nChoose the providers to show in Claude Desktop:\n");
  providers.forEach((provider, index) => {
    process.stdout.write(
      `  ${index + 1}. ${provider.displayName} ${
        providerConfigured(provider) ? "(ready)" : "(setup required)"
      }\n`,
    );
  });
  process.stdout.write(
    "\nOAuth entries reuse an existing Kimi Code CLI login; API entries use a provider key.\n",
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

function requestedSelection() {
  const requested = option("--providers");
  if (requested) {
    if (requested === "configured") return configuredProviderIds();
    if (requested === "all") return [...PROVIDERS.keys()];
    return validateProviderIds(requested.split(","));
  }
  return guided ? guidedSelection() : configuredProviderIds();
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

function run(command, commandArgs) {
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

// Like run(), but reports success instead of throwing on a non-zero exit so
// the caller can offer a retry (e.g. a cancelled `kimi login`).
function tryRun(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

// Guide the user through installing the Kimi Code CLI when it is missing. When
// npm is available it offers to run the global install directly; otherwise it
// re-checks PATH between attempts so the user can install by hand. Returns the
// resolved `kimi` path or undefined if the user gave up.
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

// Interactive Kimi OAuth login with bounded retries on both CLI discovery and
// the login itself.
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

function configureProvider(provider) {
  if (providerConfigured(provider)) return;
  if (!guided) {
    const setup =
      provider.kind === "oauth"
        ? `run \`kimi login\` (install the Kimi Code CLI from ${KIMI_CLI_INSTALL_URL} first if needed)`
        : `run \`./bin/model-router claude provider-key ${provider.id} set\``;
    throw new Error(`${provider.displayName} is selected but not configured; ${setup} first.`);
  }
  if (provider.kind === "oauth") {
    onboardKimiOauth();
  } else {
    if (!confirm(`Enter a ${provider.displayName} key securely now?`)) {
      throw new Error(`${provider.displayName} setup was cancelled.`);
    }
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "provider-key.mjs"), provider.id, "set"]);
  }
}

async function main() {
  if (argumentError) throw new Error(argumentError);
  const providers = requestedSelection();
  if (providers.length === 0) {
    throw new Error(
      "No configured provider was found. Run Claude setup with --guided or configure a provider key first.",
    );
  }
  for (const id of providers) configureProvider(PROVIDERS.get(id));
  writeProviderSelection(providers);

  if (selectionOnly) {
    process.stdout.write(`${JSON.stringify({ target: "claude", providers }, null, 2)}\n`);
    return;
  }

  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(SOURCE_ROOT, "install.ps1"),
      "-CheckoutInstall",
      "-Target",
      "claude",
    ]);
  } else {
    run(path.join(SOURCE_ROOT, "bin", "install"), []);
  }

  if (runSmoke || (guided && confirm("Run one small live request per enabled provider?", false))) {
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "claude-smoke-test.mjs"), "--yes"]);
  }
  run(process.execPath, [path.join(SOURCE_ROOT, "src", "claude-doctor.mjs")]);
  process.stdout.write(
    `\nClaude Router is ready with: ${providers.join(", ")}\nFully quit Claude Desktop and reopen it.\n`,
  );
}

main().catch((error) => {
  console.error(`claude-router setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
