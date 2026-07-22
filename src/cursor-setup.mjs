import { readFileSync } from "node:fs";
import path from "node:path";

import { PROVIDERS } from "./model-registry.mjs";
import { CALLER_SECRET_PATH, PORTS, SOURCE_ROOT, TARGET, loopback } from "./paths.mjs";
import { selectedListedModels, writeProviderSelection } from "./provider-selection.mjs";
import {
  configureProvider,
  parseSetupArgs,
  run,
  selectProviders,
} from "./setup-shared.mjs";

if (TARGET !== "cursor") {
  throw new Error("cursor-setup.mjs requires MODEL_ROUTER_TARGET=cursor.");
}

const args = process.argv.slice(2);
const { guided, selectionOnly, help, providers: requested, argumentError } = parseSetupArgs(args);

if (help) {
  process.stdout.write(`Usage: model-router cursor setup [options]

Configure a local OpenAI-compatible gateway for Cursor. Cursor's own settings
are never edited; setup prints the values to paste into Cursor -> Settings ->
Models.

Options:
  --guided             Ask provider and authentication questions interactively
  --auto               Use already configured credentials (default)
  --providers LIST     Comma-separated provider ids
  --selection-only     Save provider selection without installing (development)
  --help               Show this help

Providers: ${[...PROVIDERS.keys()].join(", ")}
`);
  process.exit(0);
}

const providerKeyCommand = (id) => `./bin/model-router cursor provider-key ${id} set`;

// The user must paste these into Cursor; the caller key is a local capability
// shown only in the user's own terminal, never uploaded.
function printCursorInstructions(providers) {
  const baseUrl = loopback(PORTS.router, "/v1");
  const callerKey = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
  const models = selectedListedModels().map((model) => model.gatewayModel);
  process.stdout.write(
    `\nCursor Router is ready with: ${providers.join(", ")}\n\n` +
      "In Cursor -> Settings -> Models, add a custom OpenAI provider:\n" +
      `  Override OpenAI Base URL:  ${baseUrl}\n` +
      `  OpenAI API Key:            ${callerKey}\n` +
      "  Add Model (use these exact ids):\n" +
      models.map((id) => `    - ${id}`).join("\n") +
      "\n\nYour existing Cursor models, subscription, and settings are untouched.\n" +
      "Fully quit and reopen Cursor so it reloads the model list.\n",
  );
}

async function main() {
  if (argumentError) throw new Error(argumentError);
  const providers = selectProviders({ requested, guided, appName: "Cursor" });
  if (providers.length === 0) {
    throw new Error(
      "No configured provider was found. Run Cursor setup with --guided or configure a provider key first.",
    );
  }
  for (const id of providers) {
    configureProvider(PROVIDERS.get(id), { guided, providerKeyCommand });
  }
  writeProviderSelection(providers);

  if (selectionOnly) {
    process.stdout.write(`${JSON.stringify({ target: "cursor", providers }, null, 2)}\n`);
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
      "cursor",
    ]);
  } else {
    run(path.join(SOURCE_ROOT, "bin", "install"), []);
  }

  run(process.execPath, [path.join(SOURCE_ROOT, "src", "cursor-doctor.mjs")]);
  printCursorInstructions(providers);
}

main().catch((error) => {
  console.error(`cursor-router setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
