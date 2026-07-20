import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";

import { detectLegacyInstallations, applyKnownMigrations, rollbackLatestMigration } from "./legacy-migration.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  configuredProviderIds,
  validateProviderIds,
  writeProviderSelection,
} from "./provider-selection.mjs";

const args = process.argv.slice(2);
const guided = args.includes("--guided");
const migrateKnown = args.includes("--migrate-known");
const runSmoke = args.includes("--smoke-test");
const selectionOnly = args.includes("--selection-only");

const flagOptions = new Set([
  "--guided",
  "--auto",
  "--migrate-known",
  "--smoke-test",
  "--selection-only",
  "--help",
]);
let setupArgumentError;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--providers") {
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      setupArgumentError = "--providers requires a comma-separated value.";
      break;
    }
    index += 1;
  } else if (!flagOptions.has(argument)) {
    setupArgumentError = `Unknown setup option: ${argument}`;
    break;
  }
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (args.includes("--help")) {
  process.stdout.write(`Usage: setup [options]

Guided, credential-safe Codex Router setup.

Options:
  --guided             Ask provider and migration questions interactively
  --auto               Use already configured credentials (default)
  --providers LIST     Comma-separated provider ids
  --migrate-known      Safely migrate recognized earlier Codex Router installs
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
    const script = "$answer = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL; [Console]::Out.Write($answer)";
    let lastError;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        const answer = execFileSync(
          executable,
          ["-NoLogo", "-NoProfile", "-Command", script],
          {
            encoding: "utf8",
            env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: prompt },
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
  process.stdout.write("\nChoose the providers to show in Codex:\n");
  providers.forEach((provider, index) => {
    process.stdout.write(
      `  ${index + 1}. ${provider.displayName} ${providerConfigured(provider) ? "(ready)" : "(setup required)"}\n`,
    );
  });
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
    return execFileSync(finder, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${path.basename(command)} exited with status ${result.status}.`);
  }
  return result.status ?? 1;
}

function configureProvider(provider) {
  if (providerConfigured(provider)) return;
  if (!guided) {
    const setup =
      provider.kind === "oauth"
        ? "run `kimi login`"
        : `run \`./bin/provider-key ${provider.id} set\``;
    throw new Error(`${provider.displayName} is selected but not configured; ${setup} first.`);
  }
  if (provider.kind === "oauth") {
    const kimi = executable("kimi");
    if (!kimi) {
      throw new Error(
        "Kimi Code CLI is required for OAuth. Install it from https://www.kimi.com/help/kimi-code/cli-getting-started, then run setup again.",
      );
    }
    if (!confirm("Run `kimi login` now?")) throw new Error("Kimi OAuth setup was cancelled.");
    run(kimi, ["login"]);
    if (!kimiOAuthStatus().configured) throw new Error("Kimi OAuth login did not produce a usable credential.");
  } else {
    if (!confirm(`Enter a ${provider.displayName} key securely now?`)) {
      throw new Error(`${provider.displayName} setup was cancelled.`);
    }
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "provider-key.mjs"), provider.id, "set"]);
  }
}

async function main() {
  if (setupArgumentError) throw new Error(setupArgumentError);
  const legacy = detectLegacyInstallations();
  if (legacy.unknownConflict) {
    throw new Error(
      `An unknown model router owns ${legacy.config.modelCatalogJson}; automatic setup will not replace it.`,
    );
  }
  const providers = requestedSelection();
  if (providers.length === 0) {
    throw new Error(
      "No configured provider was found. Run `./bin/setup --guided` or pass `--providers` after configuring credentials.",
    );
  }
  for (const id of providers) configureProvider(PROVIDERS.get(id));
  writeProviderSelection(providers);

  let migration;
  if (legacy.installations.length) {
    const approved = migrateKnown || (guided && confirm(
      `Safely migrate ${legacy.installations.map((item) => item.id).join(", ")} and keep a rollback snapshot?`,
    ));
    if (!approved) {
      throw new Error("A recognized older router must be migrated before installation. Re-run with --migrate-known.");
    }
    migration = applyKnownMigrations();
  }

  if (selectionOnly) {
    process.stdout.write(`${JSON.stringify({ providers, migration }, null, 2)}\n`);
    return;
  }

  try {
    if (process.platform === "win32") {
      run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(SOURCE_ROOT, "install.ps1"),
        "-CheckoutInstall",
      ]);
    } else {
      run(path.join(SOURCE_ROOT, "bin", "install"), []);
    }
  } catch (error) {
    if (migration?.migrated) rollbackLatestMigration();
    throw error;
  }

  if (runSmoke || (guided && confirm("Run one small live request per enabled provider?", false))) {
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "smoke-test.mjs")]);
  }
  run(process.execPath, [path.join(SOURCE_ROOT, "src", "doctor.mjs")]);
  process.stdout.write(
    `\nCodex Router is ready with: ${providers.join(", ")}\nFully quit Codex, reopen it, and start a new task.\n`,
  );
}

main().catch((error) => {
  console.error(`codex-router setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
