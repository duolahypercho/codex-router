import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliSessionDescriptor } from "./cli-session-credential.mjs";
import { detectLegacyInstallations, applyKnownMigrations, rollbackLatestMigration } from "./legacy-migration.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { SOURCE_ROOT, TARGET } from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  hasSignInCli,
  installOauthCli,
  oauthCliPath,
  oauthLoginArgs,
  providerOnboardingSnapshot,
} from "./provider-onboarding.mjs";
import { renderProviderChoices, stepHeader, toggleSelection } from "./setup-ui.mjs";
import {
  defaultProviderIds,
  selectedConfiguredListedModels,
  validateProviderIds,
  writeProviderSelection,
} from "./provider-selection.mjs";
import { trayBundleDir, trayDecision } from "./tray-install.mjs";
import { resolveVisionEngine } from "./vision-bridge.mjs";
import {
  readVisionBridgeSettings,
  visionBridgeConfigured,
} from "./vision-bridge-state.mjs";

const args = process.argv.slice(2);
const guided = args.includes("--guided");
const migrateKnown = args.includes("--migrate-known");
const adoptNativeCatalog = args.includes("--adopt-native-catalog");
const runSmoke = args.includes("--smoke-test");
const selectionOnly = args.includes("--selection-only");
const withTray = args.includes("--with-tray");
const noTray = args.includes("--no-tray");

const flagOptions = new Set([
  "--guided",
  "--auto",
  "--migrate-known",
  "--adopt-native-catalog",
  "--smoke-test",
  "--selection-only",
  "--with-tray",
  "--no-tray",
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
if (!setupArgumentError && migrateKnown && adoptNativeCatalog) {
  setupArgumentError =
    "--adopt-native-catalog cannot be combined with --migrate-known.";
}
// Both act on Codex's own configuration: one replaces an older router's
// managed block, the other adopts the ChatGPT-plan catalog Codex reads. The
// harness integration is one settings section and has neither.
if (!setupArgumentError && TARGET !== "codex" && (migrateKnown || adoptNativeCatalog)) {
  setupArgumentError = `${
    migrateKnown ? "--migrate-known" : "--adopt-native-catalog"
  } applies only to the Codex target.`;
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// The installers update the managed checkout before running setup and roll it
// back when setup fails, which protects the running service from half-applied
// code. A declined prompt or an unconfigured provider says nothing about the
// new code, so rolling back there strands the user on the old revision and
// discards the very fix they were updating for. Exit 2 marks "the checkout is
// healthy, configuration is unfinished" and the installers keep the update.
// Any other non-zero exit still rolls back, so an unrecognized failure keeps
// the conservative behaviour.
// Not exported: importing this module runs setup, so the value is asserted
// from the outside by spawning the script.
const SETUP_INCOMPLETE_EXIT = 2;

function incomplete(message) {
  return Object.assign(new Error(message), { setupExitCode: SETUP_INCOMPLETE_EXIT });
}

if (args.includes("--help")) {
  process.stdout.write(`Usage: setup [options]

Guided, credential-safe Codex Router setup.

Options:
  --guided             Ask provider and migration questions interactively
  --auto               Use already configured credentials (default)
  --providers LIST     Comma-separated provider ids
  --migrate-known      Safely migrate recognized earlier Codex Router installs
  --adopt-native-catalog  Use an existing user-owned native Codex catalog as the merge base
  --smoke-test         Make one small live request per enabled provider
  --selection-only     Save provider selection without installing (development)
  --with-tray          Also build and launch the desktop companion app
  --no-tray            Never offer the desktop companion app
  --help               Show this help

Providers: ${[...PROVIDERS.values()].filter((provider) => !provider.variantOf).map((provider) => provider.id).join(", ")}
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
    throw incomplete("Interactive setup requires a terminal; use --providers for automatic setup.");
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
  if (provider.kind === "oauth") {
    if (provider.id === "kimi-oauth") return kimiOAuthStatus().configured;
    if (provider.id === "grok-oauth") return grokOAuthStatus().configured;
    return false;
  }
  return provider.keyless || provider.authMode === "anonymous"
    ? true
    : credentialStatus(provider, { persistent: true }).configured;
}

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function guidedSelection() {
  const snapshots = providerOnboardingSnapshot().providers;
  let selected = new Set(
    snapshots
      .map((snapshot, index) => (snapshot.action === "ready" ? index + 1 : undefined))
      .filter(Boolean),
  );
  if (selected.size === 0) selected = new Set([1]);
  process.stdout.write("\nChoose the providers to show in Codex:\n");
  for (;;) {
    process.stdout.write(`${renderProviderChoices(snapshots, selected, colorEnabled)}\n`);
    const raw = promptLine("Toggle numbers (comma-separated), a=all, n=none; Enter to continue");
    const result = toggleSelection(selected, raw, snapshots.length);
    selected = result.selected;
    if (result.error) {
      process.stdout.write(`${result.error}\n`);
    } else if (result.done) {
      break;
    }
  }
  return validateProviderIds(
    [...selected].sort((a, b) => a - b).map((position) => snapshots[position - 1].id),
  );
}

function requestedSelection() {
  const requested = option("--providers");
  if (requested) {
    if (requested === "configured") return defaultProviderIds();
    if (requested === "all") return [...PROVIDERS.keys()];
    return validateProviderIds(requested.split(","));
  }
  return guided ? guidedSelection() : defaultProviderIds();
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
  const session = cliSessionDescriptor(provider);
  if (!guided) {
    const setup =
      provider.kind === "oauth"
        ? "sign in with the provider's official CLI"
        : session
          ? `run \`${session.loginCommand}\` or \`./bin/provider-key ${provider.id} set\``
          : `run \`./bin/provider-key ${provider.id} set\``;
    throw incomplete(`${provider.displayName} is selected but not configured; ${setup} first.`);
  }
  if (provider.kind === "oauth") {
    let cli = oauthCliPath(provider.id);
    if (!cli) {
      if (!confirm(`Install the official ${provider.displayName} CLI with npm now?`)) {
        throw incomplete(
          `${provider.displayName} needs its official CLI; install it and run setup again.`,
        );
      }
      installOauthCli(provider.id);
      cli = oauthCliPath(provider.id);
    }
    if (!confirm(`Sign in to ${provider.displayName} now?`)) {
      throw incomplete(`${provider.displayName} sign-in was cancelled.`);
    }
    run(cli, oauthLoginArgs(provider.id));
    if (!providerConfigured(provider)) {
      throw incomplete(`${provider.displayName} sign-in did not produce a usable credential.`);
    }
  } else {
    if (provider.authMode === "anonymous") return;
    // A provider whose CLI mints its key in the browser gets that offer first,
    // because most people have an account long before they have a key. Saying
    // no falls through to the key prompt rather than failing the install.
    if (session && hasSignInCli(provider.id) && signInToProvider(provider)) return;
    const prompt = provider.credential?.prompt || `${provider.displayName} API key`;
    if (!confirm(`Enter ${prompt} securely now?`)) {
      throw incomplete(`${provider.displayName} setup was cancelled.`);
    }
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "provider-key.mjs"), provider.id, "set"]);
  }
}

// Returns true only when the sign-in actually produced a usable credential, so
// the caller can fall back to the API key path for every other outcome.
function signInToProvider(provider) {
  if (!confirm(`Sign in to ${provider.displayName} in your browser now?`)) return false;
  let cli = oauthCliPath(provider.id);
  if (!cli) {
    if (!confirm(`Install the official ${provider.displayName} CLI with npm now?`)) return false;
    installOauthCli(provider.id);
    cli = oauthCliPath(provider.id);
    if (!cli) return false;
  }
  run(cli, oauthLoginArgs(provider.id));
  return providerConfigured(provider);
}

// Best-effort: the router install has already succeeded, so a companion-app
// build failure warns and continues instead of failing the whole setup.
function installTray() {
  try {
    if (process.platform === "darwin") {
      try {
        execFileSync("xcrun", ["--find", "swift"], { stdio: "ignore" });
      } catch {
        process.stdout.write(
          "The Swift toolchain is missing; run `xcode-select --install`, then `./bin/model-router-tray` to add the companion later.\n",
        );
        return;
      }
      const bundleDir = trayBundleDir("darwin", os.homedir());
      run(path.join(SOURCE_ROOT, "scripts", "build-macos-tray-app.sh"), [bundleDir]);
      run("open", [bundleDir]);
      process.stdout.write(`Menu-bar companion installed at ${bundleDir} and opened.\n`);
    } else if (process.platform === "win32") {
      // Windows had no path through here at all: the tray was built by hand or
      // not at all, and nothing brought it back after a reboot. Registering the
      // logon task is what makes it stay, and it also starts the first
      // instance, so there is no separate launch step.
      run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(SOURCE_ROOT, "scripts", "build-desktop-tray.ps1"),
        "-BinaryOnly",
      ]);
      run(process.execPath, [path.join(SOURCE_ROOT, "src", "tray-service.mjs"), "install"]);
      process.stdout.write(
        "Desktop companion built, launched, and set to start at logon.\n" +
          "Windows 11 hides new tray icons: click the ^ chevron by the clock to find it, and drag it onto the taskbar to pin it.\n",
      );
    } else {
      run(path.join(SOURCE_ROOT, "bin", "model-router-tray"), []);
      process.stdout.write("Desktop companion built and launched.\n");
    }
  } catch (error) {
    process.stdout.write(
      `Desktop companion install did not finish: ${error instanceof Error ? error.message : String(error)}\n` +
        (process.platform === "darwin"
          ? "Recent macOS SDKs need the full Xcode app (not only the Command Line Tools) to build the menu-bar companion's SwiftUI macros.\n"
          : "") +
        (process.platform === "win32"
          ? "The Tauri companion needs Rust stable and Cargo on PATH.\n" +
            "The router itself is installed; retry later with .\\scripts\\build-desktop-tray.ps1 -BinaryOnly.\n"
          : "The router itself is installed; retry later with ./bin/model-router-tray.\n"),
    );
  }
}

async function main() {
  if (setupArgumentError) throw incomplete(setupArgumentError);
  const legacy = detectLegacyInstallations();
  if (
    legacy.unknownConflict &&
    !(adoptNativeCatalog && legacy.adoptableNativeCatalog)
  ) {
    throw incomplete(
      `An unknown model router owns ${legacy.config.modelCatalogJson}; automatic setup will not replace it.`,
    );
  }
  const stepTitles = ["Choose providers", "Connect credentials"];
  if (legacy.installations.length) stepTitles.push("Migrate older router");
  stepTitles.push("Review and install");
  let stepIndex = 0;
  const nextStep = (title) => {
    stepIndex += 1;
    if (guided) process.stdout.write(stepHeader(stepIndex, stepTitles.length, title));
  };

  nextStep("Choose providers");
  // A bad --providers value is a mistake in the invocation, not in the code
  // that was just pulled.
  let providers;
  try {
    providers = requestedSelection();
  } catch (error) {
    throw error?.setupExitCode
      ? error
      : incomplete(error instanceof Error ? error.message : String(error));
  }
  if (providers.length === 0) {
    throw incomplete(
      "No configured provider was found. Run `./bin/setup --guided` or pass `--providers` after configuring credentials.",
    );
  }
  nextStep("Connect credentials");
  // Credentials are addable after the install, and the router already reports
  // an unconfigured provider clearly at request time. A declined prompt -- or
  // a prompt that is itself broken, which is how a Windows key-entry bug took
  // whole installations down -- must not abort the install and hand the
  // checkout back to the rollback. Guided runs collect the gaps and report
  // them; scripted runs stay strict so automation still fails loudly.
  const pendingCredentials = [];
  for (const id of providers) {
    const provider = PROVIDERS.get(id);
    try {
      configureProvider(provider);
    } catch (error) {
      if (!guided) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      pendingCredentials.push({ provider, reason });
      process.stderr.write(`\nWarning: ${provider.displayName} was not configured (${reason})\n`);
    }
  }
  writeProviderSelection(providers);

  // Pasted images just work for text-only models: the bridge is on by default,
  // so the installer no longer writes anything here. It used to auto-enable
  // once when a vision-capable provider happened to be selected, which both
  // left the state file's mere presence meaning "the installer ran" and left
  // every other install needing a command nobody knew about. Reporting is all
  // that is left to do -- and only for an install that has not answered the
  // question itself, so a re-run never claims credit for a machine the operator
  // already configured.
  const visionBridge = visionBridgeConfigured()
    ? undefined
    : {
        enabled: readVisionBridgeSettings().enabled,
        engine:
          resolveVisionEngine(
            () => selectedConfiguredListedModels(),
            readVisionBridgeSettings(),
          )?.slug || null,
      };

  let migration;
  if (legacy.installations.length) {
    nextStep("Migrate older router");
    const approved = migrateKnown || (guided && confirm(
      `Safely migrate ${legacy.installations.map((item) => item.id).join(", ")} and keep a rollback snapshot?`,
    ));
    if (!approved) {
      throw incomplete("A recognized older router must be migrated before installation. Re-run with --migrate-known.");
    }
    migration = applyKnownMigrations();
  }

  if (selectionOnly) {
    process.stdout.write(`${JSON.stringify({ providers, migration }, null, 2)}\n`);
    return;
  }

  nextStep("Review and install");
  const dshTarget = TARGET === "dsh";
  if (guided) {
    process.stdout.write(
      `\nReady to install:\n` +
        `  Providers: ${providers.join(", ")}\n` +
        `  Migration: ${migration ? "recognized older router (rollback snapshot kept)" : "none needed"}\n` +
        (dshTarget
          ? `  Changes: per-user background service and one provider route in the harness settings document\n`
          : `  Native catalog: ${adoptNativeCatalog ? "adopt existing user catalog" : "capture from Codex"}\n` +
            `  Changes: per-user background service and the managed Codex config block\n`),
    );
    if (!confirm("Proceed?")) {
      throw incomplete("Setup was cancelled before installing the service.");
    }
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
        ...(adoptNativeCatalog ? ["-AdoptNativeCatalog"] : []),
      ]);
    } else {
      run(
        path.join(SOURCE_ROOT, "bin", "install"),
        adoptNativeCatalog ? ["--adopt-native-catalog"] : [],
      );
    }
  } catch (error) {
    if (migration?.migrated) rollbackLatestMigration();
    throw error;
  }

  const trayStep = trayDecision({ platform: process.platform, withTray, noTray, guided });
  if (trayStep !== "skip") {
    const wanted =
      trayStep === "install" ||
      confirm("Install the desktop companion app (menu-bar usage meters and provider switcher)?");
    if (wanted) installTray();
  }

  if (runSmoke || (guided && confirm("Run one small live request per enabled provider?", false))) {
    run(process.execPath, [path.join(SOURCE_ROOT, "src", "smoke-test.mjs"), "--yes"]);
  }
  run(process.execPath, [path.join(SOURCE_ROOT, "src", "doctor.mjs")]);
  process.stdout.write(
    dshTarget
      ? `\nDeepSeek Harness is ready with: ${providers.join(", ")}\n` +
        `It reloads its settings document on the next request, so there is nothing to restart.\n`
      : `\nCodex Router is ready with: ${providers.join(", ")}\nFully quit Codex, reopen it, and start a new task.\n`,
  );
  if (visionBridge?.enabled && visionBridge.engine) {
    process.stdout.write(
      `\nVision: text-only models can now read pasted images, via ${visionBridge.engine}.\n` +
        `  It spends that provider's quota. Turn it off with: ./bin/control vision-bridge off\n`,
    );
  } else if (visionBridge?.enabled) {
    process.stdout.write(
      `\nVision: no enabled provider offers a model that reads images.\n` +
        `  Signed in to ChatGPT? Codex's own vision model will read them, on the plan you already pay for.\n` +
        `  Otherwise, free local option: ./bin/control vision-bridge setup   (uses a small local model)\n`,
    );
  }
  if (pendingCredentials.length) {
    process.stdout.write(
      `\nStill needs a credential:\n` +
        pendingCredentials
          .map(({ provider }) => {
            if (provider.kind === "oauth") {
              return `  ${provider.displayName}: sign in with the provider's official CLI\n`;
            }
            const session = cliSessionDescriptor(provider);
            const key = `./bin/provider-key ${provider.id} set`;
            return session
              ? `  ${provider.displayName}: ${session.loginCommand}, or ${key}\n`
              : `  ${provider.displayName}: ${key}\n`;
          })
          .join("") +
        `These providers stay selected and start working as soon as a key is stored.\n`,
    );
  }
}

main().catch((error) => {
  console.error(`codex-router setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error?.setupExitCode || 1);
});
