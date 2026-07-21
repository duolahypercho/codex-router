import path from "node:path";

import { PROVIDERS } from "./model-registry.mjs";
import { SOURCE_ROOT, TARGET } from "./paths.mjs";
import { writeProviderSelection } from "./provider-selection.mjs";
import {
  configureProvider,
  confirm,
  parseSetupArgs,
  run,
  selectProviders,
} from "./setup-shared.mjs";

if (TARGET !== "claude") {
  throw new Error("claude-setup.mjs requires MODEL_ROUTER_TARGET=claude.");
}

const args = process.argv.slice(2);
const { guided, runSmoke, selectionOnly, help, providers: requested, argumentError } =
  parseSetupArgs(args);

if (help) {
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

const providerKeyCommand = (id) => `./bin/model-router claude provider-key ${id} set`;

async function main() {
  if (argumentError) throw new Error(argumentError);
  const providers = selectProviders({ requested, guided, appName: "Claude Desktop" });
  if (providers.length === 0) {
    throw new Error(
      "No configured provider was found. Run Claude setup with --guided or configure a provider key first.",
    );
  }
  for (const id of providers) {
    configureProvider(PROVIDERS.get(id), { guided, providerKeyCommand });
  }
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
